//! App projects: the per-install catalog of projects the owner created in an
//! app, and which folders and sessions belong to them (spec sections 1.4,
//! 1.5, 2.2, 2.3).
//!
//! `resolve` reads the app stores and this install's state without writing
//! anything, so `observatory projects --apps` can print the same answer a run
//! would upload. `persist` then keeps the local memory a run needs (sticky
//! worktree resolutions, the projects seen so a vanished one becomes a
//! tombstone, and the Codex agent labels), and `records` turns the answer into
//! `project.catalog` and `project.membership` side records on the carrier
//! binding. No path, folder name, or thread title leaves the machine: only
//! keys the ledger already holds, unkeyed app-project digests, project names,
//! and resolution codes.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

use observatory_contract::{
    Adapter, AgentRole, Channel, MembershipKind, MembershipResolution, Nullable, Position, ProjectApp,
    ProjectCatalog, ProjectMembership, ProjectName, ProjectState, Provider, Record, RecordType, Sha256Hex,
    Stamp, Text, Uuid,
};
use serde_json::json;

use crate::adapter::{BindingContext, record_id};
use crate::codex_projects::{self, CodexRead, CodexStore, RootKey, ThreadResolution, longest_root};
use crate::cursor_store;
use crate::privacy::{app_project_key, cursor_session_hash};
use crate::pyjson::digest;
use crate::state::{AgentLabelRow, AppProjectSeenRow, MemberPathRow, State, StateError};
use crate::worktree::{self, WorktreeEnv, path_key};

/// The parser version every side record carries.
pub const SIDE_PARSER_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+sides1");

/// The binding every side record of this install rides on (section 1.2): the
/// smallest binding id the server has registered. Content never depends on it.
#[derive(Clone, Debug, PartialEq)]
pub struct Carrier {
    pub binding_id: Uuid,
    pub adapter: Adapter,
    pub observed_at: Stamp,
    pub parser_version: Text<0, 30>,
}

impl Carrier {
    /// The carrier among the server's bindings, or `None` when the install has none.
    pub fn choose(bindings: &[BindingContext], observed_at: Stamp) -> Option<Carrier> {
        let binding = bindings.iter().min_by(|a, b| a.binding_id.as_str().cmp(b.binding_id.as_str()))?;
        Some(Carrier {
            binding_id: binding.binding_id.clone(),
            adapter: execution_adapter(binding.provider),
            observed_at,
            parser_version: Text::truncated(SIDE_PARSER_VERSION).ok()?,
        })
    }

    /// `record_id(carrier, local_db, "<type>:<kind>:<key>")`.
    pub fn record_id(&self, record_type: RecordType, kind: &str, key: &str) -> Uuid {
        record_id(&self.binding_id, Channel::LocalDb, &format!("{}:{kind}:{key}", record_type.as_str()))
    }
}

/// The adapter a binding's own records come from.
pub fn execution_adapter(provider: Provider) -> Adapter {
    match provider {
        Provider::Claude => Adapter::ClaudeExecution,
        Provider::Codex => Adapter::CodexExecution,
        Provider::Cursor => Adapter::CursorExecution,
        Provider::AnthropicApi => Adapter::AnthropicApi,
        Provider::OpenaiApi => Adapter::OpenaiApi,
    }
}

/// One app project, active or a tombstone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogEntry {
    pub app: ProjectApp,
    pub app_project_id: String,
    pub project_key: Sha256Hex,
    pub name: String,
    pub name_truncated: bool,
    pub position: Option<u64>,
    pub state: ProjectState,
    pub roots: usize,
}

/// One membership: a folder key or a ledger session hash, and its project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Membership {
    pub member_kind: MembershipKind,
    pub member_key: Sha256Hex,
    pub project_key: Option<Sha256Hex>,
    pub resolution: MembershipResolution,
}

/// A readable label for a Cursor composer's session hash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionAgentLabel {
    pub session_hash: Sha256Hex,
    pub label: String,
    pub role: AgentRole,
    pub parent_key: Option<Sha256Hex>,
}

/// Counts `observatory projects --apps` prints; never a path.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Diagnostics {
    pub codex_threads: u64,
    /// Threads per project id.
    pub threads_by_project: BTreeMap<String, u64>,
    /// Threads per resolution.
    pub threads_by_resolution: BTreeMap<String, u64>,
    /// Explicit assignments whose folder resolves to the same project by the longest root.
    pub explicit_agree: u64,
    /// Explicit assignments whose folder resolves to another project.
    pub explicit_disagree: u64,
    /// Explicit assignments whose folder is under no root.
    pub explicit_outside_roots: u64,
    /// Spawned threads whose root ancestor has a project, and how many inherited it.
    pub subagents_with_project_root: u64,
    pub subagents_inherited: u64,
    /// Rollout files whose last `session_meta` names another thread (forked history).
    pub forked_rollouts: u64,
    /// Ledger sessions with no thread in the app store.
    pub sessions_without_thread: u64,
    /// Thread titles placed only by a root prefix (for `--samples`, never uploaded).
    #[serde(skip)]
    pub prefix_only_titles: Vec<String>,
}

