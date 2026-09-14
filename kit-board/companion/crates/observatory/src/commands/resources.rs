//! `resources`: the named knowledge sources (vaults) this install classifies
//! tool invocations against. Roots, labels, and connector ids live in
//! `companion.json` and are printed here, on this machine, so the operator can
//! see what each key covers; the Observatory receives keys, access kinds, and a
//! configuration token only. `add` and `remove` edit the file in place.

use std::path::Path;
use std::process::ExitCode;

use observatory_core::config::{CompanionConfig, LocalResource};
use observatory_core::resources::{
    RESOURCE_ATTRIBUTION_DENY, ResourceConfiguration, resource_attribution_denied,
};
use observatory_core::run::configured_resources;
use observatory_core::state::{SCHEMA_VERSION, State};
use serde_json::{Value, json};

use super::{CommandError, CommandResult, print_json};
use crate::cli::{ResourceAddArgs, ResourceRemoveArgs, ResourcesAction, ResourcesArgs};

/// Printed whenever a source is added: access rows hang off tool invocations,
/// which leave the machine only at the fullest detail level.
pub const UPLOAD_NOTE: &str = "resource-access rows upload only while execution.detail_level is requests_with_tools; roots, labels, and connector ids never leave this machine";

pub fn resources(dir: &Path, args: ResourcesArgs) -> CommandResult {
    match args.action {
        None => list(dir),
        Some(ResourcesAction::Add(args)) => add(dir, args),
        Some(ResourcesAction::Remove(args)) => remove(dir, args),
    }
}

/// What `LocalResource::validate` checks plus what the classifier needs: every
/// root absolute, so a match never depends on the directory a run started in.
/// The message names the root by position, never by path.
pub fn check_resource(resource: &LocalResource) -> Result<(), CommandError> {
    resource.validate().map_err(CommandError::Invalid)
}

/// The listing shape shared by `resources` and `resources add`.
fn resource_json(resource: &LocalResource) -> Value {
    json!({
        "key": resource.key,
        "label": resource.label,
        "source": resource.source,
        "roots": resource.roots.iter().map(|root| root.to_string_lossy()).collect::<Vec<_>>(),
        "roots_present": resource.roots.iter().filter(|root| root.is_dir()).count(),
        "connectors": resource.connectors,
        "problem": check_resource(resource).err().map(|error| error.to_string()),
    })
}

/// The `cfg:<token>` a key's rows carry, once a run has assigned one; `null`
/// until then. Read only, so the listing never mints a token.
fn configuration_version(
    state: Option<&State>,
    configuration: &ResourceConfiguration,
    key: &str,
) -> Result<Option<String>, CommandError> {
    let Some(state) = state else { return Ok(None) };
    let Some(digest) = configuration.resource_version(key) else { return Ok(None) };
    Ok(state.assigned_resource_config_token(&digest)?.map(|token| format!("cfg:{token}")))
}

/// Local evidence for one binding: access rows per key, kind, and basis, and
/// inspections per class. Counts only; keys are the only identities printed.
fn binding_evidence(state: &State, binding_id: &str) -> Result<Value, CommandError> {
    let accesses: Vec<Value> = state
        .resource_access_counts(binding_id)?
        .into_iter()
        .map(|count| {
            json!({ "resource_key": count.resource_key, "access_kind": count.access_kind,
                "evidence_basis": count.evidence_basis, "rows": count.rows })
        })
        .collect();
    let counts = state.resource_inspection_counts(binding_id)?;
    Ok(json!({
        "accesses": accesses,
        "inspections": {
            "inspected": counts.inspected(),
            "matched": counts.matched,
            "unmatched": counts.unmatched,
            "no_evidence": counts.no_evidence,
            "unresolved": counts.unresolved,
            "unsupported": counts.unsupported,
            "ambiguous": counts.ambiguous,
            "overlapping": counts.overlapping,
        },
    }))
}

/// Every configured source with its local roots (present or not: a missing
/// directory is a warning, not a drop), the local deny state, and per binding
/// the counts the state holds. The state is opened read-only and only when a
/// run has created it; nothing here writes.
fn list(dir: &Path) -> CommandResult {
    let config = CompanionConfig::load(dir)?;
    let (configuration, _) = configured_resources(&config);
    let state_path = config.state_path(dir);
    // Read-only, so a state file an older companion wrote is reported as pending
    // rather than migrated here; the next `run` upgrades it.
    let mut state_migration_pending = false;
    let state = if state_path.is_file() {
        let opened = State::open_read_only(&state_path)?;
        if opened.meta("schema_version")?.as_deref() == Some(SCHEMA_VERSION) {
            Some(opened)
        } else {
            state_migration_pending = true;
            None
        }
    } else {
        None
    };
    let mut resources = Vec::new();
    for resource in &config.resources {
        let mut entry = resource_json(resource);
        entry["configuration_version"] =
            json!(configuration_version(state.as_ref(), &configuration, &resource.key)?);
        resources.push(entry);
    }
    let mut bindings = Vec::new();
    for binding in &config.bindings {
        let evidence = match &state {
            Some(state) => binding_evidence(state, &binding.binding_id.to_string())?,
            None => json!({ "accesses": Value::Null, "inspections": Value::Null }),
        };
        bindings.push(json!({ "binding_id": binding.binding_id, "account_id": binding.account_id,
            "provider": binding.provider, "accesses": evidence["accesses"],
            "inspections": evidence["inspections"] }));
    }
    print_json(&json!({
        "ok": true,
        "resources": resources,
        "resource_attribution_denied": resource_attribution_denied(&config.deny),
        "deny_entry": RESOURCE_ATTRIBUTION_DENY,
        "upload": UPLOAD_NOTE,
        "state_present": state.is_some(),
        "state_migration_pending": state_migration_pending,
        "bindings": bindings,
    }));
    Ok(ExitCode::SUCCESS)
}

