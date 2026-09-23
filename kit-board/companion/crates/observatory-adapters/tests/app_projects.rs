//! Spec tests R3 to R6 over synthetic Codex rollouts and a synthetic Codex app
//! store: the frozen forked-rollout behaviour, the session membership join,
//! nested MCP calls, and the request tool summary. Every path, id and name here
//! is synthetic.

use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use jiff::Timestamp;
use observatory_adapters::codex_execution::CodexExecution;
use observatory_adapters::tools::ToolIndex;
use observatory_contract::settings::{DetailLevel, ToolDetail};
use observatory_contract::{
    AccountId, CollectionSettings, MembershipKind, MembershipResolution, Provider, Stamp, Uuid,
};
use observatory_core::adapter::{Adapter, BindingContext, IdentityState, MemorySink, RunContext};
use observatory_core::privacy::{PrivacyKey, app_project_key};
use observatory_core::projects;
use observatory_core::pyjson::digest;
use observatory_core::state::{ORIGIN_DIRECT, ORIGIN_NESTED_MCP, State, ToolEventRow};
use observatory_core::worktree::WorktreeEnv;
use rusqlite::Connection;
use serde_json::{Value, json};

const BINDING: &str = "33333333-3333-4333-8333-333333333333";
const ACCOUNT: &str = "codex-synthetic";
const PARENT: &str = "session-parent";
const CHILD: &str = "session-forked-child";

/// One rollout line.
fn line(ts: &str, kind: &str, payload: Value) -> String {
    format!("{}\n", json!({ "timestamp": ts, "type": kind, "payload": payload }))
}

fn meta(ts: &str, id: &str, source: Value, cwd: &str) -> String {
    let payload = json!({
        "id": id, "timestamp": ts, "cwd": cwd, "originator": "codex_cli_rs", "source": source
    });
    line(ts, "session_meta", payload)
}

fn turn(ts: &str, cwd: &str) -> String {
    line(ts, "turn_context", json!({ "model": "gpt-synthetic", "cwd": cwd }))
}

fn task(ts: &str) -> String {
    line(ts, "event_msg", json!({ "type": "task_started", "turn_id": "turn" }))
}

fn exec_call(ts: &str, call_id: &str) -> String {
    let payload = json!({
        "type": "custom_tool_call", "name": "exec", "call_id": call_id, "input": "synthetic script"
    });
    line(ts, "response_item", payload)
}

fn exec_output(ts: &str, call_id: &str) -> String {
    let payload = json!({
        "type": "custom_tool_call_output", "call_id": call_id, "output": "Process exited with code 0"
    });
    line(ts, "response_item", payload)
}

fn mcp(ts: &str, id: &str, server: &str, app: Option<&str>) -> String {
    let mut item = json!({
        "type": "McpToolCall", "id": id, "server": server, "tool": "synthetic_tool",
        "arguments": { "private": "never read" }, "status": "completed", "result": { "isError": false }
    });
    if let Some(app) = app {
        item["appName"] = json!(app);
        item["actionName"] = json!("synthetic_action");
    }
    line(ts, "event_msg", json!({ "type": "item_completed", "item": item }))
}

fn usage(total: i64) -> Value {
    json!({
        "input_tokens": total, "cached_input_tokens": 0, "output_tokens": 10, "total_tokens": total + 10
    })
}

fn tokens(ts: &str, total: i64) -> String {
    let info = json!({ "total_token_usage": usage(total), "last_token_usage": usage(total) });
    line(ts, "event_msg", json!({ "type": "token_count", "info": info }))
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    sessions: PathBuf,
    work: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let sessions = root.join("codex").join("sessions");
    let work = root.join("work").join("app");
    fs::create_dir_all(&sessions).unwrap();
    fs::create_dir_all(&work).unwrap();
    Fixture { _dir: dir, root, sessions, work }
}

fn write(path: &Path, lines: &[String]) {
    fs::write(path, lines.concat()).unwrap();
}

fn binding(fixture: &Fixture) -> BindingContext {
    BindingContext {
        binding_id: Uuid::from_str(BINDING).unwrap(),
        account_id: AccountId::from_str(ACCOUNT).unwrap(),
        provider: Provider::Codex,
        enabled: true,
        identity_hash: None,
        identity: IdentityState::Confirmed,
        identity_conflict: false,
        roots: vec![fixture.sessions.clone()],
        codex_home: Some(fixture.root.join("codex")),
        cursor_state_db: None,
    }
}