/// Everything one resolution produced.
#[derive(Clone, Debug, Default)]
pub struct Resolution {
    pub catalog: Vec<CatalogEntry>,
    /// Every Codex store read successfully; the catalog is complete.
    pub catalog_complete: bool,
    /// `None` when a root source was unreadable: no folder memberships this run.
    pub folders: Option<Vec<Membership>>,
    pub sessions: Vec<Membership>,
    /// Every source of session memberships read successfully.
    pub sessions_complete: bool,
    /// Agent labels per Codex binding whose store was read.
    pub agent_labels: Vec<(String, Vec<AgentLabelRow>)>,
    pub session_agent_labels: Vec<SessionAgentLabel>,
    /// Every Cursor store read successfully.
    pub session_agent_labels_complete: bool,
    /// Why a source was unavailable, by source.
    pub unavailable: BTreeMap<String, &'static str>,
    pub new_member_paths: Vec<(String, String, String, MemberPathRow)>,
    pub seen: Vec<(String, String, AppProjectSeenRow)>,
    pub diagnostics: Diagnostics,
}

impl Resolution {
    /// The folder memberships, or none when their source was unreadable.
    pub fn folder_memberships(&self) -> &[Membership] {
        self.folders.as_deref().unwrap_or(&[])
    }
}

/// Resolves worktrees with the sticky cache: a cached main path is kept even
/// when the worktree is gone, and a new positive answer is cached. The cache is
/// keyed by the member whose own path is resolved, so callers must pass the key
/// of the folder or session that `path` belongs to, never another member's.
struct Worktrees<'a> {
    env: &'a WorktreeEnv,
    cache: HashMap<(String, String, String), MemberPathRow>,
    new_rows: Vec<(String, String, String, MemberPathRow)>,
    now: String,
}

impl Worktrees<'_> {
    fn main(&mut self, binding: &str, kind: &str, key: &str, path: &str) -> Option<String> {
        let cache_key = (binding.to_owned(), kind.to_owned(), key.to_owned());
        if let Some(row) = self.cache.get(&cache_key) {
            return Some(row.main_repo_path.clone());
        }
        let (main, by) = worktree::main_repo(path, self.env)?;
        let row = MemberPathRow {
            main_repo_path: main.clone(),
            resolved_by: by.as_str().to_owned(),
            resolved_at: self.now.clone(),
        };
        self.cache.insert(cache_key.clone(), row.clone());
        self.new_rows.push((cache_key.0, cache_key.1, cache_key.2, row));
        Some(main)
    }
}

/// Live project roots, each with the unkeyed key of its project. `keys[i]`
/// is the project key of `roots[i]`; a match maps back by index, so the same
/// root read under two accounts (two bindings sharing one Codex home) keeps
/// each account's own key.
#[derive(Clone, Debug, Default)]
struct Roots {
    roots: Vec<RootKey>,
    keys: Vec<Sha256Hex>,
}

impl Roots {
    fn push_store(&mut self, store: &CodexStore, account: &str) {
        for root in store.root_keys() {
            self.keys.push(app_project_key(ProjectApp::CodexDesktop.as_str(), account, &root.project_id));
            self.roots.push(root);
        }
    }

    fn of_store(store: &CodexStore, account: &str) -> Roots {
        let mut roots = Roots::default();
        roots.push_store(store, account);
        roots
    }

    /// The project key of the longest root containing `path`.
    fn project_of(&self, path: &str) -> Option<Sha256Hex> {
        let found = longest_root(&self.roots, &path_key(path))?;
        let index = self.roots.iter().position(|root| std::ptr::eq(root, found))?;
        self.keys.get(index).cloned()
    }
}

/// Folder resolution against the live roots: the main repository of a worktree
/// first (`worktree_root_prefix`), else the path itself (`root_prefix`).
fn resolve_folder(
    roots: &Roots,
    path: &str,
    main: Option<&str>,
) -> (MembershipResolution, Option<Sha256Hex>) {
    let find = |candidate: &str| roots.project_of(candidate);
    if let Some(main) = main
        && let Some(project) = find(main)
    {
        return (MembershipResolution::WorktreeRootPrefix, Some(project));
    }
    match find(path) {
        Some(project) => (MembershipResolution::RootPrefix, Some(project)),
        None => (MembershipResolution::OutsideRoots, None),
    }
}

fn codex_session_hash(account: &str, session: &str) -> String {
    digest(&json!([Provider::Codex.as_str(), account, session])).as_str().to_owned()
}

/// One Codex binding's store, read.
struct CodexSource<'a> {
    binding: &'a BindingContext,
    store: CodexStore,
}

