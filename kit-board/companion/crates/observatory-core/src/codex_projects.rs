//! The read-only Codex desktop project resolver (spec section 2.3).
//!
//! The Codex app keeps the projects the owner created, their root folders, and
//! its threads in `<codex_home>/state_<N>.sqlite`, and its explicit thread
//! assignments in `<codex_home>/.codex-global-state.json`. This module reads
//! both without writing either, tolerates missing columns and keys, and answers
//! `Unavailable` when the store cannot be read now, so a run keeps what it
//! published before instead of downgrading anything. A machine without the
//! desktop app reads as an empty store: every folder is then outside the roots.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use observatory_contract::MembershipResolution;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::worktree::{contains, depth, path_key};

/// One project the owner created in the Codex app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexProject {
    pub id: String,
    pub name: String,
    pub position: Option<i64>,
    /// Root folders, as the app stores them.
    pub roots: Vec<String>,
}

/// One thread the app knows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CodexThread {
    pub id: String,
    pub cwd: Option<String>,
    pub rollout_path: Option<String>,
    pub project_id: Option<String>,
    pub agent_role: Option<String>,
    pub title: Option<String>,
}

/// Everything the resolver read from one Codex home.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CodexStore {
    pub projects: Vec<CodexProject>,
    pub threads: BTreeMap<String, CodexThread>,
    /// child thread id → parent thread id, from `thread_spawn_edges`.
    pub parents: HashMap<String, String>,
    /// thread id → project id, the explicit assignments translated to current ids.
    pub assignments: HashMap<String, String>,
    pub projectless: HashSet<String>,
    /// thread id → project id from the optional `codex-dev.db` catalog.
    pub catalog_projects: HashMap<String, String>,
}

/// The outcome of reading a Codex home.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodexRead {
    Available(Box<CodexStore>),
    /// The store exists but could not be read now (locked, unreadable, corrupt).
    Unavailable(&'static str),
}

/// How one thread resolved, before the project id becomes a project key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadResolution {
    pub resolution: MembershipResolution,
    pub project_id: Option<String>,
}

impl ThreadResolution {
    fn project(resolution: MembershipResolution, project_id: &str) -> Self {
        ThreadResolution { resolution, project_id: Some(project_id.to_owned()) }
    }

    fn none(resolution: MembershipResolution) -> Self {
        ThreadResolution { resolution, project_id: None }
    }
}

/// One project root as a comparison key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootKey {
    pub project_id: String,
    pub key: String,
}

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Every `state_<N>.sqlite` in a Codex home, highest number first. A home that
/// does not exist has none; a home that exists but cannot be listed is an error,
/// so an unreadable directory never reads as an empty (all-removed) store.
fn state_files(home: &Path) -> Result<Vec<(u64, PathBuf)>, &'static str> {
    let entries = match fs::read_dir(home) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("home_unreadable"),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| "home_unreadable")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let number = name
            .strip_prefix("state_")
            .and_then(|rest| rest.strip_suffix(".sqlite"))
            .and_then(|number| number.parse::<u64>().ok());
        if let Some(number) = number {
            files.push((number, entry.path()));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(files)
}

fn open_read_only(path: &Path) -> Option<Connection> {
    let flags =
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI;
    let conn = Connection::open_with_flags(path, flags).ok()?;
    conn.busy_timeout(BUSY_TIMEOUT).ok()?;
    Some(conn)
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<HashSet<String>> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement.query_map([], |row| row.get::<_, String>(1))?;
    names.collect()
}

fn has_table(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")?.exists([table])
}

/// `column` when the table has it, else `NULL`, so a missing column reads as absent.
fn column_or_null(present: &HashSet<String>, column: &str) -> String {
    if present.contains(column) { column.to_owned() } else { "NULL".to_owned() }
}

fn text_cell(row: &rusqlite::Row<'_>, index: usize) -> Option<String> {
    match row.get_ref(index).ok()? {
        rusqlite::types::ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes).trim().to_owned();
            (!text.is_empty()).then_some(text)
        }
        rusqlite::types::ValueRef::Integer(value) => Some(value.to_string()),
        _ => None,
    }
}

fn int_cell(row: &rusqlite::Row<'_>, index: usize) -> Option<i64> {
    match row.get_ref(index).ok()? {
        rusqlite::types::ValueRef::Integer(value) => Some(value),
        rusqlite::types::ValueRef::Real(value) if value.is_finite() => Some(value.trunc() as i64),
        _ => None,
    }
}