fn context(fixture: &Fixture, state_name: &str, include_subagents: bool) -> RunContext {
    let mut settings = CollectionSettings::defaults();
    settings.execution.detail_level = DetailLevel::RequestsWithTools;
    settings.execution.tool_detail = ToolDetail::HashedCustom;
    settings.execution.include_subagents = include_subagents;
    RunContext::new(
        Timestamp::from_str("2026-09-12T00:00:00Z").unwrap(),
        "2026-09-01".to_owned(),
        observatory_core::pyjson::epoch_text("2026-09-01T00:00:00Z").unwrap(),
        settings,
        3,
        None,
        vec![binding(fixture)],
        vec![],
        fixture.root.clone(),
        fixture.root.join(state_name),
        fixture.root.join("statusline"),
        true,
        Duration::from_secs(60),
        PrivacyKey::fixed_for_tests(),
    )
}

fn collect(ctx: &RunContext) -> Vec<Value> {
    let mut sink = MemorySink::default();
    CodexExecution.collect(ctx, None, &mut sink).unwrap();
    sink.records.iter().map(|emitted| serde_json::to_value(&emitted.record).unwrap()).collect()
}

fn of_type<'a>(records: &'a [Value], record_type: &str) -> Vec<&'a Value> {
    records.iter().filter(|record| record["record_type"] == record_type).collect()
}

fn resolve(state: &State, ctx: &RunContext) -> projects::Resolution {
    let now = Stamp::from_timestamp(ctx.now);
    projects::resolve(state, &ctx.bindings, &WorktreeEnv::default(), &now).unwrap()
}

fn session_hash(session: &str) -> String {
    digest(&json!(["codex", ACCOUNT, session])).as_str().to_owned()
}

fn invocation(provider_id: &str) -> String {
    digest(&json!(["tool", "codex", ACCOUNT, provider_id])).as_str().to_owned()
}

/// A parent rollout with one exec that makes one nested MCP call, and a forked
/// child rollout whose second `session_meta` is the parent's copied one.
fn write_rollouts(fixture: &Fixture, with_nested: bool) {
    let cwd = fixture.work.to_string_lossy().into_owned();
    let mut parent = vec![
        meta("2026-09-10T10:00:00Z", PARENT, json!("vscode"), &cwd),
        task("2026-09-10T10:00:01Z"),
        turn("2026-09-10T10:00:01Z", &cwd),
        exec_call("2026-09-10T10:00:02Z", "call-exec-1"),
    ];
    if with_nested {
        parent.push(mcp("2026-09-10T10:00:03Z", "call-nested-1", "synthetic_server", None));
        parent.push(mcp("2026-09-10T10:00:03Z", "call-nested-2", "codex_apps", Some("SyntheticApp")));
    }
    parent.push(exec_output("2026-09-10T10:00:04Z", "call-exec-1"));
    parent.push(tokens("2026-09-10T10:00:05Z", 100));
    write(&fixture.sessions.join("rollout-parent.jsonl"), &parent);

    let spawn = json!({ "subagent": { "thread_spawn": { "parent_thread_id": PARENT, "depth": 1 } } });
    let mut child = vec![
        meta("2026-09-10T11:00:00Z", CHILD, spawn, &cwd),
        meta("2026-09-10T10:00:00Z", PARENT, json!("vscode"), &cwd),
    ];
    if with_nested {
        // Copied parent history before the child's own activity starts: never re-emitted.
        child.push(exec_call("2026-09-10T10:00:02Z", "call-exec-1"));
        child.push(mcp("2026-09-10T10:00:03Z", "call-nested-copy", "synthetic_server", None));
        child.push(exec_output("2026-09-10T10:00:04Z", "call-exec-1"));
    }
    child.push(task("2026-09-10T11:00:01Z"));
    child.push(turn("2026-09-10T11:00:01Z", &cwd));
    child.push(tokens("2026-09-10T11:00:05Z", 300));
    write(&fixture.sessions.join("rollout-child.jsonl"), &child);
}

