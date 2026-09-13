use std::path::Path;
use std::process::ExitCode;

use observatory_core::run::{RunOptions, run as run_cycle};

use super::{CommandResult, print_json};
use crate::cli::RunArgs;

/// One collection cycle. Exit 1 when the upload failed so a scheduler log shows it.
pub fn run(dir: &Path, args: RunArgs) -> CommandResult {
    let options = RunOptions { dry_run: args.dry_run, fetch_config: !args.offline, ..RunOptions::default() };
    let adapters = observatory_adapters::adapters();
    let summary = run_cycle(dir, options, &adapters)?;
    print_json(&summary);
    Ok(if summary.ok { ExitCode::SUCCESS } else { ExitCode::from(1) })
}