/// Reads one Codex home. See the module documentation for the three outcomes.
pub fn read(home: &Path) -> CodexRead {
    let files = match state_files(home) {
        Ok(files) => files,
        Err(reason) => return CodexRead::Unavailable(reason),
    };
    if files.is_empty() {
        return CodexRead::Available(Box::default());
    }
    let mut store_file = None;
    for (_, path) in &files {
        let Some(conn) = open_read_only(path) else { return CodexRead::Unavailable("state_unreadable") };
        match has_table(&conn, "projects") {
            Ok(true) => {
                store_file = Some(conn);
                break;
            }
            Ok(false) => continue,
            Err(_) => return CodexRead::Unavailable("state_unreadable"),
        }
    }
    // No store with a projects table: the desktop app is absent (a CLI-only machine).
    let Some(conn) = store_file else { return CodexRead::Available(Box::default()) };
    match read_store(&conn) {
        Ok(mut store) => {
            // A side file that exists but cannot be read now (a torn write, a lock) makes the
            // whole store unavailable: reading it as empty would move assigned threads.
            if let Err(reason) = read_global_state(home, &mut store) {
                return CodexRead::Unavailable(reason);
            }
            if let Err(reason) = read_catalog(home, &mut store) {
                return CodexRead::Unavailable(reason);
            }
            CodexRead::Available(Box::new(store))
        }
        Err(_) => CodexRead::Unavailable("state_unreadable"),
    }
}

fn read_store(conn: &Connection) -> rusqlite::Result<CodexStore> {
    let mut store = CodexStore::default();
    let project_columns = columns(conn, "projects")?;
    if !project_columns.contains("id") {
        return Ok(store);
    }
    let sql = format!(
        "SELECT id, {}, {} FROM projects",
        column_or_null(&project_columns, "name"),
        column_or_null(&project_columns, "position")
    );
    let mut projects: BTreeMap<String, CodexProject> = BTreeMap::new();
    {
        let mut statement = conn.prepare(&sql)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let Some(id) = text_cell(row, 0) else { continue };
            let name = match row.get_ref(1)? {
                rusqlite::types::ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).into_owned(),
                _ => String::new(),
            };
            projects
                .insert(id.clone(), CodexProject { id, name, position: int_cell(row, 2), roots: Vec::new() });
        }
    }
    if has_table(conn, "project_roots")? {
        let root_columns = columns(conn, "project_roots")?;
        if root_columns.contains("project_id") && root_columns.contains("path") {
            let order = if root_columns.contains("position") { "position" } else { "rowid" };
            let sql = format!("SELECT project_id, path FROM project_roots ORDER BY project_id, {order}");
            let mut statement = conn.prepare(&sql)?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let (Some(id), Some(path)) = (text_cell(row, 0), text_cell(row, 1)) else { continue };
                if let Some(project) = projects.get_mut(&id) {
                    project.roots.push(path);
                }
            }
        }
    }
    let mut ordered: Vec<CodexProject> = projects.into_values().collect();
    ordered.sort_by(|a, b| a.position.cmp(&b.position).then_with(|| a.id.cmp(&b.id)));
    store.projects = ordered;

    if has_table(conn, "threads")? {
        let thread_columns = columns(conn, "threads")?;
        if thread_columns.contains("id") {
            let sql = format!(
                "SELECT id, {}, {}, {}, {}, {} FROM threads",
                column_or_null(&thread_columns, "cwd"),
                column_or_null(&thread_columns, "rollout_path"),
                column_or_null(&thread_columns, "project_id"),
                column_or_null(&thread_columns, "agent_role"),
                column_or_null(&thread_columns, "title"),
            );
            let mut statement = conn.prepare(&sql)?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let Some(id) = text_cell(row, 0) else { continue };
                store.threads.insert(
                    id.clone(),
                    CodexThread {
                        id,
                        cwd: text_cell(row, 1),
                        rollout_path: text_cell(row, 2),
                        project_id: text_cell(row, 3),
                        agent_role: text_cell(row, 4),
                        title: text_cell(row, 5),
                    },
                );
            }
        }
    }
    if has_table(conn, "thread_spawn_edges")? {
        let edge_columns = columns(conn, "thread_spawn_edges")?;
        if edge_columns.contains("parent_thread_id") && edge_columns.contains("child_thread_id") {
            let sql = "SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges";
            let mut statement = conn.prepare(sql)?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                if let (Some(parent), Some(child)) = (text_cell(row, 0), text_cell(row, 1))
                    && parent != child
                {
                    store.parents.insert(child, parent);
                }
            }
        }
    }
    Ok(store)
}

