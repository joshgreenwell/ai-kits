//! Discovers installed products and stores, and reads each signed-in identity
//! for display. Identity readers extract one non-secret field (an account id or
//! email) and drop everything else; no token is ever retained.

use std::fs;
use std::path::{Path, PathBuf};

use observatory_contract::Sha256Hex;
use observatory_contract::stable_json::stable_json;
use serde_json::{Value, json};

use crate::credentials::{CredentialPresence, claude_credential_presence};
use crate::paths;

/// A signed-in identity as shown to the user at setup, and its confirmed hash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisplayIdentity {
    /// What the user sees: an email or a truncated account id.
    pub label: String,
    /// `sha256(stableJson([provider, account uuid]))`, shared with the browser collector.
    pub evidence_hash: Sha256Hex,
}

#[derive(Clone, Debug)]
pub struct ClaudeDiscovery {
    pub projects_root: Option<PathBuf>,
    pub present: bool,
    pub credentials: CredentialPresence,
    pub identity: Option<DisplayIdentity>,
}

#[derive(Clone, Debug)]
pub struct CodexDiscovery {
    pub home: Option<PathBuf>,
    pub session_roots: Vec<PathBuf>,
    pub present: bool,
    pub executable: Option<PathBuf>,
    pub identity: Option<DisplayIdentity>,
}

#[derive(Clone, Debug)]
pub struct CursorDiscovery {
    pub state_db: Option<PathBuf>,
    pub tracking_db: Option<PathBuf>,
    pub present: bool,
}

/// One vault Obsidian lists in its registry. The path stays on this machine:
/// setup offers it as a knowledge-source root and the folder name as a local label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObsidianVault {
    /// Obsidian's own vault id (16 hex characters), the default key suffix.
    pub id: String,
    pub path: PathBuf,
    /// The vault folder's name; the only part of the path shown at setup.
    pub name: String,
    /// Whether Obsidian had the vault open when it last wrote the registry.
    pub open: bool,
}

#[derive(Clone, Debug)]
pub struct ObsidianDiscovery {
    /// Whether the registry file exists (its location is never printed).
    pub present: bool,
    pub vaults: Vec<ObsidianVault>,
}

#[derive(Clone, Debug)]
pub struct Discovered {
    pub claude: ClaudeDiscovery,
    pub codex: CodexDiscovery,
    pub cursor: CursorDiscovery,
    pub obsidian: ObsidianDiscovery,
}

/// `sha256(stableJson([provider, account]))`.
pub fn identity_hash(provider: &str, account: &str) -> Sha256Hex {
    Sha256Hex::digest(stable_json(&json!([provider, account])).as_bytes())
}

fn read_json(path: &Path) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The Claude Code account from `~/.claude.json` (`oauthAccount`), if signed in.
pub fn claude_identity() -> Option<DisplayIdentity> {
    let value = read_json(&paths::claude_config_file()?)?;
    let account = value.get("oauthAccount")?.as_object()?;
    let uuid = account.get("accountUuid")?.as_str()?.to_owned();
    let label = account
        .get("emailAddress")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| short(&uuid));
    Some(DisplayIdentity { label, evidence_hash: identity_hash("claude", &uuid) })
}

/// The Codex account id from `<codex home>/auth.json` (`tokens.account_id`), if signed in.
/// Only that field is read; the tokens beside it are never retained.
pub fn codex_identity(home: &Path) -> Option<DisplayIdentity> {
    let value = read_json(&home.join("auth.json"))?;
    let account = value.get("tokens")?.get("account_id")?.as_str()?.to_owned();
    Some(DisplayIdentity {
        label: format!("account {}", short(&account)),
        evidence_hash: identity_hash("codex", &account),
    })
}

fn short(id: &str) -> String {
    let count = id.chars().count();
    if count <= 8 { id.to_owned() } else { format!("…{}", id.chars().skip(count - 6).collect::<String>()) }
}