fn app_store(fixture: &Fixture) {
    let home = fixture.root.join("codex");
    let conn = Connection::open(home.join("state_5.sqlite")).unwrap();
    conn.execute_batch(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
         CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL);
         CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL,
           title TEXT NOT NULL, agent_role TEXT);
         CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT PRIMARY KEY,
           status TEXT NOT NULL);
         INSERT INTO projects VALUES ('project-synthetic', 'Synthetic Project', 0);",
    )
    .unwrap();
    let cwd = fixture.work.to_string_lossy().into_owned();
    conn.execute("INSERT INTO project_roots VALUES ('project-synthetic', 0, ?1)", [&cwd]).unwrap();
    for (id, file) in [(PARENT, "rollout-parent.jsonl"), (CHILD, "rollout-child.jsonl")] {
        // The scan records canonical paths (`/private/var` on macOS, `\\?\` on Windows).
        let rollout = fs::canonicalize(fixture.sessions.join(file)).unwrap();
        let rollout = rollout.to_string_lossy().into_owned();
        conn.execute(
            "INSERT INTO threads (id, rollout_path, cwd, title) VALUES (?1, ?2, ?3, 'synthetic')",
            [id, &rollout, &cwd],
        )
        .unwrap();
    }
    conn.execute("INSERT INTO thread_spawn_edges VALUES (?1, ?2, 'done')", [PARENT, CHILD]).unwrap();
}

/// Spec test R3: `session_meta` behaviour is frozen. A forked rollout ends on
/// the parent's copied id, and its request is keyed exactly as 2.1.0 keyed it.
#[test]
fn a_forked_rollout_keeps_the_second_session_meta_and_the_2_1_0_event_ids() {
    let fixture = fixture();
    write_rollouts(&fixture, true);
    let ctx = context(&fixture, "state.sqlite3", true);
    let records = collect(&ctx);
    let state = State::open(&ctx.state_path).unwrap();
    let sessions = state.file_sessions(BINDING).unwrap();
    let child = sessions.iter().find(|(path, _)| path.ends_with("rollout-child.jsonl")).unwrap();
    assert_eq!(child.1.as_deref(), Some(PARENT), "files.context.session is the second id");
    // 2.1.0: digest([provider, account, ctx.session, raw timestamp, cumulative usage]).
    let identity = json!(["codex", ACCOUNT, PARENT, "2026-09-10T11:00:05Z", usage(300)]);
    let expected = digest(&identity).as_str().to_owned();
    let requests = of_type(&records, "activity.request");
    assert!(requests.iter().any(|request| request["semantic_key"] == expected.as_str()));
    let child_request = requests.iter().find(|request| request["semantic_key"] == expected.as_str()).unwrap();
    assert_eq!(child_request["session_hash"], session_hash(PARENT).as_str());
    assert!(requests.iter().all(|request| request["session_hash"] != session_hash(CHILD).as_str()));
}

/// Spec test R4: session memberships come from ledger session hashes; a forked
/// child's requests land on the parent session they are recorded under.
#[test]
fn session_memberships_join_on_the_ledger_session_hash() {
    let fixture = fixture();
    write_rollouts(&fixture, false);
    app_store(&fixture);
    let ctx = context(&fixture, "state.sqlite3", true);
    let records = collect(&ctx);
    let state = State::open(&ctx.state_path).unwrap();
    let resolution = resolve(&state, &ctx);
    let sessions: Vec<_> =
        resolution.sessions.iter().filter(|member| member.member_kind == MembershipKind::Session).collect();
    assert_eq!(sessions.len(), 1, "one ledger session: the forked child's requests carry the parent's");
    let member = sessions[0];
    assert_eq!(member.member_key.as_str(), session_hash(PARENT));
    for request in of_type(&records, "activity.request") {
        assert_eq!(request["session_hash"], member.member_key.as_str());
    }
    assert_eq!(member.resolution, MembershipResolution::RootPrefix);
    assert_eq!(member.project_key, Some(app_project_key("codex_desktop", ACCOUNT, "project-synthetic")));
    // The child thread itself inherits, though no ledger session carries its id.
    assert_eq!(resolution.diagnostics.subagents_inherited, 1);
    assert_eq!(resolution.diagnostics.forked_rollouts, 1);
    // The folder the requests ran in is under the root too.
    let folders = resolution.folders.as_ref().unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].resolution, MembershipResolution::RootPrefix);
    // Forked children never get an agent label: their requests carry the parent's main agent.
    assert!(resolution.agent_labels.iter().all(|(_, rows)| rows.is_empty()));
}

fn tool_rows(state: &State) -> Vec<ToolEventRow> {
    state.tool_events(BINDING).unwrap()
}

