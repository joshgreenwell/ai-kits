//! `setup`: discovers installed products and stores, reads each signed-in
//! identity for display, proposes bindings, offers each Obsidian vault as a
//! knowledge source, asks one question each for the private-interface readers,
//! the statusline hook, and the schedule, writes bindings and this install's
//! settings override, runs a dry run, a first publish, and `service install`,
//! and offers to uninstall a v1 schedule.

use std::fs;
use std::path::Path;
use std::process::ExitCode;
use std::str::FromStr;

use jiff::Timestamp;
use observatory_contract::settings::{
    AllowanceSettings, ClaudeReader, CursorReader, HookSettings, ProviderSwitches,
};
use observatory_contract::{AccountId, BindingRequest, InstallOverride, Nullable, Provider, Text};
use observatory_core::config::{CompanionConfig, LocalBinding, LocalResource, Secrets};
use observatory_core::discovery::{Discovered, DisplayIdentity, ObsidianVault, discover};
use observatory_core::http::Client;
use observatory_core::paths::{claude_settings_file, write_private};
use observatory_core::run::{RunOptions, run as run_cycle};
use observatory_core::service;
use serde_json::{Value, json};

use super::{CommandError, CommandResult, print_json};
use crate::cli::SetupArgs;
use crate::prompt::Prompt;

fn parse_binds(args: &[String]) -> Result<Vec<(Provider, AccountId)>, CommandError> {
    args.iter()
        .map(|entry| {
            let (provider, account) = entry.split_once('=').ok_or_else(|| {
                CommandError::Invalid(format!("--bind expects PROVIDER=ACCOUNT, got {entry:?}"))
            })?;
            let provider = Provider::from_str(provider.trim())
                .map_err(|_| CommandError::Invalid(format!("unknown provider {provider:?}")))?;
            let account = AccountId::from_str(account.trim()).map_err(|_| {
                CommandError::Invalid(format!(
                    "account ids match ^[a-z0-9][a-z0-9-]{{1,79}}$, got {account:?}"
                ))
            })?;
            Ok((provider, account))
        })
        .collect()
}

struct Proposal {
    provider: Provider,
    account_id: AccountId,
    label: String,
    identity: Option<DisplayIdentity>,
}

fn proposals(found: &Discovered, binds: &[(Provider, AccountId)], config: &CompanionConfig) -> Vec<Proposal> {
    let mut out = Vec::new();
    let chosen = |provider: Provider| -> Option<AccountId> {
        binds
            .iter()
            .find(|(p, _)| *p == provider)
            .map(|(_, a)| a.clone())
            .or_else(|| config.bindings_for(provider).next().map(|b| b.account_id.clone()))
    };
    let default = |provider: Provider| AccountId::from_str(&format!("{provider}-primary")).ok();
    if found.claude.present
        && let Some(account_id) = chosen(Provider::Claude).or_else(|| default(Provider::Claude))
    {
        let label = found
            .claude
            .identity
            .as_ref()
            .map(|i| i.label.clone())
            .unwrap_or_else(|| "Claude Code".to_owned());
        out.push(Proposal {
            provider: Provider::Claude,
            account_id,
            label,
            identity: found.claude.identity.clone(),
        });
    }
    if found.codex.present
        && let Some(account_id) = chosen(Provider::Codex).or_else(|| default(Provider::Codex))
    {
        let label =
            found.codex.identity.as_ref().map(|i| i.label.clone()).unwrap_or_else(|| "Codex CLI".to_owned());
        out.push(Proposal {
            provider: Provider::Codex,
            account_id,
            label,
            identity: found.codex.identity.clone(),
        });
    }
    if found.cursor.present
        && let Some(account_id) = chosen(Provider::Cursor).or_else(|| default(Provider::Cursor))
    {
        out.push(Proposal {
            provider: Provider::Cursor,
            account_id,
            label: "Cursor".to_owned(),
            identity: None,
        });
    }
    out
}

/// The default key for a discovered vault: Obsidian's own id, which fits the
/// `Code` pattern and does not name the folder.
fn vault_key(vault: &ObsidianVault) -> String {
    format!("obsidian.{}", vault.id)
}

/// The informational `source` recorded with a vault's definition.
fn vault_source(vault: &ObsidianVault) -> String {
    format!("obsidian:{}", vault.id)
}