/// Resolves every app project, membership, and agent label this install can
/// see now. Reads only: the state, the app stores, and the file system.
pub fn resolve(
    state: &State,
    bindings: &[BindingContext],
    env: &WorktreeEnv,
    now: &Stamp,
) -> Result<Resolution, StateError> {
    let mut out = Resolution {
        catalog_complete: true,
        sessions_complete: true,
        session_agent_labels_complete: true,
        ..Resolution::default()
    };
    let mut worktrees =
        Worktrees { env, cache: state.member_paths()?, new_rows: Vec::new(), now: now.as_str().to_owned() };

    // Codex stores, one per Codex binding, in binding order.
    let mut codex_bindings: Vec<&BindingContext> =
        bindings.iter().filter(|binding| binding.provider == Provider::Codex).collect();
    codex_bindings.sort_by(|a, b| a.binding_id.as_str().cmp(b.binding_id.as_str()));
    let mut sources = Vec::new();
    for binding in codex_bindings {
        let home = binding.codex_home.clone().or_else(crate::paths::codex_home);
        let read = match &home {
            Some(home) => codex_projects::read(home),
            None => CodexRead::Available(Box::default()),
        };
        match read {
            CodexRead::Available(store) => sources.push(CodexSource { binding, store: *store }),
            CodexRead::Unavailable(reason) => {
                out.unavailable.insert(format!("codex:{}", binding.binding_id), reason);
                out.catalog_complete = false;
                out.sessions_complete = false;
            }
        }
    }
    let roots_readable = out.catalog_complete;

    // Every live root of the install, each with the unkeyed key of its project, for
    // folders and Cursor workspaces. Codex threads use their own store's roots only.
    let mut install_roots = Roots::default();
    for source in &sources {
        install_roots.push_store(&source.store, source.binding.account_id.as_str());
    }

    // The catalog and its tombstones.
    for source in &sources {
        let account = source.binding.account_id.as_str();
        let app = ProjectApp::CodexDesktop.as_str();
        let mut present = HashSet::new();
        for project in &source.store.projects {
            present.insert(project.id.clone());
            let (name, name_truncated) = ProjectName::project_name(&project.name);
            let project_key = app_project_key(app, account, &project.id);
            out.catalog.push(CatalogEntry {
                app: ProjectApp::CodexDesktop,
                app_project_id: project.id.clone(),
                project_key: project_key.clone(),
                name: name.as_str().to_owned(),
                name_truncated,
                position: project.position.and_then(|value| u64::try_from(value).ok()),
                state: ProjectState::Active,
                roots: project.roots.len(),
            });
            out.seen.push((
                app.to_owned(),
                account.to_owned(),
                AppProjectSeenRow {
                    app_project_id: project.id.clone(),
                    project_key: project_key.as_str().to_owned(),
                    name: name.as_str().to_owned(),
                    position: project.position,
                    last_state: ProjectState::Active.as_str().to_owned(),
                },
            ));
        }
        for seen in state.app_projects_seen(app, account)? {
            if present.contains(&seen.app_project_id) {
                continue;
            }
            let Ok(project_key) = Sha256Hex::try_from(seen.project_key.clone()) else { continue };
            let (name, name_truncated) = ProjectName::project_name(&seen.name);
            out.catalog.push(CatalogEntry {
                app: ProjectApp::CodexDesktop,
                app_project_id: seen.app_project_id.clone(),
                project_key,
                name: name.as_str().to_owned(),
                name_truncated,
                position: seen.position.and_then(|value| u64::try_from(value).ok()),
                state: ProjectState::Removed,
                roots: 0,
            });
            out.seen.push((
                app.to_owned(),
                account.to_owned(),
                AppProjectSeenRow { last_state: ProjectState::Removed.as_str().to_owned(), ..seen },
            ));
        }
    }

    // Codex sessions: every ledger session hash, through its thread.
    for source in &sources {
        let binding_id = source.binding.binding_id.as_str();
        let account = source.binding.account_id.as_str();
        let store = &source.store;
        let project_key_of =
            |project_id: &str| app_project_key(ProjectApp::CodexDesktop.as_str(), account, project_id);
        let thread_by_hash: HashMap<String, &str> =
            store.threads.keys().map(|id| (codex_session_hash(account, id), id.as_str())).collect();
        let thread_by_rollout: HashMap<String, &str> = store
            .threads
            .values()
            .filter_map(|thread| Some((path_key(thread.rollout_path.as_deref()?), thread.id.as_str())))
            .collect();
        let mut file_thread_by_hash: HashMap<String, &str> = HashMap::new();
        for (path, session) in state.file_sessions(binding_id)? {
            let Some(session) = session else { continue };
            let Some(thread) = thread_by_rollout.get(&path_key(&path)).copied() else { continue };
            if thread != session {
                out.diagnostics.forked_rollouts += 1;
            }
            file_thread_by_hash.entry(codex_session_hash(account, &session)).or_insert(thread);
        }
        // This store's roots under this binding's account: another binding reading the same
        // home keys the same roots with its own account.
        let source_roots = Roots::of_store(store, account);
        // Resolve every thread once. The worktree cache is keyed by the thread whose cwd is
        // resolved, which for rule 4 is the root ancestor, not the thread asking.
        let mut thread_results: HashMap<String, ThreadResolution> = HashMap::new();
        let mut folder = |thread: &str, cwd: &str| {
            let hash = codex_session_hash(account, thread);
            let main = worktrees.main(binding_id, "session", &hash, cwd);
            let (resolution, project) = resolve_folder(&source_roots, cwd, main.as_deref());
            let project_id = project.and_then(|key| {
                store
                    .projects
                    .iter()
                    .find(|project| project_key_of(&project.id) == key)
                    .map(|project| project.id.clone())
            });
            project_id.map(|project_id| ThreadResolution { resolution, project_id: Some(project_id) })
        };
        for id in store.threads.keys() {
            if let Some(found) = store.resolve_thread(id, &mut folder) {
                thread_results.insert(id.clone(), found);
            }
        }
        collect_codex_diagnostics(store, &thread_results, &source_roots, account, &mut out.diagnostics);

        let sessions = state.session_agents(binding_id)?;
        let mut labels = Vec::new();
        for (hash, agents) in &sessions {
            let own = thread_by_hash.get(hash).copied();
            let thread = own.or_else(|| file_thread_by_hash.get(hash).copied());
            let Some(thread) = thread else {
                out.diagnostics.sessions_without_thread += 1;
                continue;
            };
            let Some(found) = thread_results.get(thread) else { continue };
            let Ok(member_key) = Sha256Hex::try_from(hash.clone()) else { continue };
            out.sessions.push(Membership {
                member_kind: MembershipKind::Session,
                member_key,
                project_key: found.project_id.as_deref().map(project_key_of),
                resolution: found.resolution,
            });
            // Labels come only from a thread whose own id is the ledger session.
            if own == Some(thread) && store.is_subagent(thread) {
                let label = store
                    .threads
                    .get(thread)
                    .and_then(|row| row.agent_role.clone())
                    .unwrap_or_else(|| "default".to_owned());
                for agent_key in &agents.agent_keys {
                    labels.push(AgentLabelRow {
                        agent_key: agent_key.clone(),
                        label: label.clone(),
                        role: Some(AgentRole::Subagent.as_str().to_owned()),
                        source: "codex_thread".to_owned(),
                    });
                }
            }
        }
        let labeled: HashSet<String> = labels.iter().map(|row| row.agent_key.clone()).collect();
        for (session_id, kind) in state.codex_session_sources(binding_id)? {
            if kind != "guardian" {
                continue;
            }
            let Some(agents) = sessions.get(&codex_session_hash(account, &session_id)) else { continue };
            for agent_key in agents.agent_keys.iter().filter(|key| !labeled.contains(*key)) {
                labels.push(AgentLabelRow {
                    agent_key: agent_key.clone(),
                    label: "guardian".to_owned(),
                    role: Some(AgentRole::Subagent.as_str().to_owned()),
                    source: "codex_guardian".to_owned(),
                });
            }
        }
        labels.sort_by(|a, b| a.agent_key.cmp(&b.agent_key));
        labels.dedup_by(|a, b| a.agent_key == b.agent_key);
        out.agent_labels.push((binding_id.to_owned(), labels));
    }

    // Folder memberships, once per install over every binding's folders.
    if roots_readable {
        let mut folders = Vec::new();
        let mut done = HashSet::new();
        for (binding, row) in state.all_projects()? {
            if !done.insert(row.project_hash.clone()) {
                continue;
            }
            let Ok(member_key) = Sha256Hex::try_from(row.project_hash.clone()) else { continue };
            let main = worktrees.main(&binding, "working_directory", &row.project_hash, &row.path);
            let (resolution, project_key) = resolve_folder(&install_roots, &row.path, main.as_deref());
            folders.push(Membership {
                member_kind: MembershipKind::WorkingDirectory,
                member_key,
                project_key,
                resolution,
            });
        }
        out.folders = Some(folders);
    }

    // Cursor composers with local requests.
    for binding in bindings.iter().filter(|binding| binding.provider == Provider::Cursor) {
        let binding_id = binding.binding_id.as_str();
        let sessions = state.record_session_counts(binding_id, Adapter::CursorExecution.as_str())?;
        if sessions.is_empty() {
            continue;
        }
        let Some(path) = binding.cursor_state_db.clone().or_else(crate::paths::cursor_state_db) else {
            continue;
        };
        let workspaces = match cursor_store::cursor_workspaces(&path) {
            Ok(workspaces) => workspaces,
            Err(_) => {
                out.unavailable.insert(format!("cursor:{binding_id}"), "store_unreadable");
                out.sessions_complete = false;
                out.session_agent_labels_complete = false;
                continue;
            }
        };
        let by_hash: HashMap<String, &cursor_store::CursorComposer> = workspaces
            .composers
            .values()
            .map(|composer| (cursor_session_hash(&composer.composer_id).as_str().to_owned(), composer))
            .collect();
        let folder_of = |composer_id: &str, worktrees: &mut Worktrees<'_>| {
            let hash = cursor_session_hash(composer_id);
            match workspaces.folder_of(composer_id) {
                None => (MembershipResolution::NoFolder, None),
                Some(folder) => {
                    let main = worktrees.main(binding_id, "session", hash.as_str(), folder);
                    resolve_folder(&install_roots, folder, main.as_deref())
                }
            }
        };
        for hash in sessions.keys() {
            let Some(composer) = by_hash.get(hash) else { continue };
            let Ok(member_key) = Sha256Hex::try_from(hash.clone()) else { continue };
            let (resolution, project_key, label) = match composer.parent_id.as_deref() {
                Some(parent) => {
                    let (_, parent_project) = folder_of(parent, &mut worktrees);
                    let label = SessionAgentLabel {
                        session_hash: member_key.clone(),
                        label: composer.subagent_type.clone().unwrap_or_else(|| "subagent".to_owned()),
                        role: AgentRole::Subagent,
                        parent_key: Some(cursor_session_hash(parent)),
                    };
                    match parent_project {
                        Some(project) => (MembershipResolution::Inherited, Some(project), label),
                        None => (MembershipResolution::OutsideRoots, None, label),
                    }
                }
                None => {
                    let (resolution, project) = folder_of(&composer.composer_id, &mut worktrees);
                    let label = SessionAgentLabel {
                        session_hash: member_key.clone(),
                        label: "main".to_owned(),
                        role: AgentRole::Main,
                        parent_key: None,
                    };
                    (resolution, project, label)
                }
            };
            out.session_agent_labels.push(label);
            // Folder-based answers need the roots; without them the previous records stand.
            if roots_readable {
                out.sessions.push(Membership {
                    member_kind: MembershipKind::Session,
                    member_key,
                    project_key,
                    resolution,
                });
            }
        }
    }
    out.new_member_paths = worktrees.new_rows;
    Ok(out)
}