/// Spec test R5: nested MCP calls.
#[test]
fn nested_mcp_calls_link_to_their_exec_and_leave_the_request_untouched() {
    let with = fixture();
    write_rollouts(&with, true);
    let ctx = context(&with, "state.sqlite3", true);
    let records = collect(&ctx);
    let state = State::open(&ctx.state_path).unwrap();
    let rows = tool_rows(&state);
    let nested: Vec<&ToolEventRow> = rows.iter().filter(|row| row.origin == ORIGIN_NESTED_MCP).collect();
    // Two nested calls in the parent, each an invocation and a result; the copied one is not re-emitted.
    assert_eq!(nested.len(), 4, "{nested:#?}");
    let exec = invocation("call-exec-1");
    let exec_row = rows.iter().find(|row| row.invocation_key == exec && row.event_kind == "invocation");
    let exec_row = exec_row.unwrap();
    for row in &nested {
        assert_eq!(row.parent_invocation_key.as_deref(), Some(exec.as_str()));
        assert_eq!(row.caller_request_key, exec_row.caller_request_key, "assigned at the same token_count");
        assert_eq!(row.caller_agent_key, exec_row.caller_agent_key);
        assert_eq!(row.class, "mcp");
    }
    assert!(exec_row.caller_request_key.is_some());
    let first = nested.iter().find(|row| row.invocation_key == invocation("nested:call-nested-1")).unwrap();
    assert_eq!(first.namespace.as_deref(), Some("synthetic_server"));
    assert_eq!(first.name.as_deref(), Some("synthetic_tool"));
    let app = nested.iter().find(|row| row.invocation_key == invocation("nested:call-nested-2")).unwrap();
    assert_eq!(app.namespace.as_deref(), Some("codex_apps:SyntheticApp"));
    assert_eq!(app.name.as_deref(), Some("synthetic_action"));
    assert!(nested.iter().any(|row| row.event_kind == "result" && row.outcome == "succeeded"));
    assert!(rows.iter().all(|row| row.invocation_key != invocation("nested:call-nested-copy")));
    // The tool.event records: nested, hashed, linked.
    let tool_records = of_type(&records, "tool.event");
    let nested_records: Vec<_> =
        tool_records.iter().filter(|record| record["parent_invocation_key"] == exec.as_str()).collect();
    assert_eq!(nested_records.len(), 4);
    for record in &nested_records {
        assert!(record["tool"]["name"].as_str().unwrap().starts_with("h:"));
        assert!(!record.to_string().contains("synthetic_tool") && !record.to_string().contains("never read"));
    }

    // The request records are byte-identical to the same history without nested items.
    let without = fixture();
    write_rollouts(&without, false);
    let plain_ctx = context(&without, "state.sqlite3", true);
    let plain = collect(&plain_ctx);
    let strip = |records: &[Value]| {
        let mut requests: Vec<Value> = of_type(records, "activity.request").into_iter().cloned().collect();
        requests.sort_by(|a, b| a["semantic_key"].as_str().cmp(&b["semantic_key"].as_str()));
        requests
    };
    let (a, b) = (strip(&records), strip(&plain));
    assert_eq!(a.len(), b.len());
    for (left, right) in a.iter().zip(&b) {
        assert_eq!(left["tool_calls"], right["tool_calls"]);
        assert_eq!(left["tools"], right["tools"]);
        assert_eq!(left, right);
    }
}

fn nested_count(lines: Vec<String>, include_subagents: bool) -> usize {
    let fixture = fixture();
    write(&fixture.sessions.join("rollout-gates.jsonl"), &lines);
    let ctx = context(&fixture, "state.sqlite3", include_subagents);
    collect(&ctx);
    let state = State::open(&ctx.state_path).unwrap();
    tool_rows(&state).iter().filter(|row| row.origin == ORIGIN_NESTED_MCP).count()
}