/// The discovered vaults not configured yet, by source id or by default key:
/// a vault the operator renamed keeps its `source`, one added by hand with the
/// default key has no `source`.
fn unconfigured_vaults<'a>(config: &CompanionConfig, vaults: &'a [ObsidianVault]) -> Vec<&'a ObsidianVault> {
    vaults
        .iter()
        .filter(|vault| {
            let source = vault_source(vault);
            config.resource(&vault_key(vault)).is_none()
                && !config
                    .resources
                    .iter()
                    .any(|resource| resource.source.as_deref() == Some(source.as_str()))
        })
        .collect()
}

/// Offers each unconfigured Obsidian vault as a knowledge source: default key
/// `obsidian.<vault id>`, the folder name only in the local label, the vault
/// folder as the single root. The question defaults to no, and under `--yes`
/// the block is skipped altogether (a source is an opt-in whose roots the
/// operator should have seen), so `setup --yes` never adds one. Returns whether
/// the configuration changed.
fn propose_resources(config: &mut CompanionConfig, vaults: &[ObsidianVault], prompt: &Prompt) -> bool {
    let candidates = unconfigured_vaults(config, vaults);
    if candidates.is_empty() {
        return false;
    }
    if prompt.assume_yes {
        let named: Vec<String> =
            candidates.iter().map(|vault| format!("{} ({})", vault.name, vault_key(vault))).collect();
        println!(
            "  Obsidian vaults not tracked as knowledge sources: {}; add one with `observatory resources add --key <key> --root <vault folder>`",
            named.join(", ")
        );
        return false;
    }
    let mut changed = false;
    for vault in candidates {
        let default_key = vault_key(vault);
        let question = format!("Track Obsidian vault '{}' as knowledge source '{default_key}'?", vault.name);
        if !prompt.confirm(&question, false) {
            continue;
        }
        let key = prompt.text("  Source key", &default_key);
        let resource = LocalResource {
            key: key.trim().to_owned(),
            label: Some(vault.name.clone()),
            roots: vec![vault.path.clone()],
            connectors: Vec::new(),
            source: Some(vault_source(vault)),
        };
        if let Err(error) = super::resources::check_resource(&resource) {
            println!("  not added: {error}");
            continue;
        }
        println!("  tracking '{}' as '{}'; {}", vault.name, resource.key, super::resources::UPLOAD_NOTE);
        config.upsert_resource(resource);
        changed = true;
    }
    changed
}