fn collect_codex_diagnostics(
    store: &CodexStore,
    results: &HashMap<String, ThreadResolution>,
    roots: &Roots,
    account: &str,
    diagnostics: &mut Diagnostics,
) {
    let key_of = |id: &str| app_project_key(ProjectApp::CodexDesktop.as_str(), account, id);
    let project_of_key = |key: &Sha256Hex| {
        store.projects.iter().find(|project| key_of(&project.id) == *key).map(|project| project.id.clone())
    };
    for (id, thread) in &store.threads {
        diagnostics.codex_threads += 1;
        let Some(found) = results.get(id) else { continue };
        *diagnostics.threads_by_resolution.entry(found.resolution.as_str().to_owned()).or_default() += 1;
        if let Some(project) = &found.project_id {
            *diagnostics.threads_by_project.entry(project.clone()).or_default() += 1;
        }
        let explicit = thread.project_id.is_some()
            || store.assignments.contains_key(id)
            || store.catalog_projects.contains_key(id);
        if explicit && found.resolution == MembershipResolution::AppAssignment {
            let by_folder = thread.cwd.as_deref().and_then(|cwd| {
                let (_, key) = resolve_folder(roots, cwd, None);
                key.as_ref().and_then(project_of_key)
            });
            let agrees = by_folder.map(|project| Some(&project) == found.project_id.as_ref());
            match agrees {
                Some(true) => diagnostics.explicit_agree += 1,
                Some(false) => diagnostics.explicit_disagree += 1,
                None => diagnostics.explicit_outside_roots += 1,
            }
        }
        if let Some(root) = store.root_ancestor(id)
            && results.get(&root).is_some_and(|root| root.project_id.is_some())
        {
            diagnostics.subagents_with_project_root += 1;
            if found.resolution == MembershipResolution::Inherited {
                diagnostics.subagents_inherited += 1;
            }
        }
        let by_prefix = found.resolution == MembershipResolution::RootPrefix
            || found.resolution == MembershipResolution::WorktreeRootPrefix;
        if by_prefix
            && store.root_ancestor(id).is_none()
            && diagnostics.prefix_only_titles.len() < 20
            && let Some(title) = thread.title.clone()
        {
            diagnostics.prefix_only_titles.push(title.chars().take(80).collect());
        }
    }
}

