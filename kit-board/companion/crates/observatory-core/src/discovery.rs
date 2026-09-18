//! Discovers installed products and stores, and reads each signed-in identity
//! for display. Identity readers extract one non-secret field (an account id or
//! email) and drop everything else; no token is ever retained.

use std::fs;
use std::path::{Path, PathBuf};

use observatory_contract::Sha256Hex;
use observatory_contract::stable_json::stable_json;
use serde_json::{Value, json};

use crate::credentials::{CredentialPresence, claude_credential_presence};
use crate::cursor_store;
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
    pub credentials: CredentialPresence,
    pub identity: Option<DisplayIdentity>,
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

/// The Claude Code account from the resolved config file (`oauthAccount`), if signed in.
pub fn claude_identity() -> Option<DisplayIdentity> {
    claude_identity_in(&paths::claude_config_file()?)
}

/// The Claude Code account named by one config file (`oauthAccount.accountUuid`).
pub fn claude_identity_in(path: &Path) -> Option<DisplayIdentity> {
    claude_identity_from(&read_json(path)?)
}

/// The Claude Code account named by a parsed config document. Only the account
/// uuid and the email beside it are read; every other field is dropped.
pub fn claude_identity_from(value: &Value) -> Option<DisplayIdentity> {
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

/// The Cursor account from `cursorAuth.userId` in `state.vscdb`. The access token
/// beside it is never retained here.
pub fn cursor_identity(state_db: &Path) -> Option<DisplayIdentity> {
    let identity = cursor_store::cursor_auth_identity(state_db).ok()?;
    let account = identity.user_id?;
    let label = identity.label.filter(|email| email.contains('@')).unwrap_or_else(|| short(&account));
    Some(DisplayIdentity { label, evidence_hash: identity_hash("cursor", &account) })
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

/// Searches `PATH` for an executable by name, then well-known Codex or Claude
/// Code install locations when looking up those names. Settings never name a path.
pub fn find_executable(name: &str) -> Option<PathBuf> {
    if let Some(found) = find_on_path(name) {
        return Some(found);
    }
    if name == "codex" || name.eq_ignore_ascii_case("codex.exe") {
        return find_codex_install();
    }
    if name == "claude" || name.eq_ignore_ascii_case("claude.exe") || name.eq_ignore_ascii_case("claude.cmd") {
        return find_claude_install();
    }
    None
}

/// npm global (`%APPDATA%\npm`), `~/.local/bin`, and nvm symlink/bin dirs.
/// Never a settings-named path.
pub fn find_claude_install() -> Option<PathBuf> {
    first_existing_claude(&claude_search_roots())
}

fn claude_search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(home) = paths::home_dir() {
        roots.push(home.join(".local").join("bin"));
    }
    for key in ["NVM_SYMLINK", "NVM_BIN"] {
        if let Some(dir) = std::env::var_os(key) {
            roots.push(PathBuf::from(dir));
        }
    }
    roots
}

fn claude_file_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["claude.cmd", "claude.exe", "claude"]
    } else {
        &["claude"]
    }
}