/// Points Claude Code's statusline at `observatory statusline` (in the profile's
/// settings file when `CLAUDE_CONFIG_DIR` is set), preserving an existing custom
/// command as a passthrough and backing the file up first.
fn install_statusline_hook(dir: &Path) -> Result<Option<String>, CommandError> {
    let Some(path) = claude_settings_file() else { return Ok(None) };
    let exe = std::env::current_exe()
        .map_err(|_| CommandError::Invalid("the companion executable path is unavailable".into()))?;
    let mut settings: Value = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| CommandError::Invalid("~/.claude/settings.json is not valid JSON".into()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(error) => return Err(error.into()),
    };
    let ours = format!("\"{}\" --config-dir \"{}\" statusline", exe.to_string_lossy(), dir.to_string_lossy());
    let existing =
        settings.get("statusLine").and_then(|s| s.get("command")).and_then(Value::as_str).map(str::to_owned);
    let mut preserved = None;
    if let Some(existing) = existing
        && !existing.contains("observatory")
        && !existing.contains("statusline.py")
    {
        write_private(&dir.join("claude-statusline-passthrough.txt"), existing.as_bytes())?;
        preserved = Some(existing);
    }
    if path.exists() {
        let stamp = Timestamp::now().as_second();
        let backup = dir.join("backups").join(format!("claude-settings.{stamp}.json"));
        write_private(&backup, &fs::read(&path)?)?;
    }
    if let Value::Object(map) = &mut settings {
        map.insert("statusLine".into(), json!({ "type": "command", "command": ours, "padding": 0 }));
    }
    let text = serde_json::to_vec_pretty(&settings).map_err(|_| CommandError::Invalid("serialize".into()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, text)?;
    Ok(preserved)
}

pub fn setup(dir: &Path, args: SetupArgs) -> CommandResult {
    super::refuse_virtualized(dir)?;
    let mut config = CompanionConfig::load(dir)?;
    let prompt = Prompt::new(args.yes);
    let binds = parse_binds(&args.bind)?;
    let client = Client::new(&config.url, Some(config.key.clone()))?;

    println!("Discovering installed products…");
    let found = discover();
    println!(
        "  Claude Code: {}{}",
        if found.claude.present { "transcripts found" } else { "not found" },
        found.claude.identity.as_ref().map(|i| format!(", signed in as {}", i.label)).unwrap_or_default()
    );
    println!(
        "  Codex CLI: {}{}{}",
        if found.codex.present { "sessions found" } else { "not found" },
        if found.codex.executable.is_some() { ", executable on PATH" } else { "" },
        found.codex.identity.as_ref().map(|i| format!(", signed in ({})", i.label)).unwrap_or_default()
    );
    println!("  Cursor: {}", if found.cursor.present { "state found" } else { "not found" });
    println!(
        "  Obsidian: {}",
        if found.obsidian.present {
            format!("{} vault(s) registered", found.obsidian.vaults.len())
        } else {
            "not found".to_owned()
        }
    );

    // Bindings.
    let mut bound: Vec<Provider> = Vec::new();
    for proposal in proposals(&found, &binds, &config) {
        let question =
            format!("Bind {} ({}) as account '{}'?", proposal.provider, proposal.label, proposal.account_id);
        if !prompt.confirm(&question, true) {
            continue;
        }
        let account_id = if args.yes || binds.iter().any(|(p, _)| *p == proposal.provider) {
            proposal.account_id.clone()
        } else {
            let answer = prompt.text("  Account id", proposal.account_id.as_str());
            AccountId::from_str(&answer).map_err(|_| CommandError::Invalid("invalid account id".into()))?
        };
        let request = BindingRequest {
            account_id: account_id.clone(),
            provider: proposal.provider,
            account_label: Text::truncated(&proposal.label)
                .unwrap_or_else(|_| Text::truncated("account").unwrap_or_else(|_| unreachable!())),
            identity_hash: Nullable(proposal.identity.as_ref().map(|i| i.evidence_hash.clone())),
        };
        let response = client.create_binding(&request)?;
        config.upsert_binding(LocalBinding {
            binding_id: response.binding_id.clone(),
            account_id: response.account_id.clone(),
            provider: response.provider,
            roots: config.binding(&response.binding_id).and_then(|b| b.roots.clone()),
            codex_home: None,
            cursor_state_db: None,
            detailed_report: None,
        });
        config.save(dir)?;
        bound.push(proposal.provider);
        println!("  bound {} → {} ({})", proposal.provider, response.account_id, response.binding_id);
    }

    // The detailed monthly report: carry a v1 connection's analyzer settings over.
    let mut detailed_enabled = false;
    for binding in &mut config.bindings {
        if !bound.contains(&binding.provider) || binding.detailed_report.is_some() {
            continue;
        }
        let Some(found) = observatory_core::detailed::discover_v1(binding.provider) else { continue };
        let question = format!(
            "A v1 {} connection publishes the detailed monthly report (machine id {}). Run that analyzer from the companion too?",
            binding.provider, found.machine_id
        );
        if prompt.confirm(&question, true) {
            binding.detailed_report = Some(found);
            detailed_enabled = true;
        }
    }
    if detailed_enabled {
        config.save(dir)?;
    }

    // Knowledge sources: each Obsidian vault not tracked yet.
    if propose_resources(&mut config, &found.obsidian.vaults, &prompt) {
        config.save(dir)?;
    }

    // Readers, hook, and schedule: one question each.
    let mut over = InstallOverride::default();
    let mut allowance = AllowanceSettings {
        claude_reader: ClaudeReader::Statusline,
        codex_reader: observatory_contract::settings::CodexReader::AppServer,
        cursor_reader: CursorReader::Off,
    };
    let mut changed_allowance = false;
    if bound.contains(&Provider::Claude)
        && prompt.confirm(
            "Read Claude's OAuth usage (uses your existing Claude Code sign-in, private interface)?",
            false,
        )
    {
        allowance.claude_reader = ClaudeReader::OauthUsage;
        changed_allowance = true;
    }
    if bound.contains(&Provider::Cursor) {
        over.providers = Some(ProviderSwitches {
            claude: true,
            codex: true,
            cursor: true,
            anthropic_api: false,
            openai_api: false,
        });
        if prompt.confirm(
            "Read Cursor's usage summary (uses your existing Cursor sign-in, private interface)?",
            false,
        ) {
            allowance.cursor_reader = CursorReader::UsageSummary;
            changed_allowance = true;
        }
    }
    if changed_allowance {
        over.allowance = Some(allowance);
    }
    if detailed_enabled {
        over.detailed_monthly_report = Some(true);
    }
    let mut hook_installed = false;
    if bound.contains(&Provider::Claude)
        && prompt.confirm(
            "Install the Claude Code statusline hook (preserves an existing statusline command)?",
            true,
        )
    {
        match install_statusline_hook(dir) {
            Ok(preserved) => {
                hook_installed = true;
                if preserved.is_some() {
                    println!("  existing statusline command preserved as a passthrough");
                }
            }
            Err(error) => println!("  statusline hook not installed: {error}"),
        }
    }
    if bound.contains(&Provider::Claude) && !hook_installed {
        over.hooks = Some(HookSettings { claude_statusline: false, cursor_project_hooks: false });
    }
    let schedule = prompt.confirm("Install the hourly schedule?", true);
    if over != InstallOverride::default() {
        let response = client.put_settings(&over)?;
        println!("  settings override saved (settings_version {})", response.settings_version);
    }
    if args.secrets && !Secrets::exists(dir) {
        Secrets::default().save(dir)?;
        println!("  wrote secrets.json (0600); add anthropic_admin_key or openai_admin_key by hand");
    }

    // Dry run, first publish, schedule.
    let adapters = observatory_adapters::adapters();
    println!("Dry run…");
    let dry = run_cycle(dir, RunOptions { dry_run: true, ..RunOptions::default() }, &adapters)?;
    print_json(&dry);
    println!("First publish…");
    let first = run_cycle(dir, RunOptions::default(), &adapters)?;
    print_json(&first);
    if !first.ok {
        return Ok(ExitCode::from(1));
    }
    if schedule {
        let cadence = super::service::cadence_minutes(dir);
        let status = service::install(dir, &config.install_id, cadence)?;
        print_json(&status);
    }
    let v1 = service::v1_schedules();
    if !v1.is_empty() {
        println!("Found v1 collector schedules on this machine:");
        for label in &v1 {
            println!("  {label}");
        }
        if !args.yes
            && prompt.confirm(
                "Remove them now? (Keep them until this companion has published with receipts.)",
                false,
            )
        {
            for label in &v1 {
                match service::uninstall_v1(label) {
                    Ok(()) => println!("  removed {label}"),
                    Err(error) => println!("  could not remove {label}: {error}"),
                }
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use observatory_contract::{Lit, Uuid};
    use observatory_core::config::Secret;

    use super::*;

    fn config() -> CompanionConfig {
        CompanionConfig {
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
        }
    }

    fn vault(id: &str, name: &str) -> ObsidianVault {
        let root = std::env::temp_dir().join("synthetic").join(name);
        ObsidianVault { id: id.into(), path: root, name: name.into(), open: false }
    }

    #[test]
    fn setup_yes_never_adds_a_knowledge_source() {
        let mut config = config();
        let vaults = vec![vault("f00dbeefcafe0001", "vault-alpha"), vault("f00dbeefcafe0002", "vault-beta")];
        assert!(!propose_resources(&mut config, &vaults, &Prompt::new(true)));
        assert!(config.resources.is_empty());
        assert!(!propose_resources(&mut config, &[], &Prompt::new(true)));
        assert!(config.resources.is_empty());
    }

    #[test]
    fn configured_vaults_are_not_proposed_again() {
        let mut config = config();
        let vaults = vec![vault("f00dbeefcafe0001", "vault-alpha"), vault("f00dbeefcafe0002", "vault-beta")];
        let proposed: Vec<&str> =
            unconfigured_vaults(&config, &vaults).iter().map(|v| v.id.as_str()).collect();
        assert_eq!(proposed, vec!["f00dbeefcafe0001", "f00dbeefcafe0002"]);

        // A renamed key still carries the vault's source id.
        config.upsert_resource(LocalResource {
            key: "notes".into(),
            label: Some("vault-alpha".into()),
            roots: vec![vaults[0].path.clone()],
            connectors: Vec::new(),
            source: Some("obsidian:f00dbeefcafe0001".into()),
        });
        // A hand-added definition may use the default key without a source.
        config.upsert_resource(LocalResource {
            key: "obsidian.f00dbeefcafe0002".into(),
            label: None,
            roots: vec![vaults[1].path.clone()],
            connectors: Vec::new(),
            source: None,
        });
        assert!(unconfigured_vaults(&config, &vaults).is_empty());
        assert_eq!(vault_key(&vaults[0]), "obsidian.f00dbeefcafe0001");
        assert_eq!(vault_source(&vaults[1]), "obsidian:f00dbeefcafe0002");
    }
}