/// Keeps what the next run needs: new sticky worktree resolutions, the app
/// projects seen, and the agent labels of every Codex store that was read.
pub fn persist(state: &State, resolution: &Resolution) -> Result<(), StateError> {
    for (binding, kind, key, row) in &resolution.new_member_paths {
        state.save_member_path(binding, kind, key, row)?;
    }
    for (app, account, row) in &resolution.seen {
        state.upsert_app_project_seen(app, account, row)?;
    }
    for (binding, rows) in &resolution.agent_labels {
        state.replace_agent_labels(binding, rows)?;
    }
    Ok(())
}

/// `project.catalog` and `project.membership` records on the carrier.
pub fn records(resolution: &Resolution, carrier: &Carrier) -> Vec<Record> {
    let mut out = Vec::new();
    let mut catalog_keys = HashSet::new();
    for entry in &resolution.catalog {
        if !catalog_keys.insert(entry.project_key.clone()) {
            continue;
        }
        let Ok(name) = ProjectName::try_from(entry.name.clone()) else { continue };
        out.push(Record::ProjectCatalog(ProjectCatalog {
            record_id: carrier.record_id(
                RecordType::ProjectCatalog,
                entry.app.as_str(),
                entry.project_key.as_str(),
            ),
            binding_id: carrier.binding_id.clone(),
            adapter: carrier.adapter,
            observed_at: carrier.observed_at.clone(),
            parser_version: carrier.parser_version.clone(),
            app: entry.app,
            project_key: entry.project_key.clone(),
            name,
            position: Nullable(entry.position.and_then(|value| Position::new(value).ok())),
            state: entry.state,
        }));
    }
    let mut member_keys = HashSet::new();
    for membership in resolution.folder_memberships().iter().chain(&resolution.sessions) {
        if !member_keys.insert((membership.member_kind, membership.member_key.clone())) {
            continue;
        }
        out.push(Record::ProjectMembership(ProjectMembership {
            record_id: carrier.record_id(
                RecordType::ProjectMembership,
                membership.member_kind.as_str(),
                membership.member_key.as_str(),
            ),
            binding_id: carrier.binding_id.clone(),
            adapter: carrier.adapter,
            observed_at: carrier.observed_at.clone(),
            parser_version: carrier.parser_version.clone(),
            member_kind: membership.member_kind,
            member_key: membership.member_key.clone(),
            project_key: Nullable(membership.project_key.clone()),
            resolution: membership.resolution,
        }));
    }
    out
}

