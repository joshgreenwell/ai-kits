use std::path::Path;
use std::process::ExitCode;

use observatory_adapters::readings::{HookStatus, hook_status};
use observatory_contract::settings::DetailLevel;
use observatory_core::adapter::Preflight;
use observatory_core::config::LocalResource;
use observatory_core::credentials::CredentialPresence;
use observatory_core::discovery::discover;
use observatory_core::effective::effective;
use observatory_core::inbox::read_statusline_status;
use observatory_core::resources::resource_attribution_denied;
use observatory_core::run::{ConfigSource, RunOptions, prepare, schedule_summary};
use observatory_core::service;
use observatory_core::state::State;
use serde_json::{Value, json};

use super::{CommandResult, print_json};
use crate::cli::DoctorArgs;

/// Why knowledge-source rows would or would not leave this machine, in the
/// order the adapters' `resource` capability reports it: the detail level
/// first, then the local deny, then whether any valid source is configured.
fn resource_attribution_reason(
    detail_level: DetailLevel,
    deny: &[String],
    resources: &[LocalResource],
) -> &'static str {
    if detail_level != DetailLevel::RequestsWithTools {
        "detail_level"
    } else if resource_attribution_denied(deny) {
        "denied_locally"
    } else if !resources.iter().any(|resource| resource.validate().is_ok()) {
        "no_resources"
    } else {
        "ok"
    }
}

/// The Claude statusline reader as `doctor` shows it: whether the hook in the
/// Claude settings file names this configuration directory (or which other one),
/// whether the sidecar shows it executing, and what the run holds in quarantine.
/// Directories only; never a transcript path or a sample.
fn statusline_report(ctx: &observatory_core::adapter::RunContext) -> Value {
    let hook = hook_status(&ctx.claude_settings_path, &ctx.config_dir);
    let hook_config_dir = match &hook {
        HookStatus::Installed => Some(ctx.config_dir.to_string_lossy().into_owned()),
        HookStatus::ConfigDirMismatch { config_dir } => Some(config_dir.clone()),
        HookStatus::NotInstalled => None,
    };
    let sidecar = read_statusline_status(&ctx.statusline_inbox);
    let quarantined = State::open_read_only(&ctx.state_path)
        .and_then(|state| state.quarantine_counts())
        .unwrap_or_default();
    json!({
        "hook": hook.as_str(),
        "hook_config_dir": hook_config_dir,
        "sidecar_present": sidecar.is_some(),
        "last_invocation_at": sidecar.as_ref().and_then(|s| s.last_invocation_at.clone()),
        "invocations": sidecar.as_ref().map(|s| s.invocations),
        "offered_windows_ever": sidecar.as_ref().and_then(|s| s.offered_windows_ever.clone()),
        "last_published_at": sidecar.as_ref().and_then(|s| s.last_published_at.clone()),
        "quarantined": quarantined,
    })
}

/// Side records the server deferred (it could not apply them yet), counted per
/// record type, beside what the last run's side-record build reported.
fn side_record_report(ctx: &observatory_core::adapter::RunContext) -> Value {
    let Ok(state) = State::open_read_only(&ctx.state_path) else { return Value::Null };
    let deferred = state.deferred_counts().unwrap_or_default();
    let last = state
        .last_run()
        .ok()
        .flatten()
        .and_then(|row| serde_json::from_str::<Value>(&row.summary).ok())
        .map(|summary| summary["side_records"].clone())
        .unwrap_or(Value::Null);
    json!({ "deferred": deferred, "last_run": last })
}

