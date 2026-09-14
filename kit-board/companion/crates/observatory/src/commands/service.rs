use std::path::Path;
use std::process::ExitCode;

use observatory_core::config::CompanionConfig;
use observatory_core::run::{
    ConfigSource, Prepared, RunOptions, prepare, report_capabilities, schedule_summary,
};
use observatory_core::service;
use observatory_core::state::State;
use serde_json::json;

use super::{CommandResult, print_json};
use crate::cli::{ServiceAction, ServiceArgs};

fn prepared(dir: &Path) -> Option<Prepared> {
    let options = RunOptions { dry_run: true, fetch_config: true, ..RunOptions::default() };
    prepare(dir, &options, false).ok()
}

/// The cadence from the effective settings (fetched when possible, else cached, else 60).
pub fn cadence_minutes(dir: &Path) -> u64 {
    prepared(dir).map_or(60, |prepared| prepared.ctx.settings.cadence_minutes.get())
}

/// Installs, removes, or reports the schedule, then tells the Observatory what this
/// build can do (best-effort; a refused post is reported, never fatal).
pub fn service(dir: &Path, args: ServiceArgs) -> CommandResult {
    let config = CompanionConfig::load(dir)?;
    let prepared = prepared(dir);
    let cadence = prepared.as_ref().map_or(60, |prepared| prepared.ctx.settings.cadence_minutes.get());
    let status = match args.action {
        ServiceAction::Install => service::install(dir, &config.install_id, cadence)?,
        ServiceAction::Uninstall => service::uninstall(&config.install_id)?,
        ServiceAction::Status => service::status(&config.install_id)?,
    };
    let desired = prepared
        .as_ref()
        .filter(|prepared| prepared.config_source != ConfigSource::Defaults)
        .map(|_| cadence);
    let schedule = schedule_summary(dir, &config.install_id, desired);
    let capabilities = match (&prepared, args.action) {
        (Some(prepared), ServiceAction::Install | ServiceAction::Uninstall) => {
            let state = State::open(&prepared.ctx.state_path)?;
            Some(report_capabilities(
                &prepared.config,
                &prepared.ctx,
                &state,
                prepared.config_source,
                &observatory_adapters::adapters(),
                &schedule,
                true,
            ))
        }
        _ => None,
    };
    print_json(&json!({
        "ok": true,
        "installed": status.installed,
        "label": status.label,
        "scheduler": status.scheduler,
        "schedule": schedule,
        "capabilities": capabilities,
    }));
    Ok(ExitCode::SUCCESS)
}
