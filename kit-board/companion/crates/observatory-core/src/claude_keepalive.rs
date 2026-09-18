//! Claude Code OAuth keepalive. When the setting is on, Observatory spawns
//! Claude Code so *it* refreshes its own store. This crate never POSTs a
//! refresh_token, never uses `--bare` (that skips OAuth), and never captures
//! stdout (`auth status --json` can name an email). Settings never name the
//! executable; discovery uses PATH and well-known install locations.

use std::time::Duration;

use thiserror::Error;

use crate::credentials::CredentialPresence;
use crate::discovery::find_executable;
use crate::process::{self, RpcError};

/// `claude auth status --json` — no prompt, no model turn.
pub const AUTH_STATUS_ARGS: &[&str] = &["auth", "status", "--json"];

/// How long a keepalive spawn may run before it is killed.
pub const TIMEOUT: Duration = Duration::from_secs(45);

/// Refresh when the access token expires within this many milliseconds.
pub const LEAD_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum KeepaliveError {
    #[error("claude executable missing")]
    ExecutableMissing,
    #[error("claude auth status timed out")]
    Timeout,
    #[error("claude auth status failed")]
    Failed,
}

/// Whether Claude Code should be asked to refresh before an OAuth usage call.
pub fn indicated(presence: CredentialPresence, now_ms: i64) -> bool {
    match presence {
        CredentialPresence::Expired => true,
        CredentialPresence::Present { expires_at: Some(at) } => at <= now_ms.saturating_add(LEAD_MS),
        CredentialPresence::Present { expires_at: None }
        | CredentialPresence::Missing
        | CredentialPresence::Unknown => false,
    }
}

/// Spawn an invisible `claude auth status`. Stdout and stderr are discarded.
pub fn refresh_store(timeout: Duration) -> Result<(), KeepaliveError> {
    let program = find_executable("claude").ok_or(KeepaliveError::ExecutableMissing)?;
    match process::run_discarded(&program, AUTH_STATUS_ARGS, timeout) {
        Ok(true) => Ok(()),
        Ok(false) => Err(KeepaliveError::Failed),
        Err(RpcError::Timeout) => Err(KeepaliveError::Timeout),
        Err(_) => Err(KeepaliveError::Failed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keepalive_is_only_for_expired_or_soon_to_expire_stores() {
        let now = 1_000_000_000_000;
        assert!(indicated(CredentialPresence::Expired, now));
        assert!(indicated(CredentialPresence::Present { expires_at: Some(now + LEAD_MS) }, now));
        assert!(!indicated(
            CredentialPresence::Present { expires_at: Some(now + LEAD_MS + 1) },
            now
        ));
        assert!(!indicated(CredentialPresence::Present { expires_at: None }, now));
        assert!(!indicated(CredentialPresence::Missing, now));
        assert!(!indicated(CredentialPresence::Unknown, now));
        assert_eq!(AUTH_STATUS_ARGS, &["auth", "status", "--json"]);
        assert!(!AUTH_STATUS_ARGS.iter().any(|arg| *arg == "--bare" || *arg == "-p"));
    }
}