/// Adds a source or replaces the one with the same key, after validation; the
/// next run replays retained transcripts under the new configuration.
fn add(dir: &Path, args: ResourceAddArgs) -> CommandResult {
    let mut config = CompanionConfig::load(dir)?;
    let trimmed = |value: Option<String>| value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    let resource = LocalResource {
        key: args.key.trim().to_owned(),
        label: trimmed(args.label),
        roots: args.root,
        connectors: args.connector.iter().map(|connector| connector.trim().to_owned()).collect(),
        source: trimmed(args.source),
    };
    check_resource(&resource)?;
    let action = if config.resource(&resource.key).is_some() { "replaced" } else { "added" };
    config.upsert_resource(resource.clone());
    config.save(dir)?;
    print_json(&json!({
        "ok": true,
        "action": action,
        "resource": resource_json(&resource),
        "resource_attribution_denied": resource_attribution_denied(&config.deny),
        "note": UPLOAD_NOTE,
        "next": "the next run replays retained transcripts under the new configuration",
    }));
    Ok(ExitCode::SUCCESS)
}

/// Removes a source by key. Future runs stop uploading rows for it; rows the
/// Observatory already holds are append-only and stay.
fn remove(dir: &Path, args: ResourceRemoveArgs) -> CommandResult {
    let mut config = CompanionConfig::load(dir)?;
    let key = args.key.trim();
    if !config.remove_resource(key) {
        return Err(CommandError::Invalid(format!("no knowledge source with key {key:?} is configured")));
    }
    config.save(dir)?;
    print_json(&json!({
        "ok": true,
        "action": "removed",
        "key": key,
        "note": "future runs stop uploading rows for this key; rows the Observatory already holds are not retracted",
    }));
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use observatory_contract::{Lit, Uuid};
    use observatory_core::config::Secret;

    use super::*;

    fn connected(dir: &Path) -> CompanionConfig {
        let config = CompanionConfig {
            schema_version: Lit,
            url: "https://example.test".into(),
            install_id: Uuid::v4(),
            key: Secret::new("k".repeat(43)),
            machine_label: "mac".into(),
            since: None,
            bindings: Vec::new(),
            deny: Vec::new(),
            resources: Vec::new(),
            claude_statusline_inbox: None,
        };
        config.save(dir).unwrap();
        config
    }

    fn resource(key: &str, roots: Vec<PathBuf>) -> LocalResource {
        LocalResource { key: key.into(), label: None, roots, connectors: Vec::new(), source: None }
    }

    #[test]
    fn roots_must_be_absolute_and_keys_must_be_codes() {
        let absolute = tempfile::tempdir().unwrap();
        assert!(check_resource(&resource("obsidian.notes", vec![absolute.path().to_path_buf()])).is_ok());
        let relative = check_resource(&resource(
            "obsidian.notes",
            vec![absolute.path().to_path_buf(), PathBuf::from("vault")],
        ))
        .unwrap_err();
        assert_eq!(
            relative.to_string(),
            "resource \"obsidian.notes\" root 2 must be an absolute path or start with ~/"
        );
        assert!(check_resource(&resource("Bad Key", vec![absolute.path().to_path_buf()])).is_err());
        assert!(check_resource(&resource("obsidian.notes", vec![])).is_err());
        let connector_only = LocalResource { connectors: vec!["mcp:vault".into()], ..resource("k", vec![]) };
        assert!(check_resource(&connector_only).is_ok());
    }

    #[test]
    fn add_replaces_and_remove_errors_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        connected(dir.path());
        let add_args = |key: &str, roots: Vec<PathBuf>| ResourceAddArgs {
            key: key.into(),
            root: roots,
            connector: vec![],
            label: Some(" Notes ".into()),
            source: Some("obsidian:0123456789abcdef".into()),
        };
        assert!(add(dir.path(), add_args("obsidian.notes", vec![vault.path().to_path_buf()])).is_ok());
        let saved = CompanionConfig::load(dir.path()).unwrap();
        assert_eq!(saved.resources.len(), 1);
        assert_eq!(saved.resources[0].key, "obsidian.notes");
        assert_eq!(saved.resources[0].label.as_deref(), Some("Notes"));
        assert_eq!(saved.resources[0].roots, vec![vault.path().to_path_buf()]);
        assert_eq!(saved.resources[0].source.as_deref(), Some("obsidian:0123456789abcdef"));

        // A relative root is refused before anything is written.
        let refused = add(dir.path(), add_args("obsidian.other", vec![PathBuf::from("relative")]));
        assert!(matches!(refused, Err(CommandError::Invalid(_))));
        assert_eq!(CompanionConfig::load(dir.path()).unwrap().resources.len(), 1);

        // The same key replaces the definition instead of duplicating it.
        let other = tempfile::tempdir().unwrap();
        assert!(add(dir.path(), add_args("obsidian.notes", vec![other.path().to_path_buf()])).is_ok());
        let saved = CompanionConfig::load(dir.path()).unwrap();
        assert_eq!(saved.resources.len(), 1);
        assert_eq!(saved.resources[0].roots, vec![other.path().to_path_buf()]);

        assert!(list(dir.path()).is_ok());
        assert!(remove(dir.path(), ResourceRemoveArgs { key: "obsidian.notes".into() }).is_ok());
        assert!(CompanionConfig::load(dir.path()).unwrap().resources.is_empty());
        let missing = remove(dir.path(), ResourceRemoveArgs { key: "obsidian.notes".into() });
        assert!(matches!(missing, Err(CommandError::Invalid(_))));
    }
}
