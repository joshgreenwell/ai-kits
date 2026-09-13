use std::path::Path;
use std::process::ExitCode;

use observatory_core::config::CompanionConfig;
use observatory_core::run::{RunOptions, prepare};
use observatory_core::service;

use super::{CommandResult, print_json};
use crate::cli::{ServiceAction, ServiceArgs};

/// The cadence from the effective settings (fetched when possible, else cached, else 60).
pub fn cadence_minutes(dir: &Path) -> u64 {
    let options = RunOptions { dry_run: true, fetch_config: true, ..RunOptions::default() };
    match prepare(dir, &options, false) {
        Ok(prepared) => prepared.ctx.settings.cadence_minutes.get(),
        Err(_) => 60,
    }
}

pub fn service(dir: &Path, args: ServiceArgs) -> CommandResult {
    let config = CompanionConfig::load(dir)?;
    let status = match args.action {
        ServiceAction::Install => service::install(dir, &config.install_id, cadence_minutes(dir))?,
        ServiceAction::Uninstall => service::uninstall(&config.install_id)?,
        ServiceAction::Status => service::status(&config.install_id)?,
    };
    print_json(&status);
    Ok(ExitCode::SUCCESS)
}
