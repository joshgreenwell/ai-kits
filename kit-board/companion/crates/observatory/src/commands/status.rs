use std::path::Path;
use std::process::ExitCode;

use observatory_core::config::CompanionConfig;
use observatory_core::service;
use observatory_core::state::State;
use serde_json::{Value, json};

use super::{CommandResult, print_json};

/// Last run summary; outbox and receipts; schedule state. Never a token or a
/// path outside the configuration directory.
pub fn status(dir: &Path) -> CommandResult {
    let config = CompanionConfig::load(dir)?;
    let state = State::open(&config.state_path(dir))?;
    let last_run =
        state.last_run()?.map(|row| serde_json::from_str::<Value>(&row.summary).unwrap_or(Value::Null));
    let (records_total, records_pending, records_rejected) = state.record_counts()?;
    let schedule = service::status(&config.install_id).ok();
    let adapters: Vec<Value> = state
        .all_adapter_states()?
        .into_iter()
        .map(|row| {
            json!({ "adapter": row.adapter, "effective": row.effective, "reason": row.reason,
                "last_run_at": row.last_run_at, "last_state": row.last_state })
        })
        .collect();
    print_json(&json!({
        "ok": true,
        "version": observatory_core::VERSION,
        "install_id": config.install_id,
        "machine_label": config.machine_label,
        "url": config.url,
        "bindings": config.bindings.iter().map(|b| json!({ "binding_id": b.binding_id, "account_id": b.account_id, "provider": b.provider })).collect::<Vec<_>>(),
        "since": state.meta("since")?,
        "settings_version": state.cached_config()?.map(|c| c.settings_version),
        "last_run": last_run,
        "outbox": state.outbox_len()?,
        "last_receipt_at": state.last_receipt_at()?,
        "records": { "total": records_total, "pending": records_pending, "rejected": records_rejected },
        "schedule": schedule,
        "adapters": adapters,
    }));
    Ok(ExitCode::SUCCESS)
}
