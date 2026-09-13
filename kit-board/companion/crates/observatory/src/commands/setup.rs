//! `setup`: discovers installed products and stores, reads each signed-in
//! identity for display, proposes bindings, asks one question each for the
//! private-interface readers, the statusline hook, and the schedule, writes
//! bindings and this install's settings override, runs a dry run, a first
//! publish, and `service install`, and offers to uninstall a v1 schedule.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::str::FromStr;

use jiff::Timestamp;
use observatory_contract::settings::{
    AllowanceSettings, ClaudeReader, CursorReader, HookSettings, ProviderSwitches,
};
use observatory_contract::{AccountId, BindingRequest, InstallOverride, Nullable, Provider, Text};
use observatory_core::config::{CompanionConfig, LocalBinding, Secrets};
use observatory_core::discovery::{Discovered, DisplayIdentity, discover};
use observatory_core::http::Client;
use observatory_core::paths::{home_dir, write_private};
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

fn claude_settings_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".claude").join("settings.json"))
}

/// Points Claude Code's statusline at `observatory statusline`, preserving an
/// existing custom command as a passthrough and backing the file up first.
fn install_statusline_hook(dir: &Path) -> Result<Option<String>, CommandError> {
    let Some(path) = claude_settings_path() else { return Ok(None) };
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
