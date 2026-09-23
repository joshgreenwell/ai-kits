use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::process::ExitCode;

use jiff::Timestamp;
use observatory_contract::{Adapter, MembershipKind, ProjectState, Provider, Record, Sha256Hex, Stamp};
use observatory_core::config::CompanionConfig;
use observatory_core::labels;
use observatory_core::projects::{self, Carrier, Membership, Resolution};
use observatory_core::run::{RunOptions, prepare};
use observatory_core::state::State;
use observatory_core::worktree::WorktreeEnv;
use serde_json::{Value, json};

use super::{CommandResult, print_json};
use crate::cli::ProjectsArgs;

pub fn projects(dir: &Path, args: ProjectsArgs) -> CommandResult {
    if args.apps { apps(dir, args.samples) } else { folders(dir) }
}

/// The working directories each binding has seen, with the project hash the
/// Observatory receives when `execution.project_attribution` is `hashed`. This is
/// the only place a path and its hash appear together: the listing is printed on
/// this machine so the operator can label a hash on the server. Nothing here is
/// uploaded, and the privacy key the hashes are computed under is not shown.
fn folders(dir: &Path) -> CommandResult {
    let config = CompanionConfig::load(dir)?;
    let state = State::open(&config.state_path(dir))?;
    // Creating the key re-keys a listing left by a build without one; the key itself stays unread.
    state.privacy_key()?;
    let mut bindings = Vec::new();
    for binding in &config.bindings {
        let projects: Vec<_> = state
            .projects(&binding.binding_id.to_string())?
            .into_iter()
            .map(|row| {
                json!({ "project_hash": row.project_hash, "path": row.path,
                    "first_seen": row.first_seen, "last_seen": row.last_seen })
            })
            .collect();
        bindings.push(json!({ "binding_id": binding.binding_id, "account_id": binding.account_id,
            "provider": binding.provider, "projects": projects }));
    }
    print_json(&json!({
        "ok": true,
        "attribution": "hmac_sha256(privacy_key, [\"project\", cwd])",
        "bindings": bindings,
    }));
    Ok(ExitCode::SUCCESS)
}

/// Requests per code, or per project key.
type Counts = BTreeMap<String, u64>;

/// Requests counted by resolution code, with the project they land in.
#[derive(Default)]
struct Tally {
    by_resolution: Counts,
    in_project: u64,
    total: u64,
}

impl Tally {
    /// Counts requests under a code; those in a project also count toward it.
    fn add(&mut self, code: &str, project: Option<&Sha256Hex>, requests: u64, per_project: &mut Counts) {
        *self.by_resolution.entry(code.to_owned()).or_default() += requests;
        self.total += requests;
        if let Some(project) = project {
            self.in_project += requests;
            *per_project.entry(project.as_str().to_owned()).or_default() += requests;
        }
    }

    /// Counts requests under a membership's resolution and project.
    fn member(&mut self, member: &Membership, requests: u64, per_project: &mut Counts) {
        self.add(member.resolution.as_str(), member.project_key.as_ref(), requests, per_project);
    }

    fn json(&self) -> Value {
        json!({ "total": self.total, "in_project": self.in_project, "by_resolution": self.by_resolution })
    }
}

