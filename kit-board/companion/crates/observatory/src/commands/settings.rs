use std::path::Path;
use std::process::ExitCode;

use observatory_contract::CollectionSettings;
use observatory_core::config::CompanionConfig;
use observatory_core::state::State;
use serde_json::{Value, json};

use super::{CommandResult, print_json};
use crate::cli::{SettingsAction, SettingsArgs};

/// The cached effective settings document and its `settings_version`.
pub fn settings(dir: &Path, args: SettingsArgs) -> CommandResult {
    let SettingsAction::Show = args.action;
    let config = CompanionConfig::load(dir)?;
    let state = State::open(&config.state_path(dir))?;
    let cached = state.cached_config()?;
    let document: Option<Value> = cached.as_ref().and_then(|c| serde_json::from_str(&c.document).ok());
    let settings = document
        .as_ref()
        .and_then(|d| d.get("settings").cloned())
        .unwrap_or_else(|| serde_json::to_value(CollectionSettings::defaults()).unwrap_or(Value::Null));
    print_json(&json!({
        "ok": true,
        "source": if cached.is_some() { "cache" } else { "defaults" },
        "settings_version": cached.as_ref().map(|c| c.settings_version).unwrap_or(0),
        "fetched_at": cached.as_ref().map(|c| c.fetched_at.clone()),
        "deny": config.deny,
        "settings": settings,
    }));
    Ok(ExitCode::SUCCESS)
}
