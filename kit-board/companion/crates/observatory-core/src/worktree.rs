//! Worktree resolution and path keys for app projects (spec section 2.3).
//!
//! A working directory inside a git worktree belongs to the project of its
//! main repository. `main_repo` finds that repository from the path alone
//! where the layout says so, from the worktree's `.git` file while the
//! directory exists, or from Claude desktop's worktree list; otherwise it
//! answers `None` and the caller keeps any resolution it cached earlier.
//! Paths never leave the machine: only the membership a path resolves to is
//! uploaded, never the path or its main repository.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// How a main repository path was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolvedBy {
    /// `<repo>/.claude/worktrees/<name>`: the main repository is the prefix.
    ClaudeLexical,
    /// The worktree's `.git` file, its `gitdir`, and that directory's `commondir`.
    GitFile,
    /// Claude desktop's `git-worktrees.json` names the worktree's common directory.
    ClaudeDesktop,
}

impl ResolvedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            ResolvedBy::ClaudeLexical => "claude_lexical",
            ResolvedBy::GitFile => "git_file",
            ResolvedBy::ClaudeDesktop => "claude_desktop",
        }
    }
}

/// Where this machine keeps the stores `main_repo` consults. Tests build one
/// over a scratch directory; runs use `WorktreeEnv::current`.
#[derive(Clone, Debug, Default)]
pub struct WorktreeEnv {
    /// Every Codex home a binding reads; `<home>/worktrees/<id>/<repo>` is a Codex worktree.
    pub codex_homes: Vec<PathBuf>,
    /// The user's home, for `~/.cursor/worktrees/<repo>/<name>`.
    pub home: Option<PathBuf>,
    /// Claude desktop's `git-worktrees.json`, when this platform has one.
    pub claude_worktrees_file: Option<PathBuf>,
}

impl WorktreeEnv {
    pub fn current(codex_homes: Vec<PathBuf>) -> Self {
        let home = crate::paths::home_dir();
        let claude_worktrees_file = if cfg!(target_os = "macos") {
            home.as_ref().map(|home| home.join("Library/Application Support/Claude/git-worktrees.json"))
        } else if cfg!(windows) {
            std::env::var_os("APPDATA")
                .map(|base| PathBuf::from(base).join("Claude").join("git-worktrees.json"))
        } else {
            home.as_ref().map(|home| home.join(".config/Claude/git-worktrees.json"))
        };
        WorktreeEnv { codex_homes, home, claude_worktrees_file }
    }
}

/// Whether this platform compares paths without regard to case. Windows and
/// the default macOS volume format do; a case-sensitive macOS volume would
/// only make two spellings of one folder look like two folders.
pub const CASE_INSENSITIVE_PATHS: bool = cfg!(any(windows, target_os = "macos"));

/// `\\?\` and `\\?\UNC\` removed, `/` as the only separator, trailing
/// separators trimmed. The native spelling otherwise; used for file access.
pub fn plain_path(raw: &str) -> String {
    let text = raw.trim();
    let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!("//{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else if let Some(rest) = text.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = text.strip_prefix("//?/") {
        rest.to_owned()
    } else {
        text.to_owned()
    };
    let slashed = text.replace('\\', "/");
    let trimmed = slashed.trim_end_matches('/');
    if trimmed.is_empty() { slashed } else { trimmed.to_owned() }
}

/// The comparison key of a path: `plain_path`, lowercased where the platform
/// ignores case.
pub fn path_key(raw: &str) -> String {
    path_key_with(raw, CASE_INSENSITIVE_PATHS)
}

pub fn path_key_with(raw: &str, case_insensitive: bool) -> String {
    let plain = plain_path(raw);
    if case_insensitive { plain.to_lowercase() } else { plain }
}

fn segments(key: &str) -> Vec<&str> {
    key.split('/').filter(|segment| !segment.is_empty()).collect()
}

/// Whether `root` is `path` or one of its ancestors, segment by segment: a
/// root `/work/app` contains `/work/app/src` and never `/work/application`.
/// Both arguments are path keys.
pub fn contains(root: &str, path: &str) -> bool {
    let root = segments(root);
    let path = segments(path);
    !root.is_empty() && root.len() <= path.len() && root.iter().zip(path.iter()).all(|(a, b)| a == b)
}

/// The number of segments of a path key; the longest containing root wins.
pub fn depth(key: &str) -> usize {
    segments(key).len()
}

/// `path` with `prefix` replaced by `replacement`, when `prefix` contains it
/// (compared as keys). The remainder keeps its spelling.
fn rebase(path: &str, prefix: &str, replacement: &str) -> Option<String> {
    let path_plain = plain_path(path);
    let path_segments: Vec<&str> = segments(&path_plain);
    let prefix_len = depth(&path_key(prefix));
    if !contains(&path_key(prefix), &path_key(path)) {
        return None;
    }
    let mut out = plain_path(replacement);
    for segment in &path_segments[prefix_len..] {
        out.push('/');
        out.push_str(segment);
    }
    Some(out)
}