fn first_existing_claude(roots: &[PathBuf]) -> Option<PathBuf> {
    for root in roots {
        for name in claude_file_names() {
            let full = root.join(name);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

fn find_on_path(name: &str) -> Option<PathBuf> {
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

/// The Windows desktop install keeps `codex.exe` under hashed folders in
/// `%LOCALAPPDATA%\OpenAI\Codex\bin`, which is not on PATH. The plugin copy
/// under `~/.codex/plugins` is a fallback.
pub fn find_codex_install() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if cfg!(windows)
        && let Some(base) = std::env::var_os("LOCALAPPDATA")
    {
        let bin = PathBuf::from(base).join("OpenAI").join("Codex").join("bin");
        candidates.extend(codex_exes_in_hashed_bin(&bin));
    }
    if let Some(home) = paths::home_dir() {
        let name = if cfg!(windows) { "codex.exe" } else { "codex" };
        let plugin = home.join(".codex").join("plugins").join(".plugin-appserver").join(name);
        if plugin.is_file() {
            candidates.push(plugin);
        }
        let unix = home.join(".local").join("bin").join("codex");
        if unix.is_file() {
            candidates.push(unix);
        }
    }
    candidates.sort_by_key(|path| std::fs::metadata(path).and_then(|m| m.modified()).ok());
    candidates.pop()
}

fn codex_exes_in_hashed_bin(bin: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(bin) else { return found };
    for entry in entries.flatten() {
        let exe = entry.path().join(if cfg!(windows) { "codex.exe" } else { "codex" });
        if exe.is_file() {
            found.push(exe);
        }
    }
    found
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
    let cursor = CursorDiscovery {
        present: state_db.is_some() || tracking_db.is_some(),
        credentials: state_db
            .as_deref()
            .map(cursor_store::cursor_credential_presence)
            .unwrap_or(CredentialPresence::Missing),
        identity: state_db.as_deref().and_then(cursor_identity),
        state_db,
        tracking_db,
    };
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
    fn claude_identity_reads_only_the_account_uuid() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("claude.json");
        fs::write(
            &file,
            r#"{"oauthAccount":{"accountUuid":"11111111-2222-4333-8444-555555555555","emailAddress":"synthetic@example.test","organizationUuid":"SECRET-ORG"},"primaryApiKey":"SECRET-KEY"}"#,
        )
        .unwrap();
        let identity = claude_identity_in(&file).unwrap();
        assert_eq!(identity.label, "synthetic@example.test");
        assert_eq!(identity.evidence_hash, identity_hash("claude", "11111111-2222-4333-8444-555555555555"));
        assert!(!format!("{identity:?}").contains("SECRET"));
        fs::write(&file, br#"{"oauthAccount":{"accountUuid":"12345678"}}"#).unwrap();
        assert_eq!(claude_identity_in(&file).unwrap().label, "12345678");
        fs::write(&file, br#"{"numStartups":3}"#).unwrap();
        assert!(claude_identity_in(&file).is_none(), "signed out");
        assert!(claude_identity_in(&dir.path().join("missing.json")).is_none());
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
    fn cursor_identity_hashes_the_user_id_and_drops_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);").unwrap();
        conn.execute(
            "INSERT INTO ItemTable(key, value) VALUES ('cursorAuth', ?1)",
            [r#"{"userId":"user-42","cachedEmail":"synthetic@example.test","accessToken":"SECRET-CURSOR"}"#],
        )
        .unwrap();
        let identity = cursor_identity(&path).unwrap();
        assert_eq!(identity.label, "synthetic@example.test");
        assert_eq!(identity.evidence_hash, identity_hash("cursor", "user-42"));
        assert!(!format!("{identity:?}").contains("SECRET"));
    }

    #[test]
    fn cursor_identity_reads_split_itemtable_scalars() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);").unwrap();
        conn.execute(
            "INSERT INTO ItemTable(key, value) VALUES ('adminSettings.cachedAuthId', ?1)",
            ["auth_01SYNTHETICUSERIDVALUE"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable(key, value) VALUES ('cursorAuth/cachedEmail', ?1)",
            ["synthetic@example.test"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable(key, value) VALUES ('cursorAuth/accessToken', ?1)",
            ["SECRET-CURSOR"],
        )
        .unwrap();
        let identity = cursor_identity(&path).unwrap();
        assert_eq!(identity.label, "synthetic@example.test");
        assert_eq!(identity.evidence_hash, identity_hash("cursor", "auth_01SYNTHETICUSERIDVALUE"));
        assert!(!format!("{identity:?}").contains("SECRET"));
    }

    #[test]
    fn claude_install_is_the_first_existing_file_in_search_roots() {
        let dir = tempfile::tempdir().unwrap();
        let npm = dir.path().join("npm");
        fs::create_dir(&npm).unwrap();
        let missing = dir.path().join("empty");
        fs::create_dir(&missing).unwrap();
        let name = if cfg!(windows) { "claude.cmd" } else { "claude" };
        let exe = npm.join(name);
        fs::write(&exe, b"not-a-binary").unwrap();
        assert_eq!(first_existing_claude(&[missing, npm.clone()]), Some(exe));
        assert!(first_existing_claude(&[dir.path().join("absent")]).is_none());
    }

    #[test]
    fn hashed_codex_bin_dirs_are_discovered() {
        let dir = tempfile::tempdir().unwrap();
        let hashed = dir.path().join("deadbeefcafe");
        fs::create_dir(&hashed).unwrap();
        let exe = hashed.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        fs::write(&exe, b"not-a-binary").unwrap();
        assert_eq!(codex_exes_in_hashed_bin(dir.path()), vec![exe]);
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