/// `thread-project-assignments` translated through
/// `app-server-project-id-by-legacy-project-id-by-host`, and `projectless-thread-ids`.
/// A missing file or missing keys leave both empty; a file that exists but cannot
/// be read or parsed now (the app rewriting it) is an error.
fn read_global_state(home: &Path, store: &mut CodexStore) -> Result<(), &'static str> {
    let bytes = match fs::read(home.join(".codex-global-state.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("global_state_unreadable"),
    };
    let value = serde_json::from_slice::<Value>(&bytes).map_err(|_| "global_state_unreadable")?;
    let known: HashSet<String> = store.projects.iter().map(|project| project.id.clone()).collect();
    let mut legacy: HashMap<String, String> = HashMap::new();
    let legacy_key = "app-server-project-id-by-legacy-project-id-by-host";
    if let Some(hosts) = value.get(legacy_key).and_then(Value::as_object) {
        for map in hosts.values().filter_map(Value::as_object) {
            for (old, new) in map {
                if let Some(new) = new.as_str() {
                    legacy.entry(old.clone()).or_insert_with(|| new.to_owned());
                }
            }
        }
    }
    if let Some(assignments) = value.get("thread-project-assignments").and_then(Value::as_object) {
        for (thread, assignment) in assignments {
            let project = match assignment {
                Value::String(id) => Some(id.as_str()),
                Value::Object(fields) => fields.get("projectId").and_then(Value::as_str),
                _ => None,
            };
            let Some(project) = project else { continue };
            let resolved = if known.contains(project) {
                Some(project.to_owned())
            } else {
                legacy.get(project).filter(|id| known.contains(id.as_str())).cloned()
            };
            if let Some(resolved) = resolved {
                store.assignments.insert(thread.clone(), resolved);
            }
        }
    }
    if let Some(ids) = value.get("projectless-thread-ids").and_then(Value::as_array) {
        store.projectless.extend(ids.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    Ok(())
}

/// The optional `sqlite/codex-dev.db` `local_thread_catalog(thread_id, project_id)`.
/// A missing file, table, or column (schema drift) leaves it empty; a database that
/// exists but cannot be opened or queried now (locked, corrupt) is an error.
fn read_catalog(home: &Path, store: &mut CodexStore) -> Result<(), &'static str> {
    let path = home.join("sqlite").join("codex-dev.db");
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("catalog_unreadable"),
    }
    let conn = open_read_only(&path).ok_or("catalog_unreadable")?;
    let read = || -> rusqlite::Result<Vec<(String, String)>> {
        if !has_table(&conn, "local_thread_catalog")? {
            return Ok(Vec::new());
        }
        let present = columns(&conn, "local_thread_catalog")?;
        if !present.contains("thread_id") || !present.contains("project_id") {
            return Ok(Vec::new());
        }
        let mut statement = conn
            .prepare("SELECT thread_id, project_id FROM local_thread_catalog WHERE project_id IS NOT NULL")?;
        let mut rows = statement.query([])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            if let (Some(thread), Some(project)) = (text_cell(row, 0), text_cell(row, 1)) {
                out.push((thread, project));
            }
        }
        Ok(out)
    };
    let known: HashSet<&str> = store.projects.iter().map(|project| project.id.as_str()).collect();
    let rows = read().map_err(|_| "catalog_unreadable")?;
    let mut catalog = HashMap::new();
    for (thread, project) in rows {
        if known.contains(project.as_str()) {
            catalog.insert(thread, project);
        }
    }
    store.catalog_projects = catalog;
    Ok(())
}

impl CodexStore {
    /// Every project root as a comparison key.
    pub fn root_keys(&self) -> Vec<RootKey> {
        let mut roots = Vec::new();
        for project in &self.projects {
            for root in &project.roots {
                roots.push(RootKey { project_id: project.id.clone(), key: path_key(root) });
            }
        }
        roots
    }