/// Effective mode and reason per adapter; prerequisite and credential checks
/// reported as coverage states. Prints booleans and codes, never a token or a
/// path outside the configuration directory. `--offline` reads the cached
/// config document instead of fetching it, like `run --offline`.
pub fn doctor(dir: &Path, args: DoctorArgs) -> CommandResult {
    let options = RunOptions { dry_run: true, fetch_config: !args.offline, ..RunOptions::default() };
    let prepared = prepare(dir, &options, false)?;
    let ctx = &prepared.ctx;
    let adapters = observatory_adapters::adapters();
    let mut rows = Vec::new();
    for adapter in &adapters {
        let id = adapter.id();
        let decided = effective(id, &ctx.settings, &ctx.deny, &ctx.bindings);
        let (state, detail, stage) = if decided.runs {
            match adapter.preflight(ctx) {
                Preflight::Ready => ("ok".to_owned(), None, "ready"),
                Preflight::Blocked { state, detail } => {
                    (state.to_string(), Some(detail.to_string()), "preflight")
                }
            }
        } else {
            (decided.state.to_string(), decided.detail.map(|d| d.to_string()), "settings")
        };
        rows.push(json!({
            "adapter": id, "state": state, "detail": detail, "decided_by": stage,
            "mode": decided.mode_path, "parser_version": adapter.parser_version(),
        }));
    }
    let found = discover();
    let credential = match found.claude.credentials {
        CredentialPresence::Present { .. } => "present",
        CredentialPresence::Expired => "expired",
        CredentialPresence::Missing => "missing",
        CredentialPresence::Unknown => "unknown",
    };
    let bindings: Vec<_> = ctx
        .bindings
        .iter()
        .map(|b| {
            json!({ "binding_id": b.binding_id, "account_id": b.account_id, "provider": b.provider,
                "enabled": b.enabled, "identity": format!("{:?}", b.identity).to_lowercase(),
                "roots_present": b.roots.iter().filter(|r| r.is_dir()).count(), "roots": b.roots.len() })
        })
        .collect();
    let resources = &prepared.config.resources;
    let attribution_reason =
        resource_attribution_reason(ctx.settings.execution.detail_level, &ctx.deny, resources);
    print_json(&json!({
        "ok": true,
        "version": observatory_core::VERSION,
        "tls_roots": observatory_core::http::TLS_ROOTS_LABEL,
        "config_dir": dir.to_string_lossy(),
        "config_dir_virtualized": observatory_core::paths::virtualized_store(dir),
        "config": prepared.config_source,
        "config_error": prepared.config_error,
        "settings_version": ctx.settings_version,
        "since": ctx.since_text,
        "paused": ctx.settings.paused,
        "cadence_minutes": ctx.settings.cadence_minutes.get(),
        "schedule": schedule_summary(dir, &prepared.config.install_id,
            (prepared.config_source != ConfigSource::Defaults).then(|| ctx.settings.cadence_minutes.get())),
        "latest_version": ctx.document.as_ref().and_then(|d| d.companion.latest_version.as_ref().map(|v| v.as_str().to_owned())),
        "deny": ctx.deny,
        "resources_configured": resources.len(),
        "resources_invalid": resources.iter().filter(|resource| resource.validate().is_err()).count(),
        "obsidian_config_found": found.obsidian.present,
        "resource_attribution_effective": attribution_reason == "ok",
        "resource_attribution_reason": attribution_reason,
        "discovered": {
            "claude": { "present": found.claude.present, "credential": credential, "signed_in": found.claude.identity.is_some() },
            "codex": { "present": found.codex.present, "executable": found.codex.executable.is_some(), "signed_in": found.codex.identity.is_some() },
            "cursor": { "present": found.cursor.present },
            "obsidian": { "present": found.obsidian.present, "vaults": found.obsidian.vaults.len() },
        },
        "bindings": bindings,
        "adapters": rows,
        "claude_statusline": statusline_report(ctx),
        "side_records": side_record_report(ctx),
        "schedule": service::status(&prepared.config.install_id).ok(),
        "v1_schedules": service::v1_schedules(),
    }));
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(key: &str) -> LocalResource {
        let root = std::env::temp_dir().join("synthetic").join("vault");
        LocalResource {
            key: key.into(),
            label: None,
            roots: vec![root],
            connectors: Vec::new(),
            source: None,
        }
    }

    #[test]
    fn attribution_reason_follows_the_capability_precedence() {
        let deny = vec!["execution.resource_attribution".to_owned()];
        let sources = vec![source("obsidian.notes")];
        assert_eq!(resource_attribution_reason(DetailLevel::BucketsOnly, &[], &sources), "detail_level");
        assert_eq!(resource_attribution_reason(DetailLevel::Requests, &deny, &sources), "detail_level");
        assert_eq!(
            resource_attribution_reason(DetailLevel::RequestsWithTools, &deny, &sources),
            "denied_locally"
        );
        assert_eq!(resource_attribution_reason(DetailLevel::RequestsWithTools, &deny, &[]), "denied_locally");
        assert_eq!(resource_attribution_reason(DetailLevel::RequestsWithTools, &[], &[]), "no_resources");
        // An invalid definition is skipped by the run, so it does not count as configured.
        let invalid = vec![LocalResource { roots: vec![], ..source("obsidian.notes") }];
        assert_eq!(
            resource_attribution_reason(DetailLevel::RequestsWithTools, &[], &invalid),
            "no_resources"
        );
        assert_eq!(resource_attribution_reason(DetailLevel::RequestsWithTools, &[], &sources), "ok");
    }
}
