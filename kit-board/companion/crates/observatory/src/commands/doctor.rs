use std::path::Path;
use std::process::ExitCode;

use observatory_core::adapter::Preflight;
use observatory_core::credentials::CredentialPresence;
use observatory_core::discovery::discover;
use observatory_core::effective::effective;
use observatory_core::run::{RunOptions, prepare};
use observatory_core::service;
use serde_json::json;

use super::{CommandResult, print_json};

/// Effective mode and reason per adapter; prerequisite and credential checks
/// reported as coverage states. Prints booleans and codes, never a token or a
/// path outside the configuration directory.
pub fn doctor(dir: &Path) -> CommandResult {
    let options = RunOptions { dry_run: true, fetch_config: true, ..RunOptions::default() };
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
    print_json(&json!({
        "ok": true,
        "version": observatory_core::VERSION,
        "tls_roots": observatory_core::http::TLS_ROOTS_LABEL,
        "config": prepared.config_source,
        "config_error": prepared.config_error,
        "settings_version": ctx.settings_version,
        "since": ctx.since_text,
        "paused": ctx.settings.paused,
        "cadence_minutes": ctx.settings.cadence_minutes.get(),
        "latest_version": ctx.document.as_ref().and_then(|d| d.companion.latest_version.as_ref().map(|v| v.as_str().to_owned())),
        "deny": ctx.deny,
        "discovered": {
            "claude": { "present": found.claude.present, "credential": credential, "signed_in": found.claude.identity.is_some() },
            "codex": { "present": found.codex.present, "executable": found.codex.executable.is_some(), "signed_in": found.codex.identity.is_some() },
            "cursor": { "present": found.cursor.present },
        },
        "bindings": bindings,
        "adapters": rows,
        "schedule": service::status(&prepared.config.install_id).ok(),
        "v1_schedules": service::v1_schedules(),
    }));
    Ok(ExitCode::SUCCESS)
}
