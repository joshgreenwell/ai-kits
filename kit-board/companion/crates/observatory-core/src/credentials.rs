//! Presence checks for the application sign-ins adapters may read. Token
//! readers used at request time never POST a refresh_token, never log one, and
//! drop it after the call that needed it. Claude OAuth keepalive, when on,
//! spawns Claude Code so *it* refreshes its own store; this module still only
//! reads.

use std::fs;
use std::process::Command;

use serde_json::Value;

use observatory_contract::DetailCode;

use crate::adapter::AdapterError;
use crate::config::Secret;
use crate::paths;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialPresence {
    /// A sign-in exists; `expires_at` is epoch milliseconds when the store says so.
    Present {
        expires_at: Option<i64>,
    },
    /// The store reports an expiry in the past. Observatory never POSTs a
    /// refresh_token; keepalive may spawn Claude Code to refresh the store.
    Expired,
    Missing,
    /// The store exists but could not be interpreted.
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialError {
    Missing,
    Expired,
    Unreadable,
}

impl CredentialError {
    pub fn detail(self) -> DetailCode {
        match self {
            CredentialError::Expired => DetailCode::CredentialExpired,
            CredentialError::Missing | CredentialError::Unreadable => DetailCode::CredentialMissing,
        }
    }

    pub fn adapter_error(self) -> AdapterError {
        AdapterError::Credential(self.detail())
    }
}

impl CredentialPresence {
    fn from_expires_at(expires_at: Option<i64>, present_without_expiry: bool) -> Self {
        let now_ms = jiff::Timestamp::now().as_millisecond();
        match expires_at {
            Some(at) if at <= now_ms => CredentialPresence::Expired,
            Some(at) => CredentialPresence::Present { expires_at: Some(at) },
            None if present_without_expiry => CredentialPresence::Present { expires_at: None },
            None => CredentialPresence::Missing,
        }
    }
}

/// Whether Claude Code's OAuth sign-in exists, without reading the token.
///
/// macOS: the Keychain item `Claude Code-credentials`, probed with
/// `/usr/bin/security find-generic-password` (a subprocess, never the Security
/// framework, and without `-w`, so the secret is not printed). Elsewhere:
/// `~/.claude/.credentials.json`, from which only `claudeAiOauth.expiresAt` is read.
pub fn claude_credential_presence() -> CredentialPresence {
    claude_credential_presence_in(paths::claude_credentials_file().as_deref())
}

pub fn claude_credential_presence_in(path: Option<&std::path::Path>) -> CredentialPresence {
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
    let Some(path) = path else { return CredentialPresence::Missing };
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => claude_oauth_presence(&value),
            Err(_) => CredentialPresence::Unknown,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => CredentialPresence::Missing,
        Err(_) => CredentialPresence::Unknown,
    }
}

fn claude_oauth_presence(value: &Value) -> CredentialPresence {
    let oauth = value.get("claudeAiOauth");
    let expires = oauth.and_then(|o| o.get("expiresAt")).and_then(Value::as_i64);
    CredentialPresence::from_expires_at(expires, oauth.is_some())
}

/// The Claude Code OAuth access token, used for one request and then dropped.
/// Never POSTs a refresh. macOS reads Keychain with `-w` only at this call.
pub fn claude_access_token() -> Result<Secret, CredentialError> {
    claude_access_token_in(paths::claude_credentials_file().as_deref())
}

pub fn claude_access_token_in(path: Option<&std::path::Path>) -> Result<Secret, CredentialError> {
    // Tests leave the path unset so they never read a real sign-in or hit Keychain.
    // Production `prepare` sets the platform path even on macOS, where the file is
    // only a sentinel that collection was allowed to ask for the token.
    let Some(path) = path else {
        return Err(CredentialError::Missing);
    };
    let value = if cfg!(target_os = "macos") {
        let _ = path;
        claude_keychain_credentials()?
    } else {
        let bytes = fs::read(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                CredentialError::Missing
            } else {
                CredentialError::Unreadable
            }
        })?;
        serde_json::from_slice::<Value>(&bytes).map_err(|_| CredentialError::Unreadable)?
    };
    match claude_oauth_presence(&value) {
        CredentialPresence::Expired => return Err(CredentialError::Expired),
        CredentialPresence::Missing => return Err(CredentialError::Missing),
        CredentialPresence::Unknown => return Err(CredentialError::Unreadable),
        CredentialPresence::Present { .. } => {}
    }
    let token = value
        .get("claudeAiOauth")
        .and_then(|oauth| oauth.get("accessToken"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or(CredentialError::Missing)?;
    Ok(Secret::new(token.to_owned()))
}

fn claude_keychain_credentials() -> Result<Value, CredentialError> {
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .map_err(|_| CredentialError::Unreadable)?;
    if !output.status.success() {
        return Err(CredentialError::Missing);
    }
    let text = String::from_utf8(output.stdout).map_err(|_| CredentialError::Unreadable)?;
    serde_json::from_str(text.trim()).map_err(|_| CredentialError::Unreadable)
}

/// Whether Codex's `auth.json` names an account, without retaining tokens.
pub fn codex_credential_presence(home: &std::path::Path) -> CredentialPresence {
    match fs::read(home.join("auth.json")) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => {
                if value
                    .get("tokens")
                    .and_then(|tokens| tokens.get("account_id"))
                    .and_then(Value::as_str)
                    .is_some()
                {
                    CredentialPresence::Present { expires_at: None }
                } else if value.get("tokens").is_some() {
                    CredentialPresence::Unknown
                } else {
                    CredentialPresence::Missing
                }
            }
            Err(_) => CredentialPresence::Unknown,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => CredentialPresence::Missing,
        Err(_) => CredentialPresence::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn claude_file_credentials_are_presence_then_token_without_logging() {
        if cfg!(target_os = "macos") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".credentials.json");
        fs::write(
            &path,
            r#"{"claudeAiOauth":{"accessToken":"SECRET-TOKEN","refreshToken":"SECRET-REFRESH","expiresAt":4102444800000}}"#,
        )
        .unwrap();
        assert!(matches!(claude_credential_presence_in(Some(&path)), CredentialPresence::Present { .. }));
        let token = claude_access_token_in(Some(&path)).unwrap();
        assert_eq!(token.expose(), "SECRET-TOKEN");
        assert!(!format!("{token:?}").contains("SECRET"));
        fs::write(&path, r#"{"claudeAiOauth":{"accessToken":"SECRET-TOKEN","expiresAt":1}}"#).unwrap();
        assert_eq!(claude_credential_presence_in(Some(&path)), CredentialPresence::Expired);
        assert_eq!(claude_access_token_in(Some(&path)), Err(CredentialError::Expired));
        assert_eq!(claude_access_token_in(None), Err(CredentialError::Missing));
    }

    #[test]
    fn codex_presence_reads_only_the_account_id_field() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("auth.json"),
            r#"{"tokens":{"id_token":"SECRET-ID","access_token":"SECRET-ACCESS","account_id":"acct-1"}}"#,
        )
        .unwrap();
        assert_eq!(codex_credential_presence(dir.path()), CredentialPresence::Present { expires_at: None });
        fs::write(dir.path().join("auth.json"), r#"{"tokens":{}}"#).unwrap();
        assert_eq!(codex_credential_presence(dir.path()), CredentialPresence::Unknown);
    }
}