    pub fn project(&self, id: &str) -> Option<&CodexProject> {
        self.projects.iter().find(|project| project.id == id)
    }

    /// Rules 1 to 3: the thread's own project, an explicit assignment, or the app's projectless list.
    fn explicit(&self, id: &str) -> Option<ThreadResolution> {
        let known = |project: &str| self.project(project).is_some();
        if let Some(project) = self.threads.get(id).and_then(|thread| thread.project_id.as_deref())
            && known(project)
        {
            return Some(ThreadResolution::project(MembershipResolution::AppAssignment, project));
        }
        if let Some(project) = self.assignments.get(id).or_else(|| self.catalog_projects.get(id)) {
            return Some(ThreadResolution::project(MembershipResolution::AppAssignment, project));
        }
        if self.projectless.contains(id) {
            return Some(ThreadResolution::none(MembershipResolution::Projectless));
        }
        None
    }

    /// The root ancestor of a spawned thread, following `thread_spawn_edges`.
    pub fn root_ancestor(&self, id: &str) -> Option<String> {
        let mut current = self.parents.get(id)?.clone();
        let mut seen = HashSet::from([id.to_owned()]);
        while let Some(parent) = self.parents.get(&current) {
            if !seen.insert(current.clone()) {
                break;
            }
            current = parent.clone();
        }
        Some(current)
    }

    /// Whether the app records this thread as a subagent: a spawn edge or a role.
    pub fn is_subagent(&self, id: &str) -> bool {
        self.parents.contains_key(id)
            || self.threads.get(id).is_some_and(|thread| thread.agent_role.is_some())
    }

    /// The per-thread resolution order of section 2.3. `folder(thread, cwd)`
    /// resolves the working directory of `thread` against the roots (rule 5),
    /// worktree-aware; rule 4 passes the root ancestor, whose cwd it is.
    pub fn resolve_thread(
        &self,
        id: &str,
        folder: &mut dyn FnMut(&str, &str) -> Option<ThreadResolution>,
    ) -> Option<ThreadResolution> {
        let thread = self.threads.get(id)?;
        if let Some(explicit) = self.explicit(id) {
            return Some(explicit);
        }
        // Rule 4: a spawned thread takes its root ancestor's whole result, rules 1 to 6,
        // when the app knows that root. A root chat makes its subagents chats too.
        if let Some(root) = self.root_ancestor(id).filter(|root| root != id)
            && let Some(root_thread) = self.threads.get(&root)
        {
            let inherited = self
                .explicit(&root)
                .or_else(|| root_thread.cwd.as_deref().and_then(|cwd| folder(&root, cwd)))
                .unwrap_or(ThreadResolution::none(MembershipResolution::Projectless));
            return Some(match inherited.project_id {
                Some(project) => ThreadResolution::project(MembershipResolution::Inherited, &project),
                None => ThreadResolution::none(MembershipResolution::Projectless),
            });
        }
        if let Some(found) = thread.cwd.as_deref().and_then(|cwd| folder(id, cwd)) {
            return Some(found);
        }
        // Rule 6: a thread the app knows with no project is a chat in the app's own terms.
        Some(ThreadResolution::none(MembershipResolution::Projectless))
    }
}

