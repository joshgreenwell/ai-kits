//! Where things live on a user's machine (section 2.8), and private file writes.
//!
//! Store paths are discovered here, can be overridden per binding in
//! `companion.json`, and are never uploaded. The server knows a binding's
//! account and provider, not its paths.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum PathError {
    #[error("no home directory")]
    NoHome,
    #[error("no configuration directory")]
    NoConfigDir,
}

/// The user's home directory: `HOME` on Unix, `USERPROFILE` on Windows.
pub fn home_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// The companion's configuration, key, state, and log directory.
/// `OBSERVATORY_CONFIG_DIR` overrides it (used by tests and by `setup --config`).
pub fn config_dir() -> Result<PathBuf, PathError> {
    if let Some(dir) = std::env::var_os("OBSERVATORY_CONFIG_DIR") {
        return Ok(PathBuf::from(dir));
    }
    if cfg!(windows) {
        return std::env::var_os("LOCALAPPDATA")
            .map(|base| PathBuf::from(base).join("PersonalObservatory"))
            .ok_or(PathError::NoConfigDir);
    }
    home_dir().map(|home| home.join(".config/personal-hub/companion")).ok_or(PathError::NoHome)
}

/// Whether files written to this directory land in a packaged (MSIX) application's
/// private store. Windows redirects new folders a packaged app such as the Claude
/// desktop app creates under `%LOCALAPPDATA%` into `Packages/<app>/LocalCache/Local`;
/// files there are invisible to Task Scheduler, other terminals, and every other
/// program, so a companion set up from inside such an app would never run on
/// schedule. Only a file reveals the redirect (the directory itself canonicalizes
/// to its nominal path), so the check writes and removes an empty probe file,
/// creating the directory when it does not exist yet.
pub fn virtualized_store(dir: &Path) -> bool {
    if !cfg!(windows) || fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(format!(".observatory-probe-{}", std::process::id()));
    if fs::write(&probe, b"").is_err() {
        return false;
    }
    let real = fs::canonicalize(&probe).map(|p| p.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let _ = fs::remove_file(&probe);
    real.contains("\\packages\\") && real.contains("\\localcache\\")
}

/// The configuration directory that survives packaged-app redirection on Windows:
/// under the profile root, which Windows never virtualizes.
pub fn unvirtualized_config_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".config").join("personal-hub").join("companion"))
}

/// Claude Code's project transcripts.
pub fn claude_projects_root() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".claude").join("projects"))
}

/// Claude Code's top-level config, which names the signed-in account (no secret).
pub fn claude_config_file() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".claude.json"))
}

/// Claude Code's file-based OAuth store (Windows and Linux; macOS uses the Keychain).
pub fn claude_credentials_file() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".claude").join(".credentials.json"))
}

/// `CODEX_HOME` or `~/.codex`.
pub fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| home_dir().map(|home| home.join(".codex")))
}

/// Codex session roots under a Codex home.
pub fn codex_session_roots(home: &Path) -> Vec<PathBuf> {
    vec![home.join("sessions"), home.join("archived_sessions")]
}

/// Cursor's global state database.
pub fn cursor_state_db() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        home_dir().map(|home| home.join("Library/Application Support/Cursor/User/globalStorage/state.vscdb"))
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(|base| {
            PathBuf::from(base).join("Cursor").join("User").join("globalStorage").join("state.vscdb")
        })
    } else {
        home_dir().map(|home| home.join(".config/Cursor/User/globalStorage/state.vscdb"))
    }
}

/// Cursor's AI code tracking database.
pub fn cursor_tracking_db() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".cursor").join("ai-tracking").join("ai-code-tracking.db"))
}

/// Creates a directory the current user alone can read (`0700` on Unix).
pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    restrict(path, 0o700)
}

/// Writes a file atomically (temporary file plus rename) with `0600` permissions on Unix.
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent =
        path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent directory"))?;
    ensure_private_dir(parent)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let temp = parent.join(format!("{name}.{}.tmp", std::process::id()));
    fs::write(&temp, bytes)?;
    restrict(&temp, 0o600)?;
    if let Err(error) = fs::rename(&temp, path) {
        // Windows refuses to rename over an existing file that another handle holds open.
        if path.exists() {
            fs::remove_file(path).and_then(|()| fs::rename(&temp, path)).map_err(|_| error)?;
        } else {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn restrict(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

/// Windows has no mode bits; `%LOCALAPPDATA%` is private to the user by its default ACL.
#[cfg(not(unix))]
fn restrict(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

/// A stable identity for a file: `dev:ino` on Unix, `volume:index` on Windows.
/// Used to tell a rotated or replaced file from an appended one.
pub fn file_identity(path: &Path) -> io::Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::metadata(path)?;
        Ok(format!("{}:{}", meta.dev(), meta.ino()))
    }
    #[cfg(windows)]
    {
        let file = fs::File::open(path)?;
        let info = winapi_util::file::information(&file)?;
        Ok(format!("{}:{}", info.volume_serial_number(), info.file_index()))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Ok(String::from("unknown"))
    }
}

/// `mtime` as integer nanoseconds since the epoch, matching Python's `st_mtime_ns`.
pub fn mtime_ns(meta: &fs::Metadata) -> i128 {
    match meta.modified() {
        Ok(modified) => match modified.duration_since(std::time::UNIX_EPOCH) {
            Ok(duration) => {
                i128::from(duration.as_secs()) * 1_000_000_000 + i128::from(duration.subsec_nanos())
            }
            Err(before) => {
                -(i128::from(before.duration().as_secs()) * 1_000_000_000
                    + i128::from(before.duration().subsec_nanos()))
            }
        },
        Err(_) => 0,
    }
}

/// `mtime` as float seconds, matching Python's `st_mtime`.
pub fn mtime_seconds(meta: &fs::Metadata) -> f64 {
    mtime_ns(meta) as f64 / 1e9
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_write_is_atomic_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("companion.json");
        write_private(&path, b"one").unwrap();
        write_private(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert!(fs::read_dir(path.parent().unwrap()).unwrap().count() == 1);
        assert!(file_identity(&path).unwrap().contains(':'));
    }
}
