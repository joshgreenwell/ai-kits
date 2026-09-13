//! The local configuration files: `companion.json` (install id and key,
//! Observatory URL, per-binding root overrides, deny list) and the opt-in
//! `secrets.json` (Admin API keys). Both are `0600`; neither is ever uploaded.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use observatory_contract::{AccountId, Lit, Provider, Uuid};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::detailed::DetailedReportConfig;
use crate::paths::{self, write_private};

/// A credential that must never appear in logs or debug output.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: String) -> Self {
        Secret(value)
    }

    /// Exposes the value for the one use that needs it (an HTTP header).
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("companion is not connected; run `observatory connect` first")]
    NotConnected,
    #[error("configuration file is unreadable")]
    Io(#[from] io::Error),
    #[error("configuration file is not valid")]
    Invalid,
    #[error(transparent)]
    Path(#[from] paths::PathError),
}

/// One local binding, mirrored from the server plus the store overrides only
/// this machine knows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalBinding {
    pub binding_id: Uuid,
    pub account_id: AccountId,
    pub provider: Provider,
    /// Claude: transcript roots. Codex: session roots. Absent means the platform default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roots: Option<Vec<PathBuf>>,
    /// Codex only: the `CODEX_HOME` this binding reads (defaults to `~/.codex`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_home: Option<PathBuf>,
    /// Cursor only: the `state.vscdb` this binding reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_state_db: Option<PathBuf>,
    /// The detailed monthly analyzer for this binding, run when `detailed_monthly_report` is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detailed_report: Option<DetailedReportConfig>,
}

/// `companion.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompanionConfig {
    pub schema_version: Lit<1>,
    pub url: String,
    pub install_id: Uuid,
    pub key: Secret,
    pub machine_label: String,
    /// Backfill start (`YYYY-MM-DD`) used when the state database is created;
    /// afterwards the state pins it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(default)]
    pub bindings: Vec<LocalBinding>,
    /// Local deny list of adapter modes, e.g. `allowance.claude_reader.oauth_usage`.
    /// It can only remove.
    #[serde(default)]
    pub deny: Vec<String>,
    /// Where the Claude Code statusline hook writes allowance samples.
    /// Defaults to `<config dir>/inbox/claude-statusline`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_statusline_inbox: Option<PathBuf>,
}

impl CompanionConfig {
    pub const FILE_NAME: &'static str = "companion.json";

    pub fn path(dir: &Path) -> PathBuf {
        dir.join(Self::FILE_NAME)
    }

    pub fn load(dir: &Path) -> Result<CompanionConfig, ConfigError> {
        let path = Self::path(dir);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(ConfigError::NotConnected),
            Err(error) => return Err(ConfigError::Io(error)),
        };
        serde_json::from_slice(&bytes).map_err(|_| ConfigError::Invalid)
    }

    pub fn save(&self, dir: &Path) -> Result<(), ConfigError> {
        let text = serde_json::to_vec_pretty(self).map_err(|_| ConfigError::Invalid)?;
        write_private(&Self::path(dir), &text)?;
        Ok(())
    }

    pub fn binding(&self, binding_id: &Uuid) -> Option<&LocalBinding> {
        self.bindings.iter().find(|binding| &binding.binding_id == binding_id)
    }

    pub fn bindings_for(&self, provider: Provider) -> impl Iterator<Item = &LocalBinding> {
        self.bindings.iter().filter(move |binding| binding.provider == provider)
    }

    /// Adds or replaces a binding by id, keeping local overrides when the id is known.
    pub fn upsert_binding(&mut self, binding: LocalBinding) {
        match self.bindings.iter_mut().find(|existing| existing.binding_id == binding.binding_id) {
            Some(existing) => *existing = binding,
            None => self.bindings.push(binding),
        }
    }

    pub fn statusline_inbox(&self, dir: &Path) -> PathBuf {
        self.claude_statusline_inbox.clone().unwrap_or_else(|| dir.join("inbox").join("claude-statusline"))
    }

    /// The path of this install's state database.
    pub fn state_path(&self, dir: &Path) -> PathBuf {
        dir.join(format!("{}.sqlite3", self.install_id))
    }

    /// The path of this install's single-run lock.
    pub fn lock_path(&self, dir: &Path) -> PathBuf {
        dir.join(format!("{}.lock", self.install_id))
    }
}

/// `secrets.json`: Admin API keys, read only by `anthropic_api` and `openai_api`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Secrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_admin_key: Option<Secret>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai_admin_key: Option<Secret>,
}

impl Secrets {
    pub const FILE_NAME: &'static str = "secrets.json";

    pub fn path(dir: &Path) -> PathBuf {
        dir.join(Self::FILE_NAME)
    }

    pub fn exists(dir: &Path) -> bool {
        Self::path(dir).is_file()
    }

    pub fn load(dir: &Path) -> Result<Option<Secrets>, ConfigError> {
        match fs::read(Self::path(dir)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| ConfigError::Invalid),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(ConfigError::Io(error)),
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), ConfigError> {
        let text = serde_json::to_vec_pretty(self).map_err(|_| ConfigError::Invalid)?;
        write_private(&Self::path(dir), &text)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn round_trips_and_redacts() {
        let dir = tempfile::tempdir().unwrap();
        let config = CompanionConfig {
            schema_version: Lit,
            url: "https://example.test".into(),
            install_id: Uuid::v4(),
            key: Secret::new("k".repeat(43)),
            machine_label: "mac".into(),
            since: None,
            bindings: vec![LocalBinding {
                binding_id: Uuid::v4(),
                account_id: AccountId::from_str("claude-primary").unwrap(),
                provider: Provider::Claude,
                roots: Some(vec![PathBuf::from("/tmp/x")]),
                codex_home: None,
                cursor_state_db: None,
                detailed_report: None,
            }],
            deny: vec!["allowance.claude_reader.oauth_usage".into()],
            claude_statusline_inbox: None,
        };
        config.save(dir.path()).unwrap();
        let back = CompanionConfig::load(dir.path()).unwrap();
        assert_eq!(back, config);
        assert!(!format!("{back:?}").contains("kkkk"));
        assert!(matches!(CompanionConfig::load(&dir.path().join("missing")), Err(ConfigError::NotConnected)));
    }
}