/// The main repository of a working directory that lives in a git worktree,
/// with the remainder of the path below the worktree root carried over, or
/// `None` when the path is not a worktree or cannot be resolved now.
pub fn main_repo(path: &str, env: &WorktreeEnv) -> Option<(String, ResolvedBy)> {
    let plain = plain_path(path);
    if let Some(main) = claude_lexical(&plain) {
        return Some((main, ResolvedBy::ClaudeLexical));
    }
    if let Some(main) = git_file_main(&plain) {
        return Some((main, ResolvedBy::GitFile));
    }
    if let Some(file) = &env.claude_worktrees_file
        && let Some(main) = claude_desktop_main(&plain, file)
    {
        return Some((main, ResolvedBy::ClaudeDesktop));
    }
    None
}

/// Whether the path lies in a worktree layout whose main repository the path
/// alone does not name: `<codex_home>/worktrees/<id>/<repo>` or
/// `~/.cursor/worktrees/<repo>/<name>`.
pub fn recognized_worktree(path: &str, env: &WorktreeEnv) -> bool {
    let key = path_key(path);
    let under = |base: PathBuf, levels: usize| {
        let base = path_key(&base.to_string_lossy());
        contains(&base, &key) && depth(&key) >= depth(&base) + levels
    };
    env.codex_homes.iter().any(|home| under(home.join("worktrees"), 2))
        || env.home.as_ref().is_some_and(|home| under(home.join(".cursor").join("worktrees"), 2))
}

/// `<repo>/.claude/worktrees/<name>[/rest]` → `<repo>[/rest]`.
fn claude_lexical(plain: &str) -> Option<String> {
    let parts: Vec<&str> = plain.split('/').collect();
    let lower: Vec<String> = parts.iter().map(|part| part.to_lowercase()).collect();
    let index = (0..parts.len().saturating_sub(2))
        .find(|&i| lower[i] == ".claude" && lower[i + 1] == "worktrees" && !parts[i + 2].is_empty())?;
    if index == 0 {
        return None;
    }
    let mut main = parts[..index].join("/");
    if main.is_empty() {
        main.push('/');
    }
    for rest in &parts[index + 3..] {
        if !rest.is_empty() {
            if !main.ends_with('/') {
                main.push('/');
            }
            main.push_str(rest);
        }
    }
    Some(main)
}

/// Walks up from an existing directory to its `.git` entry. A `.git` file whose
/// `gitdir` has a `commondir` is a linked worktree; its main repository is the
/// common directory's parent. A `.git` directory is a main repository itself.
fn git_file_main(plain: &str) -> Option<String> {
    let start = PathBuf::from(plain);
    if !start.is_dir() {
        return None;
    }
    let mut current: &Path = &start;
    for _ in 0..64 {
        let dot_git = current.join(".git");
        match fs::symlink_metadata(&dot_git) {
            Ok(meta) if meta.is_dir() => return None,
            Ok(meta) if meta.is_file() => {
                let main = linked_worktree_main(current, &dot_git)?;
                return rebase(plain, &current.to_string_lossy(), &main);
            }
            _ => {}
        }
        current = current.parent()?;
    }
    None
}

fn linked_worktree_main(worktree: &Path, dot_git: &Path) -> Option<String> {
    let text = fs::read_to_string(dot_git).ok()?;
    let gitdir = text.lines().find_map(|line| line.trim().strip_prefix("gitdir:")).map(str::trim)?;
    let gitdir = resolve_relative(worktree, gitdir);
    let commondir = fs::read_to_string(gitdir.join("commondir")).ok()?;
    let common = resolve_relative(&gitdir, commondir.trim());
    let common = normalize_dots(&common);
    if common.file_name().is_some_and(|name| name.eq_ignore_ascii_case(".git")) {
        common.parent().map(|parent| plain_path(&parent.to_string_lossy()))
    } else {
        None
    }
}

fn resolve_relative(base: &Path, value: &str) -> PathBuf {
    let candidate = PathBuf::from(value);
    if candidate.is_absolute() || value.starts_with('/') || value.starts_with('\\') {
        candidate
    } else {
        base.join(candidate)
    }
}