/// The vaults in Obsidian's registry (`vaults.<id>.path`), sorted by id. Entries
/// without a path are skipped; `ts` and everything else in the file is dropped.
pub fn obsidian_vaults_in(registry: &Path) -> Vec<ObsidianVault> {
    let Some(value) = read_json(registry) else { return Vec::new() };
    let Some(vaults) = value.get("vaults").and_then(Value::as_object) else { return Vec::new() };
    let mut out: Vec<ObsidianVault> = vaults
        .iter()
        .filter_map(|(id, entry)| {
            let path = PathBuf::from(entry.get("path")?.as_str()?);
            let name = path.file_name()?.to_string_lossy().into_owned();
            let open = entry.get("open").and_then(Value::as_bool).unwrap_or(false);
            Some(ObsidianVault { id: id.clone(), path, name, open })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// The vaults in this machine's Obsidian registry, if Obsidian is installed.
pub fn obsidian_vaults() -> Vec<ObsidianVault> {
    paths::obsidian_config_file().map(|path| obsidian_vaults_in(&path)).unwrap_or_default()
}

/// Searches `PATH` for an executable by name.
pub fn find_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let candidates: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd"), format!("{name}.bat"), name.to_owned()]
    } else {
        vec![name.to_owned()]
    };
    for dir in std::env::split_paths(&path) {
        for candidate in &candidates {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

/// Discovers everything the companion knows how to read on this machine.
pub fn discover() -> Discovered {
    let projects_root = paths::claude_projects_root();
    let claude = ClaudeDiscovery {
        present: projects_root.as_ref().is_some_and(|root| root.is_dir()),
        projects_root,
        credentials: claude_credential_presence(),
        identity: claude_identity(),
    };
    let home = paths::codex_home();
    let session_roots = home.as_ref().map(|home| paths::codex_session_roots(home)).unwrap_or_default();
    let codex = CodexDiscovery {
        present: session_roots.iter().any(|root| root.is_dir()),
        executable: find_executable("codex"),
        identity: home.as_ref().and_then(|home| codex_identity(home)),
        home,
        session_roots,
    };
    let state_db = paths::cursor_state_db().filter(|path| path.is_file());
    let tracking_db = paths::cursor_tracking_db().filter(|path| path.is_file());
    let cursor =
        CursorDiscovery { present: state_db.is_some() || tracking_db.is_some(), state_db, tracking_db };
    let registry = paths::obsidian_config_file().filter(|path| path.is_file());
    let obsidian = ObsidianDiscovery {
        present: registry.is_some(),
        vaults: registry.as_deref().map(obsidian_vaults_in).unwrap_or_default(),
    };
    Discovered { claude, codex, cursor, obsidian }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_hash_is_stable_json_of_pair() {
        let hash = identity_hash("claude", "abc");
        assert_eq!(hash, Sha256Hex::digest(br#"["claude","abc"]"#));
        assert_eq!(short("1234567890"), "…567890");
        assert_eq!(short("12345678"), "12345678");
    }

    #[test]
    fn codex_identity_reads_only_the_account_id() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("auth.json"),
            r#"{"tokens":{"id_token":"SECRET-ID","access_token":"SECRET-ACCESS","refresh_token":"SECRET-REFRESH","account_id":"acct-1234567890"}}"#,
        )
        .unwrap();
        let identity = codex_identity(dir.path()).unwrap();
        assert_eq!(identity.label, "account …567890");
        assert!(!format!("{identity:?}").contains("SECRET"));
        assert!(codex_identity(&dir.path().join("missing")).is_none());
    }

    #[test]
    fn obsidian_vaults_come_from_the_registry_paths_only() {
        let dir = tempfile::tempdir().unwrap();
        let registry = dir.path().join("obsidian.json");
        fs::write(
            &registry,
            r#"{"vaults":{
                "f00dbeefcafe0002":{"path":"/synthetic/vault-beta","ts":1700000000000},
                "f00dbeefcafe0001":{"path":"/synthetic/notes/vault-alpha","ts":1700000000000,"open":true},
                "f00dbeefcafe0003":{"ts":1700000000000}
            },"updateCheckTs":1700000000000}"#,
        )
        .unwrap();
        let vaults = obsidian_vaults_in(&registry);
        assert_eq!(
            vaults,
            vec![
                ObsidianVault {
                    id: "f00dbeefcafe0001".into(),
                    path: PathBuf::from("/synthetic/notes/vault-alpha"),
                    name: "vault-alpha".into(),
                    open: true,
                },
                ObsidianVault {
                    id: "f00dbeefcafe0002".into(),
                    path: PathBuf::from("/synthetic/vault-beta"),
                    name: "vault-beta".into(),
                    open: false,
                },
            ]
        );
        assert!(obsidian_vaults_in(&dir.path().join("missing.json")).is_empty());
        fs::write(&registry, b"{not json").unwrap();
        assert!(obsidian_vaults_in(&registry).is_empty());
        fs::write(&registry, br#"{"vaults":[]}"#).unwrap();
        assert!(obsidian_vaults_in(&registry).is_empty());
    }
}
