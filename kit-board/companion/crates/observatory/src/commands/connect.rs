use std::path::Path;
use std::process::ExitCode;
use std::str::FromStr;

use jiff::civil::Date;
use observatory_contract::{Arch, InstallKind, Lit, PairRequest, Platform, Text};
use observatory_core::config::{CompanionConfig, ConfigError, Secret};
use observatory_core::http::Client;

use super::{CommandError, CommandResult, print_json};
use crate::cli::ConnectArgs;

/// The machine label default: the host name, else `companion`.
pub fn host_name() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(key)
            && !value.trim().is_empty()
        {
            return value.trim().to_owned();
        }
    }
    std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "companion".to_owned())
}

/// `POST /api/v1/companion/pair`, then write `companion.json` (0600) with the install id and key.
pub fn connect(dir: &Path, args: ConnectArgs) -> CommandResult {
    super::refuse_virtualized(dir)?;
    match CompanionConfig::load(dir) {
        Ok(_) if !args.force => return Err(CommandError::AlreadyConnected),
        Ok(_) | Err(ConfigError::NotConnected) => {}
        Err(error) => return Err(error.into()),
    }
    let since = match &args.since {
        Some(text) => {
            if text.len() != 10 || Date::from_str(text).is_err() {
                return Err(CommandError::Invalid("--since expects a calendar date as YYYY-MM-DD".into()));
            }
            Some(text.clone())
        }
        None => None,
    };
    let client = Client::new(&args.url, None)?;
    let label = args.label.clone().unwrap_or_else(host_name);
    let machine_label = Text::try_from(label.chars().take(100).collect::<String>())
        .map_err(|_| CommandError::Invalid("a machine label is required".into()))?;
    let code: String =
        args.code.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_uppercase();
    if code.len() != 8 {
        return Err(CommandError::Invalid("the pairing code has eight characters".into()));
    }
    let request = PairRequest {
        code,
        machine_label: machine_label.clone(),
        kind: InstallKind::Companion,
        platform: Platform::current(),
        arch: Arch::current(),
    };
    let response = client.pair(&request)?;
    let config = CompanionConfig {
        schema_version: Lit,
        url: client.base().to_owned(),
        install_id: response.install_id.clone(),
        key: Secret::new(response.key),
        machine_label: machine_label.as_str().to_owned(),
        since,
        bindings: Vec::new(),
        deny: Vec::new(),
        claude_statusline_inbox: None,
    };
    config.save(dir)?;
    print_json(&serde_json::json!({
        "ok": true, "install_id": response.install_id, "machine_label": machine_label.as_str(),
        "url": client.base(), "since": config.since, "next": "observatory setup",
    }));
    Ok(ExitCode::SUCCESS)
}
