use std::path::Path;
use std::process::ExitCode;

use observatory_core::config::CompanionConfig;
use observatory_core::state::State;
use serde_json::json;

use super::{CommandResult, print_json};

/// The working directories each binding has seen, with the project hash the
/// Observatory receives when `execution.project_attribution` is `hashed`. This is
/// the only place a path and its hash appear together: the listing is printed on
/// this machine so the operator can label a hash on the server. Nothing here is
/// uploaded, and the privacy key the hashes are computed under is not shown.
pub fn projects(dir: &Path) -> CommandResult {
    let config = CompanionConfig::load(dir)?;
    let state = State::open(&config.state_path(dir))?;
    // Creating the key re-keys a listing left by a build without one; the key itself stays unread.
    state.privacy_key()?;
    let mut bindings = Vec::new();
    for binding in &config.bindings {
        let projects: Vec<_> = state
            .projects(&binding.binding_id.to_string())?
            .into_iter()
            .map(|row| {
                json!({ "project_hash": row.project_hash, "path": row.path,
                    "first_seen": row.first_seen, "last_seen": row.last_seen })
            })
            .collect();
        bindings.push(json!({ "binding_id": binding.binding_id, "account_id": binding.account_id,
            "provider": binding.provider, "projects": projects }));
    }
    print_json(&json!({
        "ok": true,
        "attribution": "hmac_sha256(privacy_key, [\"project\", cwd])",
        "bindings": bindings,
    }));
    Ok(ExitCode::SUCCESS)
}