/// The Codex homes a run's bindings read, for the worktree layouts.
pub fn codex_homes(bindings: &[BindingContext]) -> Vec<PathBuf> {
    let mut homes: Vec<PathBuf> = bindings
        .iter()
        .filter(|binding| binding.provider == Provider::Codex)
        .filter_map(|binding| binding.codex_home.clone().or_else(crate::paths::codex_home))
        .collect();
    homes.sort();
    homes.dedup();
    homes
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::str::FromStr;

    use observatory_contract::{AccountId, Uuid};
    use rusqlite::Connection;

    use super::*;
    use crate::adapter::IdentityState;
    use crate::state::EventRow;

    const CLAUDE: &str = "11111111-1111-4111-8111-111111111111";
    const CODEX: &str = "22222222-2222-4222-8222-222222222222";
    const CODEX_OTHER: &str = "33333333-3333-4333-8333-333333333333";

    fn binding(id: &str, provider: Provider, codex_home: Option<&Path>) -> BindingContext {
        let account = if provider == Provider::Codex { "codex-synthetic" } else { "claude-synthetic" };
        BindingContext {
            binding_id: Uuid::from_str(id).unwrap(),
            account_id: AccountId::from_str(account).unwrap(),
            provider,
            enabled: true,
            identity_hash: None,
            identity: IdentityState::Confirmed,
            identity_conflict: false,
            roots: Vec::new(),
            codex_home: codex_home.map(Path::to_path_buf),
            cursor_state_db: None,
        }
    }

    fn store(home: &Path, projects: &[(&str, &str, &str)]) {
        fs::create_dir_all(home).unwrap();
        let conn = Connection::open(home.join("state_5.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL,
               title TEXT NOT NULL, agent_role TEXT);
             DELETE FROM projects; DELETE FROM project_roots;",
        )
        .unwrap();
        for (index, (id, name, root)) in projects.iter().enumerate() {
            let position = index as i64;
            conn.execute("INSERT INTO projects VALUES (?1, ?2, ?3)", (id, name, position)).unwrap();
            conn.execute("INSERT INTO project_roots VALUES (?1, 0, ?2)", [id, root]).unwrap();
        }
    }

    fn event(session: &str) -> EventRow {
        EventRow {
            id: format!("event-{session}"),
            session: session.to_owned(),
            hour: "2026-09-02T02:00:00.000Z".into(),
            model: "m".into(),
            input_tokens: 1,
            cached_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: 1,
            session_identity: "provider".into(),
            timestamp: "2026-09-02T02:00:00Z".into(),
            product: "codex".into(),
            client_version: None,
            parent_session: None,
            project_hash: None,
            project_key: None,
            project_basis: "unknown".into(),
            surface: None,
            detail_observed: true,
            bucket_eligible: true,
            detail_input_fresh: None,
            detail_input_cached: None,
            detail_input_cache_write: None,
            detail_output: None,
            detail_reasoning: None,
            reported_total: None,
            model_requested: None,
            reasoning_effort: None,
            service_tier: None,
            speed: None,
            context_window_tokens: None,
            cache_write_ttl: None,
            outcome: None,
            agent_observed: true,
            agent_key: Some("a".repeat(64)),
            agent_identity_basis: "provider".into(),
            parent_agent_key: None,
            parent_agent_identity_basis: "none".into(),
            agent_class: "main".into(),
            agent_name: None,
            agent_depth: Some(0),
        }
    }

    fn now() -> Stamp {
        Stamp::parse("2026-09-12T00:00:00.000Z").unwrap()
    }

    /// A Claude binding and a Codex binding reading the Codex home given.
    fn both(home: &Path) -> Vec<BindingContext> {
        vec![binding(CLAUDE, Provider::Claude, None), binding(CODEX, Provider::Codex, Some(home))]
    }

    fn folder_key(fill: char) -> String {
        std::iter::repeat_n(fill, 64).collect()
    }

    fn codex_thread(home: &Path, id: &str, cwd: &str) {
        let conn = Connection::open(home.join("state_5.sqlite")).unwrap();
        conn.execute(
            "INSERT INTO threads (id, rollout_path, cwd, title) VALUES (?1, ?2, ?3, 'synthetic')",
            [id, &format!("/synthetic/rollouts/{id}.jsonl"), cwd],
        )
        .unwrap();
    }

    fn spawn_edge(home: &Path, parent: &str, child: &str) {
        let conn = Connection::open(home.join("state_5.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS thread_spawn_edges (parent_thread_id TEXT NOT NULL,
               child_thread_id TEXT PRIMARY KEY, status TEXT NOT NULL);",
        )
        .unwrap();
        conn.execute("INSERT INTO thread_spawn_edges VALUES (?1, ?2, 'done')", [parent, child]).unwrap();
    }

    fn session_of<'a>(resolution: &'a Resolution, session: &str) -> &'a Membership {
        resolution.sessions.iter().find(|member| member.member_key.as_str() == session).unwrap()
    }

    /// Spec test R9, two bindings: two Codex bindings reading one home each resolve
    /// root-prefix and inherited sessions to the project key of their own account.
    #[test]
    fn two_codex_bindings_on_one_home_each_resolve_under_their_own_account() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let home = dir.path().join("codex");
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        store(&home, &[("p1", "Synthetic", &work.to_string_lossy())]);
        let cwd = work.join("src").to_string_lossy().into_owned();
        codex_thread(&home, "thread-a", &cwd);
        codex_thread(&home, "thread-b", &cwd);
        codex_thread(&home, "thread-c", "/synthetic/elsewhere");
        spawn_edge(&home, "thread-b", "thread-c");
        let mut other = binding(CODEX_OTHER, Provider::Codex, Some(&home));
        other.account_id = AccountId::from_str("codex-other").unwrap();
        let bindings = vec![binding(CODEX, Provider::Codex, Some(&home)), other];
        let hash =
            |account: &str, thread: &str| digest(&json!(["codex", account, thread])).as_str().to_owned();
        let first_a = hash("codex-synthetic", "thread-a");
        let other_b = hash("codex-other", "thread-b");
        let other_c = hash("codex-other", "thread-c");
        state.insert_event(CODEX, &event(&first_a)).unwrap();
        state.insert_event(CODEX_OTHER, &event(&other_b)).unwrap();
        state.insert_event(CODEX_OTHER, &event(&other_c)).unwrap();

        let resolution = resolve(&state, &bindings, &WorktreeEnv::default(), &now()).unwrap();
        let own = Some(app_project_key("codex_desktop", "codex-synthetic", "p1"));
        let other_key = Some(app_project_key("codex_desktop", "codex-other", "p1"));
        let a = session_of(&resolution, &first_a);
        assert_eq!((a.resolution, &a.project_key), (MembershipResolution::RootPrefix, &own));
        let b = session_of(&resolution, &other_b);
        assert_eq!((b.resolution, &b.project_key), (MembershipResolution::RootPrefix, &other_key));
        let c = session_of(&resolution, &other_c);
        assert_eq!((c.resolution, &c.project_key), (MembershipResolution::Inherited, &other_key));
    }

    /// A child thread's cached worktree answer never stands in for its root
    /// ancestor's folder: rule 4 resolves the root's cwd under the root's own key.
    #[test]
    fn rule_four_resolves_the_root_cwd_with_the_root_cache_entry() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let home = dir.path().join("codex");
        let main = dir.path().join("repo-a");
        let gitdir = main.join(".git").join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let worktree = dir.path().join("elsewhere").join("wt");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.to_string_lossy())).unwrap();
        let root_b = dir.path().join("repo-b");
        fs::create_dir_all(&root_b).unwrap();
        store(
            &home,
            &[
                ("pa", "Synthetic A", &main.to_string_lossy()),
                ("pb", "Synthetic B", &root_b.to_string_lossy()),
            ],
        );
        codex_thread(&home, "thread-child", &worktree.to_string_lossy());
        codex_thread(&home, "thread-root", &root_b.join("src").to_string_lossy());
        let child = digest(&json!(["codex", "codex-synthetic", "thread-child"])).as_str().to_owned();
        state.insert_event(CODEX, &event(&child)).unwrap();
        let bindings = vec![binding(CODEX, Provider::Codex, Some(&home))];

        // Run 1: no spawn edge yet; the child resolves by its own worktree and caches it.
        let first = resolve(&state, &bindings, &WorktreeEnv::default(), &now()).unwrap();
        let project_a = Some(app_project_key("codex_desktop", "codex-synthetic", "pa"));
        let member = session_of(&first, &child);
        assert_eq!(
            (member.resolution, &member.project_key),
            (MembershipResolution::WorktreeRootPrefix, &project_a)
        );
        persist(&state, &first).unwrap();

        // Run 2: the edge appears; the child inherits the root's project, not its own cache.
        spawn_edge(&home, "thread-root", "thread-child");
        let second = resolve(&state, &bindings, &WorktreeEnv::default(), &now()).unwrap();
        let project_b = Some(app_project_key("codex_desktop", "codex-synthetic", "pb"));
        let member = session_of(&second, &child);
        assert_eq!((member.resolution, &member.project_key), (MembershipResolution::Inherited, &project_b));
    }

    /// Spec test R13: one folder seen by two bindings is one membership record.
    #[test]
    fn a_folder_two_bindings_share_is_one_membership_record() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let home = dir.path().join("codex");
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        store(&home, &[("p1", "Synthetic", &work.to_string_lossy())]);
        let folder = work.join("app").to_string_lossy().into_owned();
        state.upsert_project(CLAUDE, &folder_key('b'), &folder, "2026-09-02T00:00:00Z").unwrap();
        state.upsert_project(CODEX, &folder_key('b'), &folder, "2026-09-03T00:00:00Z").unwrap();
        let bindings = both(&home);
        let resolution = resolve(&state, &bindings, &WorktreeEnv::default(), &now()).unwrap();
        let folders = resolution.folders.as_ref().unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].resolution, MembershipResolution::RootPrefix);
        let carrier = Carrier::choose(&bindings, now()).unwrap();
        assert_eq!(carrier.binding_id.as_str(), CLAUDE, "the smallest binding id carries");
        let records = records(&resolution, &carrier);
        let memberships: Vec<_> =
            records.iter().filter(|record| matches!(record, Record::ProjectMembership(_))).collect();
        assert_eq!(memberships.len(), 1);
        // The same answer under the other carrier differs only in the header.
        let other = Carrier { binding_id: Uuid::from_str(CODEX).unwrap(), ..carrier.clone() };
        let again = super::records(&resolution, &other);
        let semantic: Vec<String> = records.iter().map(Record::semantic_key).collect();
        assert_eq!(semantic, again.iter().map(Record::semantic_key).collect::<Vec<_>>());
    }

    /// Spec test R10: a resolved worktree keeps its project after it is deleted,
    /// and an unreadable root source produces no folder memberships at all.
    #[test]
    fn worktree_resolutions_are_sticky_and_unreadable_roots_emit_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let home = dir.path().join("codex");
        let main = dir.path().join("main-repo");
        let gitdir = main.join(".git").join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let worktree = dir.path().join("elsewhere").join("wt");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.to_string_lossy())).unwrap();
        store(&home, &[("p1", "Synthetic", &main.to_string_lossy())]);
        let path = worktree.to_string_lossy().into_owned();
        state.upsert_project(CLAUDE, &folder_key('c'), &path, "2026-09-02T00:00:00Z").unwrap();
        let bindings = both(&home);
        let first = resolve(&state, &bindings, &WorktreeEnv::default(), &now()).unwrap();
        let expected = Some(app_project_key("codex_desktop", "codex-synthetic", "p1"));
        let member = &first.folders.as_ref().unwrap()[0];
        assert_eq!(member.resolution, MembershipResolution::WorktreeRootPrefix);
        assert_eq!(member.project_key, expected);
        assert_eq!(first.new_member_paths.len(), 1);
        persist(&state, &first).unwrap();

        fs::remove_dir_all(worktree).unwrap();
        let second = resolve(&state, &bindings, &WorktreeEnv::default(), &now()).unwrap();
        let member = &second.folders.as_ref().unwrap()[0];
        assert_eq!(member.resolution, MembershipResolution::WorktreeRootPrefix);
        assert_eq!(member.project_key, expected);
        assert!(second.new_member_paths.is_empty(), "served from the cache");

        // The root source becomes unreadable: nothing folder-based is produced, nothing downgraded.
        fs::write(home.join("state_5.sqlite"), b"not a database, only synthetic text here").unwrap();
        let third = resolve(&state, &bindings, &WorktreeEnv::default(), &now()).unwrap();
        assert!(third.folders.is_none());
        assert!(!third.catalog_complete && !third.sessions_complete);
        assert!(third.catalog.is_empty() && third.sessions.is_empty());
        let carrier = Carrier::choose(&bindings, now()).unwrap();
        assert!(records(&third, &carrier).is_empty(), "a locked or unreadable store yields zero records");
    }

    /// Spec test R11: the catalog key and session memberships do not depend on the privacy key.
    #[test]
    fn a_new_privacy_key_leaves_catalog_keys_and_session_memberships_alone() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let home = dir.path().join("codex");
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        store(&home, &[("p1", "Synthetic", &work.to_string_lossy())]);
        let conn = Connection::open(home.join("state_5.sqlite")).unwrap();
        conn.execute(
            "INSERT INTO threads (id, rollout_path, cwd, title) VALUES ('thread-1', '/r.jsonl', ?1, 't')",
            [work.to_string_lossy()],
        )
        .unwrap();
        drop(conn);
        let session = digest(&json!(["codex", "codex-synthetic", "thread-1"])).as_str().to_owned();
        state.insert_event(CODEX, &event(&session)).unwrap();
        let bindings = vec![binding(CODEX, Provider::Codex, Some(&home))];
        state.privacy_key().unwrap();
        let before = resolve(&state, &bindings, &WorktreeEnv::default(), &now()).unwrap();
        state.set_meta("privacy_salt", &crate::privacy::PrivacyKey::generate().to_hex()).unwrap();
        let after = resolve(&state, &bindings, &WorktreeEnv::default(), &now()).unwrap();
        assert_eq!(before.catalog, after.catalog);
        assert_eq!(before.sessions, after.sessions);
        assert_eq!(before.sessions.len(), 1);
        assert_eq!(before.sessions[0].member_key.as_str(), session);
        assert_eq!(before.catalog[0].project_key, app_project_key("codex_desktop", "codex-synthetic", "p1"));
    }

    #[test]
    fn a_project_missing_from_a_successful_read_becomes_a_tombstone() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let home = dir.path().join("codex");
        store(&home, &[("p1", "Kept", "/synthetic/kept"), ("p2", "  Gone\u{200B} ", "/synthetic/gone")]);
        let bindings = vec![binding(CODEX, Provider::Codex, Some(&home))];
        let first = resolve(&state, &bindings, &WorktreeEnv::default(), &now()).unwrap();
        assert_eq!(first.catalog.len(), 2);
        assert!(first.catalog.iter().any(|entry| entry.name == "Gone"), "normalized");
        persist(&state, &first).unwrap();
        store(&home, &[("p1", "Kept", "/synthetic/kept")]);
        let second = resolve(&state, &bindings, &WorktreeEnv::default(), &now()).unwrap();
        let gone = second.catalog.iter().find(|entry| entry.app_project_id == "p2").unwrap();
        assert_eq!((gone.state, gone.name.as_str()), (ProjectState::Removed, "Gone"));
        persist(&state, &second).unwrap();
        let third = resolve(&state, &bindings, &WorktreeEnv::default(), &now()).unwrap();
        assert!(third.catalog.iter().any(|entry| entry.state == ProjectState::Removed), "stays a tombstone");
    }
}