/// Removes `.` and `..` components without touching the file system.
fn normalize_dots(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Claude desktop's worktree list: each entry names a worktree path (its key
/// or a path field) and the repository's `commonDir`.
fn claude_desktop_main(plain: &str, file: &Path) -> Option<String> {
    let bytes = fs::read(file).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let entries = value.get("worktrees")?.as_object()?;
    let key = path_key(plain);
    let mut best: Option<(usize, String)> = None;
    for (entry_key, entry) in entries {
        let Some(common) = ["commonDir", "common_dir", "gitCommonDir"]
            .iter()
            .find_map(|field| entry.get(*field).and_then(Value::as_str))
        else {
            continue;
        };
        let fields = ["path", "worktreePath", "worktree_path", "cwd", "directory"];
        let named = fields.iter().filter_map(|field| entry.get(*field).and_then(Value::as_str));
        let candidates = std::iter::once(entry_key.as_str()).chain(named);
        for candidate in candidates {
            let candidate_key = path_key(candidate);
            if !contains(&candidate_key, &key) {
                continue;
            }
            let common_plain = plain_path(common);
            let main = match common_plain.rsplit_once('/') {
                Some((parent, last)) if last.eq_ignore_ascii_case(".git") && !parent.is_empty() => {
                    parent.to_owned()
                }
                _ => common_plain.clone(),
            };
            let Some(rebased) = rebase(plain, candidate, &main) else { continue };
            let length = depth(&candidate_key);
            if best.as_ref().is_none_or(|(best_length, _)| length > *best_length) {
                best = Some((length, rebased));
            }
        }
    }
    best.map(|(_, main)| main)
}

/// A folder URI as VS Code-based apps store it (`file:///c%3A/work/app`) as a
/// plain path, or `None` for any other scheme.
pub fn file_uri_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let decoded = percent_decode(rest)?;
    // `file:///c:/x` has an empty host; `file://server/share` is UNC.
    let path = if let Some(stripped) = decoded.strip_prefix('/') {
        let bytes = stripped.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            stripped.to_owned()
        } else {
            format!("/{stripped}")
        }
    } else {
        format!("//{decoded}")
    };
    let plain = plain_path(&path);
    (!plain.is_empty()).then_some(plain)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_keys_strip_verbatim_prefixes_and_compare_segment_wise() {
        assert_eq!(plain_path(r"\\?\C:\Work\App\"), "C:/Work/App");
        assert_eq!(plain_path(r"\\?\UNC\server\share\dir"), "//server/share/dir");
        assert_eq!(path_key_with(r"C:\Work\App", true), "c:/work/app");
        assert_eq!(path_key_with("/Work/App/", false), "/Work/App");
        assert!(contains(&path_key_with("c:/work/app", true), &path_key_with(r"C:\Work\App\src", true)));
        assert!(contains("/work/app", "/work/app"));
        assert!(!contains("/work/app", "/work/application"));
        assert!(!contains("/work/app/src", "/work/app"));
        assert_eq!(depth("/work/app"), 2);
    }

    #[test]
    fn claude_worktrees_resolve_lexically_with_the_remainder_kept() {
        let env = WorktreeEnv::default();
        assert_eq!(
            main_repo("/work/app/.claude/worktrees/feature-x", &env),
            Some(("/work/app".to_owned(), ResolvedBy::ClaudeLexical))
        );
        assert_eq!(
            main_repo(r"C:\work\app\.claude\worktrees\feature-x\sub", &env),
            Some(("C:/work/app/sub".to_owned(), ResolvedBy::ClaudeLexical))
        );
        assert_eq!(main_repo("/work/app/src", &env), None);
    }

    #[test]
    fn a_linked_worktree_resolves_through_its_git_file_while_it_exists() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main-repo");
        let common = main.join(".git");
        let gitdir = common.join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let worktree = dir.path().join("codex-home").join("worktrees").join("0001").join("main-repo");
        fs::create_dir_all(worktree.join("src")).unwrap();
        fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.to_string_lossy())).unwrap();
        let env = WorktreeEnv { codex_homes: vec![dir.path().join("codex-home")], ..WorktreeEnv::default() };
        let (resolved, by) = main_repo(&worktree.join("src").to_string_lossy(), &env).unwrap();
        assert_eq!(by, ResolvedBy::GitFile);
        assert_eq!(path_key(&resolved), path_key(&format!("{}/src", main.to_string_lossy())));
        assert!(recognized_worktree(&worktree.to_string_lossy(), &env));
        // A main repository resolves to nothing: it is not a worktree.
        assert_eq!(main_repo(&main.to_string_lossy(), &env), None);
        // Gone: nothing to read, so nothing resolves; the caller keeps its cache.
        fs::remove_dir_all(&worktree).unwrap();
        assert_eq!(main_repo(&worktree.to_string_lossy(), &env), None);
        assert!(recognized_worktree(&worktree.to_string_lossy(), &env));
    }

    #[test]
    fn claude_desktop_worktrees_name_their_common_directory() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("git-worktrees.json");
        fs::write(
            &file,
            serde_json::json!({
                "schemaVersion": 2,
                "worktrees": { "/scratch/wt-7": { "commonDir": "/work/app/.git" } }
            })
            .to_string(),
        )
        .unwrap();
        let env = WorktreeEnv { claude_worktrees_file: Some(file), ..WorktreeEnv::default() };
        assert_eq!(
            main_repo("/scratch/wt-7/lib", &env),
            Some(("/work/app/lib".to_owned(), ResolvedBy::ClaudeDesktop))
        );
        assert_eq!(main_repo("/scratch/other", &env), None);
    }

    #[test]
    fn folder_uris_decode_to_paths() {
        let decoded = file_uri_path("file:///c%3A/Users/someone/work%20app");
        assert_eq!(decoded.as_deref(), Some("c:/Users/someone/work app"));
        assert_eq!(file_uri_path("file:///home/someone/app/").as_deref(), Some("/home/someone/app"));
        assert_eq!(file_uri_path("vscode-remote://ssh/x"), None);
    }
}
