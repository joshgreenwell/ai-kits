//! Presence checks for the application sign-ins adapters may read. Nothing here
//! returns a token: a credential is read at run time by the adapter that needs
//! it, used for one request, and dropped. The companion never refreshes one.

use std::fs;
use std::process::Command;

use serde_json::Value;

use crate::paths;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialPresence {
    /// A sign-in exists; `expires_at` is epoch milliseconds when the store says so.
    Present {
        expires_at: Option<i64>,
    },
    /// The store reports an expiry in the past; the companion will not refresh it.
    Expired,
    Missing,
    /// The store exists but could not be interpreted.
    Unknown,
}

/// Whether Claude Code's OAuth sign-in exists, without reading the token.
///
/// macOS: the Keychain item `Claude Code-credentials`, probed with
/// `/usr/bin/security find-generic-password` (a subprocess, never the Security
/// framework, and without `-w`, so the secret is not printed). Elsewhere:
/// `~/.claude/.credentials.json`, from which only `claudeAiOauth.expiresAt` is read.
pub fn claude_credential_presence() -> CredentialPresence {
    if cfg!(target_os = "macos") {
        return match Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", "Claude Code-credentials"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
        {
            Ok(status) if status.success() => CredentialPresence::Present { expires_at: None },
            Ok(_) => CredentialPresence::Missing,
            Err(_) => CredentialPresence::Unknown,
        };
    }
    let Some(path) = paths::claude_credentials_file() else { return CredentialPresence::Missing };
    match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => {
                let expires =
                    value.get("claudeAiOauth").and_then(|o| o.get("expiresAt")).and_then(Value::as_i64);
                let now_ms = jiff::Timestamp::now().as_millisecond();
                match expires {
                    Some(at) if at <= now_ms => CredentialPresence::Expired,
                    Some(at) => CredentialPresence::Present { expires_at: Some(at) },
                    None if value.get("claudeAiOauth").is_some() => {
                        CredentialPresence::Present { expires_at: None }
                    }
                    None => CredentialPresence::Missing,
                }
            }
            Err(_) => CredentialPresence::Unknown,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => CredentialPresence::Missing,
        Err(_) => CredentialPresence::Unknown,
    }
}
