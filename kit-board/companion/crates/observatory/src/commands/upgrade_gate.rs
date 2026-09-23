use std::process::ExitCode;

use jiff::Timestamp;
use observatory_core::gate::evaluate;
use observatory_core::state::State;

use super::{CommandError, CommandResult, print_json};
use crate::cli::UpgradeGateArgs;

fn invalid(message: &str) -> CommandError {
    CommandError::Invalid(message.to_owned())
}

/// Runs the upgrade gate over a dry-run state copy and prints the verdict as
/// counts and codes. Exit 0 when the copy passes, 3 on any violation. Reads
/// only; never pass the live state file.
pub fn upgrade_gate(args: UpgradeGateArgs) -> CommandResult {
    let cutoff: Timestamp =
        args.cutoff.parse().map_err(|_| invalid("--cutoff must be an RFC 3339 timestamp"))?;
    if !args.state.is_file() {
        return Err(invalid("--state must name an existing state copy"));
    }
    let state = State::open_read_only(&args.state)?;
    let baseline = match &args.baseline {
        None => None,
        Some(path) if path.is_file() => Some(State::open_read_only(path)?),
        Some(_) => return Err(invalid("--baseline must name an existing state copy")),
    };
    let report = evaluate(&state, cutoff, baseline.as_ref())?;
    print_json(&report);
    Ok(if report.ok { ExitCode::SUCCESS } else { ExitCode::from(3) })
}