#[test]
fn nested_mcp_calls_need_exactly_one_open_exec_and_every_gate() {
    let start = |id: &str, source: Value| {
        vec![meta("2026-09-10T10:00:00Z", id, source, "/synthetic/work"), task("2026-09-10T10:00:01Z")]
    };
    let with = |mut head: Vec<String>, body: Vec<String>| {
        head.extend(body);
        head
    };
    // Baseline: one exec open emits an invocation and a result.
    let one = with(
        start("s-one", json!("vscode")),
        vec![exec_call("2026-09-10T10:00:02Z", "e1"), mcp("2026-09-10T10:00:03Z", "n1", "srv", None)],
    );
    assert_eq!(nested_count(one, true), 2);
    // No exec open.
    let none = with(start("s-none", json!("vscode")), vec![mcp("2026-09-10T10:00:03Z", "n1", "srv", None)]);
    assert_eq!(nested_count(none, true), 0);
    // Two execs open.
    let two = with(
        start("s-two", json!("vscode")),
        vec![
            exec_call("2026-09-10T10:00:02Z", "e1"),
            exec_call("2026-09-10T10:00:02Z", "e2"),
            mcp("2026-09-10T10:00:03Z", "n1", "srv", None),
        ],
    );
    assert_eq!(nested_count(two, true), 0);
    // A closed exec is no longer open.
    let closed = with(
        start("s-closed", json!("vscode")),
        vec![
            exec_call("2026-09-10T10:00:02Z", "e1"),
            exec_output("2026-09-10T10:00:02Z", "e1"),
            mcp("2026-09-10T10:00:03Z", "n1", "srv", None),
        ],
    );
    assert_eq!(nested_count(closed, true), 0);
    // own_started: no task has started in this file yet.
    let not_started = vec![
        meta("2026-09-10T10:00:00Z", "s-idle", json!("vscode"), "/synthetic/work"),
        exec_call("2026-09-10T10:00:02Z", "e1"),
        mcp("2026-09-10T10:00:03Z", "n1", "srv", None),
    ];
    assert_eq!(nested_count(not_started, true), 0);
    // The window: before the backfill start.
    let early = with(
        start("s-early", json!("vscode")),
        vec![exec_call("2026-09-10T10:00:02Z", "e1"), mcp("2026-08-01T10:00:03Z", "n1", "srv", None)],
    );
    assert_eq!(nested_count(early, true), 0);
    // include_subagents off keeps a subagent file's nested calls home.
    let spawn = json!({
        "subagent": { "thread_spawn": { "parent_thread_id": "s-parent", "agent_role": "worker" } }
    });
    let subagent = with(
        start("s-sub", spawn),
        vec![exec_call("2026-09-10T10:00:02Z", "e1"), mcp("2026-09-10T10:00:03Z", "n1", "srv", None)],
    );
    assert_eq!(nested_count(subagent.clone(), false), 0);
    assert_eq!(nested_count(subagent, true), 2);
}

/// Spec test R6: a request's tool summary counts direct calls only, including
/// a direct call that carries a parent (Claude `parent_tool_use_id`).
#[test]
fn the_request_summary_ignores_nested_calls_but_keeps_parented_direct_ones() {
    let row = |id: u64, origin: &str, parent: Option<&str>| ToolEventRow {
        id: format!("{id:064x}"),
        timestamp: "2026-09-10T10:00:00Z".into(),
        event_kind: "invocation".into(),
        invocation_key: format!("{id:064x}"),
        session_hash: None,
        caller_request_key: Some("request".into()),
        caller_agent_key: None,
        caller_is_subagent: false,
        parent_invocation_key: parent.map(str::to_owned),
        class: "builtin".into(),
        name: Some("Read".into()),
        name_hash: None,
        namespace: None,
        namespace_hash: None,
        outcome: "succeeded".into(),
        name_truncated: false,
        origin: origin.into(),
    };
    let parent = format!("{:064x}", 99);
    let rows = vec![
        row(1, ORIGIN_DIRECT, None),
        row(2, ORIGIN_DIRECT, Some(&parent)),
        row(3, ORIGIN_NESTED_MCP, Some(&parent)),
    ];
    let (total, tools) = ToolIndex::new(&rows).request_summary("request", true, ToolDetail::BuiltinOnly);
    assert_eq!(total.as_ref().map(|count| count.get()), Some(2));
    assert_eq!(tools.unwrap()[0].calls.get(), 2);
}

#[test]
fn a_guardian_session_meta_is_recorded_beside_its_session() {
    let fixture = fixture();
    let source = json!({ "subagent": { "other": "guardian" } });
    let lines = vec![
        meta("2026-09-10T10:00:00Z", "s-guardian", source, "/synthetic"),
        task("2026-09-10T10:00:01Z"),
        tokens("2026-09-10T10:00:05Z", 50),
    ];
    write(&fixture.sessions.join("rollout-guardian.jsonl"), &lines);
    let ctx = context(&fixture, "state.sqlite3", true);
    collect(&ctx);
    let state = State::open(&ctx.state_path).unwrap();
    assert_eq!(
        state.codex_session_sources(BINDING).unwrap(),
        vec![("s-guardian".to_owned(), "guardian".to_owned())]
    );
    // No app store here: the session has no thread, and the label still comes from the source.
    let resolution = resolve(&state, &ctx);
    let labels: Vec<_> = resolution.agent_labels.iter().flat_map(|(_, rows)| rows.iter()).collect();
    assert_eq!(labels.len(), 1);
    assert_eq!((labels[0].label.as_str(), labels[0].role.as_deref()), ("guardian", Some("subagent")));
}