/// The longest root containing `key`, segment-wise.
pub fn longest_root<'a>(roots: &'a [RootKey], key: &str) -> Option<&'a RootKey> {
    roots
        .iter()
        .filter(|root| contains(&root.key, key))
        .max_by(|a, b| depth(&a.key).cmp(&depth(&b.key)).then_with(|| b.project_id.cmp(&a.project_id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_store(home: &Path, with_project_id: bool) -> Connection {
        fs::create_dir_all(home).unwrap();
        let conn = Connection::open(home.join("state_5.sqlite")).unwrap();
        let project_id = if with_project_id { ", project_id TEXT" } else { "" };
        conn.execute_batch(&format!(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
             CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL);
             CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL,
               title TEXT NOT NULL, agent_role TEXT{project_id});
             CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT PRIMARY KEY,
               status TEXT NOT NULL);"
        ))
        .unwrap();
        conn
    }

    fn thread(conn: &Connection, id: &str, cwd: &str) {
        conn.execute(
            "INSERT INTO threads (id, rollout_path, cwd, title) VALUES (?1, ?2, ?3, 'synthetic')",
            [id, &format!("/synthetic/rollouts/{id}.jsonl"), cwd],
        )
        .unwrap();
    }

    fn resolver(store: &CodexStore) -> impl FnMut(&str, &str) -> Option<ThreadResolution> + '_ {
        let roots = store.root_keys();
        move |_thread: &str, cwd: &str| {
            longest_root(&roots, &path_key(cwd))
                .map(|root| ThreadResolution::project(MembershipResolution::RootPrefix, &root.project_id))
        }
    }

    /// Spec test R9: the resolver over synthetic stores.
    #[test]
    fn the_resolution_order_follows_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codex");
        let conn = write_store(&home, false);
        conn.execute_batch(
            "INSERT INTO projects VALUES ('p-outer', 'Outer', 0), ('p-inner', 'Inner', 1), ('p-other', 'Other', 2);
             INSERT INTO project_roots VALUES ('p-outer', 0, 'C:\\Work\\Outer'),
               ('p-inner', 0, '\\\\?\\C:\\Work\\Outer\\Inner'), ('p-other', 0, '/work/other');",
        )
        .unwrap();
        thread(&conn, "t-assigned", "/elsewhere");
        thread(&conn, "t-projectless", "/work/other/app");
        thread(&conn, "t-root-projectless", "/elsewhere");
        thread(&conn, "t-child-of-projectless", "/work/other");
        thread(&conn, "t-root-assigned", "/elsewhere");
        thread(&conn, "t-child", "/elsewhere");
        thread(&conn, "t-grandchild", "/elsewhere");
        thread(&conn, "t-nested", "C:/Work/Outer/Inner/src");
        thread(&conn, "t-outer", "C:/WORK/OUTER/docs");
        thread(&conn, "t-chat", "/nowhere");
        thread(&conn, "t-catalog", "/nowhere");
        conn.execute_batch(
            "INSERT INTO thread_spawn_edges VALUES ('t-root-projectless', 't-child-of-projectless', 'done'),
               ('t-root-assigned', 't-child', 'done'), ('t-child', 't-grandchild', 'done');",
        )
        .unwrap();
        drop(conn);
        fs::write(
            home.join(".codex-global-state.json"),
            json!({
                "thread-project-assignments": {
                    "t-assigned": { "projectKind": "local", "projectId": "legacy-outer" },
                    "t-root-assigned": { "projectKind": "local", "projectId": "p-other" }
                },
                "app-server-project-id-by-legacy-project-id-by-host": { "local:host": { "legacy-outer": "p-outer" } },
                "projectless-thread-ids": ["t-projectless", "t-root-projectless"]
            })
            .to_string(),
        )
        .unwrap();
        fs::create_dir_all(home.join("sqlite")).unwrap();
        let catalog = Connection::open(home.join("sqlite").join("codex-dev.db")).unwrap();
        catalog
            .execute_batch(
                "CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, project_id TEXT);
                 INSERT INTO local_thread_catalog VALUES ('h', 't-catalog', 'p-inner'), ('h', 't-chat', NULL);",
            )
            .unwrap();
        drop(catalog);

        let CodexRead::Available(store) = read(&home) else { panic!("store must read") };
        assert_eq!(store.projects.len(), 3);
        let mut folder = resolver(&store);
        let resolve = |id: &str, folder: &mut dyn FnMut(&str, &str) -> Option<ThreadResolution>| {
            let found = store.resolve_thread(id, folder).unwrap();
            (found.resolution, found.project_id)
        };
        use MembershipResolution::*;
        assert_eq!(resolve("t-assigned", &mut folder), (AppAssignment, Some("p-outer".into())));
        assert_eq!(resolve("t-projectless", &mut folder), (Projectless, None), "explicit beats the root");
        assert_eq!(resolve("t-child-of-projectless", &mut folder), (Projectless, None));
        assert_eq!(resolve("t-child", &mut folder), (Inherited, Some("p-other".into())));
        assert_eq!(resolve("t-grandchild", &mut folder), (Inherited, Some("p-other".into())));
        assert_eq!(resolve("t-nested", &mut folder), (RootPrefix, Some("p-inner".into())), "longest root");
        // Windows and macOS compare paths without case; elsewhere the spelling decides.
        let outer = if crate::worktree::CASE_INSENSITIVE_PATHS {
            (RootPrefix, Some("p-outer".into()))
        } else {
            (Projectless, None)
        };
        assert_eq!(resolve("t-outer", &mut folder), outer);
        assert_eq!(resolve("t-catalog", &mut folder), (AppAssignment, Some("p-inner".into())));
        assert_eq!(resolve("t-chat", &mut folder), (Projectless, None), "rule 6");
        assert!(store.resolve_thread("t-unknown", &mut folder).is_none());
    }

    #[test]
    fn a_missing_project_id_column_is_tolerated_and_a_present_one_wins() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codex");
        let conn = write_store(&home, true);
        conn.execute_batch(
            "INSERT INTO projects VALUES ('p-a', 'A', 0);
             INSERT INTO threads (id, rollout_path, cwd, title, project_id) VALUES ('t', '/r.jsonl', '/x', 'x', 'p-a');",
        )
        .unwrap();
        drop(conn);
        let CodexRead::Available(store) = read(&home) else { panic!() };
        let found = store.resolve_thread("t", &mut |_, _| None).unwrap();
        assert_eq!(found, ThreadResolution::project(MembershipResolution::AppAssignment, "p-a"));
    }

    #[test]
    fn an_absent_app_is_an_empty_store_and_an_unreadable_one_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(&dir.path().join("missing")), CodexRead::Available(Box::default()));
        // A CLI-only store: threads but no projects table.
        let cli = dir.path().join("cli");
        fs::create_dir_all(&cli).unwrap();
        Connection::open(cli.join("state_5.sqlite"))
            .unwrap()
            .execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT);")
            .unwrap();
        assert_eq!(read(&cli), CodexRead::Available(Box::default()));
        // Not a database at all.
        let broken = dir.path().join("broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("state_5.sqlite"), b"this is not a sqlite database, only text").unwrap();
        assert!(matches!(read(&broken), CodexRead::Unavailable(_)));
    }

    /// A side file that exists but cannot be read now makes the store unavailable,
    /// never an empty one; missing side files and tables still read as empty.
    #[test]
    fn unreadable_side_files_and_homes_are_unavailable_not_empty() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codex");
        let conn = write_store(&home, false);
        conn.execute_batch("INSERT INTO projects VALUES ('p', 'P', 0);").unwrap();
        drop(conn);
        assert!(matches!(read(&home), CodexRead::Available(_)), "no side files at all");

        // A torn global-state write.
        let global = home.join(".codex-global-state.json");
        fs::write(&global, br#"{"thread-project-assignments": {"t": "#).unwrap();
        assert_eq!(read(&home), CodexRead::Unavailable("global_state_unreadable"));
        fs::write(&global, json!({ "projectless-thread-ids": [] }).to_string()).unwrap();
        assert!(matches!(read(&home), CodexRead::Available(_)));

        // A catalog database with no catalog table is schema drift; a corrupt one is not.
        let catalog = home.join("sqlite").join("codex-dev.db");
        fs::create_dir_all(catalog.parent().unwrap()).unwrap();
        Connection::open(&catalog).unwrap().execute_batch("CREATE TABLE other (id TEXT);").unwrap();
        assert!(matches!(read(&home), CodexRead::Available(_)));
        fs::write(&catalog, b"this is not a sqlite database, only synthetic text").unwrap();
        assert_eq!(read(&home), CodexRead::Unavailable("catalog_unreadable"));

        // A home that exists but cannot be listed (here: a plain file) is not an absent app.
        let not_a_directory = dir.path().join("codex-file");
        fs::write(&not_a_directory, b"synthetic").unwrap();
        assert_eq!(read(&not_a_directory), CodexRead::Unavailable("home_unreadable"));
    }

    #[test]
    fn a_locked_store_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codex");
        let conn = write_store(&home, false);
        conn.execute_batch("INSERT INTO projects VALUES ('p', 'P', 0);").unwrap();
        // An exclusive lock held by another connection blocks every reader past the busy timeout.
        conn.execute_batch("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;").unwrap();
        let started = std::time::Instant::now();
        assert!(matches!(read(&home), CodexRead::Unavailable(_)));
        assert!(started.elapsed() >= Duration::from_secs(4), "the reader waits for the busy timeout");
        conn.execute_batch("COMMIT;").unwrap();
    }
}