/// How app projects, folders, and sessions resolve on this machine, as counts
/// (spec section 9.1). Reads the app stores and this install's state; stores
/// nothing and prints no path. `--samples` adds a few thread titles the owner
/// can look up in the Codex sidebar.
fn apps(dir: &Path, samples: bool) -> CommandResult {
    let options = RunOptions { dry_run: true, fetch_config: false, ..RunOptions::default() };
    let prepared = prepare(dir, &options, false)?;
    let ctx = &prepared.ctx;
    let state = State::open(&ctx.state_path)?;
    let now = Stamp::from_timestamp(Timestamp::now());
    let env = WorktreeEnv::current(projects::codex_homes(&ctx.bindings));
    let resolution = projects::resolve(&state, &ctx.bindings, &env, &now)?;

    let folder_of: HashMap<&str, &Membership> =
        resolution.folder_memberships().iter().map(|m| (m.member_key.as_str(), m)).collect();
    let session_of: HashMap<&str, &Membership> = resolution
        .sessions
        .iter()
        .filter(|m| m.member_kind == MembershipKind::Session)
        .map(|m| (m.member_key.as_str(), m))
        .collect();
    let mut per_project = Counts::new();
    let (mut codex, mut claude, mut cursor) = (Tally::default(), Tally::default(), Tally::default());
    let (mut agreements, mut disagreements) = (0u64, 0u64);
    let (mut codex_session_members, mut cursor_session_members) = (0u64, 0u64);
    for binding in &ctx.bindings {
        let id = binding.binding_id.as_str();
        match binding.provider {
            Provider::Codex => {
                for (session, folder, requests) in state.session_project_counts(id)? {
                    let by_folder = folder.as_deref().and_then(|key| folder_of.get(key).copied());
                    let Some(member) = session_of.get(session.as_str()) else {
                        match by_folder {
                            Some(member) => {
                                let code = format!("folder:{}", member.resolution.as_str());
                                codex.add(&code, member.project_key.as_ref(), requests, &mut per_project);
                            }
                            None => codex.add("no_membership", None, requests, &mut per_project),
                        }
                        continue;
                    };
                    codex.member(member, requests, &mut per_project);
                    // Session first against the folder, wherever the folder names a project.
                    if let Some(by_folder) = by_folder.filter(|folder| folder.project_key.is_some()) {
                        if by_folder.project_key == member.project_key {
                            agreements += requests;
                        } else {
                            disagreements += requests;
                        }
                    }
                }
                let sessions = state.session_agents(id)?;
                let members = sessions.keys().filter(|session| session_of.contains_key(session.as_str()));
                codex_session_members += members.count() as u64;
            }
            Provider::Claude => {
                for (folder, requests) in state.project_request_counts(id)? {
                    match folder.as_deref().and_then(|key| folder_of.get(key).copied()) {
                        Some(member) => claude.member(member, requests, &mut per_project),
                        None if folder.is_none() => {
                            claude.add("no_folder_evidence", None, requests, &mut per_project)
                        }
                        None => claude.add("no_membership", None, requests, &mut per_project),
                    }
                }
            }
            Provider::Cursor => {
                let adapter = Adapter::CursorExecution.as_str();
                for (session, requests) in state.record_session_counts(id, adapter)? {
                    match session_of.get(session.as_str()) {
                        Some(member) => {
                            cursor_session_members += 1;
                            cursor.member(member, requests, &mut per_project);
                        }
                        None => cursor.add("unmatched_session", None, requests, &mut per_project),
                    }
                }
            }
            Provider::AnthropicApi | Provider::OpenaiApi => {}
        }
    }
    let diagnostics = &resolution.diagnostics;
    let mut project_rows = Vec::new();
    for entry in &resolution.catalog {
        let threads = diagnostics.threads_by_project.get(&entry.app_project_id).copied().unwrap_or(0);
        let requests = per_project.get(entry.project_key.as_str()).copied().unwrap_or(0);
        project_rows.push(json!({
            "name": entry.name,
            "state": entry.state,
            "roots": entry.roots,
            "threads": threads,
            "requests": requests,
        }));
    }
    let labels = match Carrier::choose(&ctx.bindings, now.clone()) {
        Some(carrier) => {
            let built = labels::build(&state, &carrier, &ctx.privacy_key, &resolution.session_agent_labels)?;
            let mut by_kind = Counts::new();
            for record in &built.records {
                if let Record::NameLabel(label) = record {
                    *by_kind.entry(label.kind.as_str().to_owned()).or_default() += 1;
                }
            }
            json!({ "total": built.records.len(), "by_kind": by_kind,
                "truncated": built.truncated, "dropped": built.dropped })
        }
        None => Value::Null,
    };
    let active = resolution.catalog.iter().filter(|entry| entry.state == ProjectState::Active).count();
    let removed = resolution.catalog.len() - active;
    let side = side_counts(&resolution, codex_session_members, cursor_session_members, labels);
    let mut report = json!({
        "ok": true,
        "sources_unavailable": resolution.unavailable,
        "projects": project_rows,
        "projects_active": active,
        "projects_removed": removed,
        "requests": { "codex": codex.json(), "claude": claude.json(), "cursor": cursor.json() },
        "codex_session_vs_folder": { "agree": agreements, "disagree": disagreements },
        "threads": {
            "total": diagnostics.codex_threads,
            "by_resolution": diagnostics.threads_by_resolution,
            "explicit_assignments": {
                "agree_with_longest_root": diagnostics.explicit_agree,
                "disagree": diagnostics.explicit_disagree,
                "outside_roots": diagnostics.explicit_outside_roots,
            },
            "subagents_with_project_root": diagnostics.subagents_with_project_root,
            "subagents_inherited": diagnostics.subagents_inherited,
        },
        "forked_rollouts": diagnostics.forked_rollouts,
        "ledger_sessions_without_thread": diagnostics.sessions_without_thread,
        "side_records": side,
    });
    if samples {
        let titles = &diagnostics.prefix_only_titles;
        report["samples"] = json!({ "threads_placed_by_root_prefix": titles });
    }
    print_json(&report);
    Ok(ExitCode::SUCCESS)
}

fn side_counts(resolution: &Resolution, codex_sessions: u64, cursor_sessions: u64, labels: Value) -> Value {
    let agent_labels: usize = resolution.agent_labels.iter().map(|(_, rows)| rows.len()).sum();
    json!({
        "project_catalog": resolution.catalog.len(),
        "codex_session_memberships": codex_sessions,
        "cursor_session_memberships": cursor_sessions,
        "folder_memberships": resolution.folders.as_ref().map(Vec::len),
        "name_labels": labels,
        "agent_labels": agent_labels,
        "session_agent_labels": resolution.session_agent_labels.len(),
    })
}
