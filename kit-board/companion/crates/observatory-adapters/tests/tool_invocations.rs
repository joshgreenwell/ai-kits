//! Synthetic tool-call coverage for supported Claude and Codex local histories.

use std::collections::HashSet;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use jiff::Timestamp;
use observatory_adapters::claude_execution::ClaudeExecution;
use observatory_adapters::codex_execution::CodexExecution;
use observatory_contract::settings::{DetailLevel, ToolDetail};
use observatory_contract::{
    AccountId, CapabilityDimension, CapabilityState, CollectionSettings, Provider, Uuid,
};
use observatory_core::adapter::{Adapter, BindingContext, IdentityState, MemorySink, RunContext};
use observatory_core::state::State;
use serde_json::Value;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/usage-v2/tool-detail")
}

fn binding(id: &str, provider: Provider, account: &str, root: PathBuf) -> BindingContext {
    BindingContext {
        binding_id: Uuid::from_str(id).unwrap(),
        account_id: AccountId::from_str(account).unwrap(),
        provider,
        enabled: true,
        identity_hash: None,
        identity: IdentityState::Confirmed,
        identity_conflict: false,
        roots: vec![root],
        codex_home: None,
        cursor_state_db: None,
    }
}

fn context(
    dir: &tempfile::TempDir,
    provider: Provider,
    id: &str,
    account: &str,
    root: PathBuf,
    detail_level: DetailLevel,
    tool_detail: ToolDetail,
) -> RunContext {
    let mut settings = CollectionSettings::defaults();
    settings.execution.detail_level = detail_level;
    settings.execution.tool_detail = tool_detail;
    RunContext::new(
        Timestamp::from_str("2026-09-12T00:00:00Z").unwrap(),
        "2026-09-01".to_owned(),
        observatory_core::pyjson::epoch_text("2026-09-01T00:00:00Z").unwrap(),
        settings,
        3,
        None,
        vec![binding(id, provider, account, root)],
        vec![],
        dir.path().to_path_buf(),
        dir.path().join("state.sqlite3"),
        dir.path().join("statusline"),
        true,
        Duration::from_secs(60),
    )
}

fn records(sink: &MemorySink, record_type: &str) -> Vec<Value> {
    let mut values: Vec<_> = sink
        .records
        .iter()
        .filter_map(|emitted| {
            let value = serde_json::to_value(&emitted.record).unwrap();
            (value["record_type"] == record_type).then_some(value)
        })
        .collect();
    values.sort_by(|left, right| {
        left["observed_at"]
            .as_str()
            .cmp(&right["observed_at"].as_str())
            .then_with(|| left["record_id"].as_str().cmp(&right["record_id"].as_str()))
    });
    values
}

fn capability(
    outcome: &observatory_core::adapter::Outcome,
    dimension: CapabilityDimension,
) -> (CapabilityState, Option<String>) {
    let capability = outcome
        .capabilities
        .as_ref()
        .unwrap()
        .iter()
        .find(|capability| capability.dimension == dimension)
        .unwrap();
    (capability.state, capability.detail_code.as_ref().map(|code| code.as_str().to_owned()))
}

fn assert_valid_and_private(records: &[Value], now: Timestamp) {
    for value in records {
        let record: observatory_contract::Record = serde_json::from_value(value.clone()).unwrap();
        let mut violations = Vec::new();
        record.validate(now, "record", &mut violations);
        assert!(violations.is_empty(), "{violations:?}");
        let wire = value.to_string();
        for private in [
            "private_formatter",
            "obsidian",
            "synthetic read",
            "synthetic failure",
            "permission request denied",
            "nested-looking",
        ] {
            assert!(!wire.contains(private), "tool record leaked {private:?}: {wire}");
        }
    }
}

#[test]
fn claude_collects_tool_only_calls_results_outcomes_and_policy_safe_names() {
    let dir = tempfile::tempdir().unwrap();
    let id = "11111111-1111-4111-8111-111111111111";
    let mut ctx = context(
        &dir,
        Provider::Claude,
        id,
        "claude-primary",
        corpus().join("claude/projects"),
        DetailLevel::RequestsWithTools,
        ToolDetail::BuiltinOnly,
    );
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let requests = records(&sink, "activity.request");
    let tools = records(&sink, "tool.event");
    assert_valid_and_private(&requests, ctx.now);
    assert_valid_and_private(&tools, ctx.now);
    assert_eq!(requests.len(), 1, "the tool-only assistant line must still retain its calls");
    assert_eq!(requests[0]["tool_calls"], 3);
    assert_eq!(requests[0]["tools"].as_array().unwrap().len(), 1);
    assert_eq!(requests[0]["tools"][0]["name"], "Read");
    assert_eq!(tools.iter().filter(|row| row["event_kind"] == "invocation").count(), 5);
    assert_eq!(tools.iter().filter(|row| row["event_kind"] == "result").count(), 3);
    let invocation_keys: HashSet<_> = tools
        .iter()
        .filter(|row| row["event_kind"] == "invocation")
        .map(|row| row["invocation_key"].as_str().unwrap())
        .collect();
    assert_eq!(invocation_keys.len(), 5, "duplicate results and wrapper contents do not add calls");
    let named = |name: &str| {
        tools.iter().find(|row| row["event_kind"] == "invocation" && row["tool"]["name"] == name).unwrap()
    };
    assert_eq!(named("Read")["outcome"], "succeeded");
    assert_eq!(named("Bash")["outcome"], "unknown");
    assert_eq!(
        tools.iter().find(|row| row["event_kind"] == "invocation" && row["tool"]["class"] == "mcp").unwrap()
            ["outcome"],
        "failed"
    );
    assert_eq!(
        tools
            .iter()
            .find(|row| {
                row["event_kind"] == "invocation"
                    && row["tool"]["class"] == "custom"
                    && row["outcome"] == "denied"
            })
            .unwrap()["tool"]["name"],
        Value::Null
    );
    assert_eq!(
        capability(&outcome, CapabilityDimension::Tool),
        (CapabilityState::Partial, Some("tool_names_truncated".into()))
    );

    let ids: Vec<_> = tools.iter().map(|row| row["record_id"].clone()).collect();
    let mut replay = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut replay).unwrap();
    assert_eq!(
        records(&replay, "tool.event").iter().map(|row| row["record_id"].clone()).collect::<Vec<_>>(),
        ids
    );

    ctx.settings.execution.tool_detail = ToolDetail::HashedCustom;
    let mut hashed = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut hashed).unwrap();
    let hashed_tools = records(&hashed, "tool.event");
    assert_valid_and_private(&hashed_tools, ctx.now);
    assert!(hashed_tools.iter().any(|row| {
        row["tool"]["class"] == "mcp"
            && row["tool"]["name"].as_str().is_some_and(|name| name.starts_with("h:"))
            && row["tool"]["namespace"].as_str().is_some_and(|name| name.starts_with("h:"))
    }));
    let hashed_request = &records(&hashed, "activity.request")[0];
    assert_eq!(hashed_request["tool_calls"], 3);
    assert_eq!(hashed_request["tools"].as_array().unwrap().len(), 3);

    ctx.settings.execution.tool_detail = ToolDetail::Off;
    let mut unnamed = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut unnamed).unwrap();
    assert!(
        records(&unnamed, "tool.event")
            .iter()
            .all(|row| { row["tool"]["name"].is_null() && row["tool"]["namespace"].is_null() })
    );
    let unnamed_request = &records(&unnamed, "activity.request")[0];
    assert_eq!(unnamed_request["tool_calls"], 3);
    assert!(unnamed_request.get("tools").is_none());

    ctx.settings.execution.detail_level = DetailLevel::Requests;
    let mut request_only = MemorySink::default();
    let request_only_outcome = ClaudeExecution.collect(&ctx, None, &mut request_only).unwrap();
    assert!(records(&request_only, "tool.event").is_empty());
    assert!(records(&request_only, "activity.request")[0]["tool_calls"].is_null());
    assert_eq!(
        capability(&request_only_outcome, CapabilityDimension::Tool),
        (CapabilityState::DisabledBySetting, Some("detail_level_without_tools".into()))
    );
}

#[test]
fn codex_joins_calls_to_accounting_without_inventing_missing_results() {
    let dir = tempfile::tempdir().unwrap();
    let id = "22222222-2222-4222-8222-222222222222";
    let ctx = context(
        &dir,
        Provider::Codex,
        id,
        "codex-primary",
        corpus().join("codex/sessions"),
        DetailLevel::RequestsWithTools,
        ToolDetail::BuiltinOnly,
    );
    let mut sink = MemorySink::default();
    let outcome = CodexExecution.collect(&ctx, None, &mut sink).unwrap();
    let requests = records(&sink, "activity.request");
    let tools = records(&sink, "tool.event");
    assert_valid_and_private(&requests, ctx.now);
    assert_valid_and_private(&tools, ctx.now);
    assert_eq!(tools.iter().filter(|row| row["event_kind"] == "invocation").count(), 5);
    assert_eq!(tools.iter().filter(|row| row["event_kind"] == "result").count(), 3);
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0]["tool_calls"], 3);
    assert_eq!(requests[0]["tools"].as_array().unwrap().len(), 2);
    assert_eq!(requests[0]["tools"][0]["name"], "exec");
    assert_eq!(requests[0]["tools"][1]["name"], "shell_command");
    assert_eq!(requests[1]["tool_calls"], 1);
    assert_eq!(requests[1]["tools"][0]["name"], "web_search");
    assert_eq!(requests[2]["tool_calls"], 0);
    assert!(requests[2].get("tools").is_none());

    let invocations: Vec<_> = tools.iter().filter(|row| row["event_kind"] == "invocation").collect();
    let named = |name: &str| invocations.iter().find(|row| row["tool"]["name"] == name).unwrap();
    assert_eq!(named("shell_command")["outcome"], "failed");
    assert_eq!(named("exec")["outcome"], "denied");
    assert_eq!(named("web_search")["outcome"], "succeeded");
    assert_eq!(named("view_image")["outcome"], "unknown");
    assert!(named("view_image")["caller_request_key"].is_null());
    assert_eq!(invocations.iter().find(|row| row["tool"]["class"] == "mcp").unwrap()["outcome"], "unknown");
    assert_eq!(
        capability(&outcome, CapabilityDimension::Tool),
        (CapabilityState::Partial, Some("unmapped_tool_forms".into()))
    );

    let state = State::open(&ctx.state_path).unwrap();
    assert_eq!(state.tool_events(id).unwrap().iter().filter(|row| row.event_kind == "invocation").count(), 5);
    drop(state);
    let state_bytes = std::fs::read(&ctx.state_path).unwrap();
    for private in ["nested-looking", "rejected by user", "Final output"] {
        assert!(
            !state_bytes.windows(private.len()).any(|window| window == private.as_bytes()),
            "arguments and results must not be retained"
        );
    }

    let ids: Vec<_> = tools.iter().map(|row| row["record_id"].clone()).collect();
    let mut replay = MemorySink::default();
    CodexExecution.collect(&ctx, None, &mut replay).unwrap();
    assert_eq!(
        records(&replay, "tool.event").iter().map(|row| row["record_id"].clone()).collect::<Vec<_>>(),
        ids
    );
}

#[test]
fn claude_orphan_results_keep_explicit_child_attribution() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("orphan-result.jsonl"),
        concat!(
            r#"{"type":"user","timestamp":"2026-09-04T02:00:00.000Z","sessionId":"claude-orphan","agentId":"child","isSidechain":true,"message":{"content":[{"type":"tool_result","tool_use_id":"older-call","is_error":false,"content":"synthetic output"}]}}"#,
            "\n"
        ),
    )
    .unwrap();
    let id = "33333333-3333-4333-8333-333333333333";
    let mut ctx = context(
        &dir,
        Provider::Claude,
        id,
        "claude-primary",
        root,
        DetailLevel::RequestsWithTools,
        ToolDetail::BuiltinOnly,
    );
    ctx.settings.execution.include_subagents = false;

    let mut excluded = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut excluded).unwrap();
    assert!(records(&excluded, "tool.event").is_empty());
    let state = State::open(&ctx.state_path).unwrap();
    let stored = state.tool_events(id).unwrap();
    assert_eq!(stored.len(), 1);
    assert!(stored[0].caller_is_subagent);
    drop(state);

    ctx.settings.execution.include_subagents = true;
    let mut included = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut included).unwrap();
    let emitted = records(&included, "tool.event");
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0]["event_kind"], "result");
    assert_eq!(emitted[0]["outcome"], "succeeded");
}

#[test]
fn codex_forks_do_not_claim_copied_parent_tool_history_in_either_scan_order() {
    let parent = concat!(
        r#"{"timestamp":"2026-09-04T03:00:00.000Z","type":"session_meta","payload":{"id":"parent","timestamp":"2026-09-04T03:00:00.000Z","originator":"codex_cli_rs"}}"#,
        "\n",
        r#"{"timestamp":"2026-09-04T03:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"parent-turn"}}"#,
        "\n",
        r#"{"timestamp":"2026-09-04T03:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"shared-parent-call"}}"#,
        "\n"
    );
    let child = concat!(
        r#"{"timestamp":"2026-09-04T04:00:00.000Z","type":"session_meta","payload":{"id":"child","timestamp":"2026-09-04T04:00:00.000Z","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent","depth":1}}}}}"#,
        "\n",
        r#"{"timestamp":"2026-09-04T03:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"parent-turn"}}"#,
        "\n",
        r#"{"timestamp":"2026-09-04T03:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"shared-parent-call"}}"#,
        "\n",
        r#"{"timestamp":"2026-09-04T04:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"child-turn"}}"#,
        "\n",
        r#"{"timestamp":"2026-09-04T04:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"view_image","call_id":"child-call"}}"#,
        "\n"
    );

    for child_first in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("history");
        std::fs::create_dir_all(&root).unwrap();
        let (parent_name, child_name) = if child_first {
            ("z-parent.jsonl", "a-child.jsonl")
        } else {
            ("a-parent.jsonl", "z-child.jsonl")
        };
        std::fs::write(root.join(parent_name), parent).unwrap();
        std::fs::write(root.join(child_name), child).unwrap();
        let id = "44444444-4444-4444-8444-444444444444";
        let mut ctx = context(
            &dir,
            Provider::Codex,
            id,
            "codex-primary",
            root,
            DetailLevel::RequestsWithTools,
            ToolDetail::BuiltinOnly,
        );
        ctx.settings.execution.include_subagents = true;

        let mut all = MemorySink::default();
        CodexExecution.collect(&ctx, None, &mut all).unwrap();
        let state = State::open(&ctx.state_path).unwrap();
        let invocations: Vec<_> =
            state.tool_events(id).unwrap().into_iter().filter(|row| row.event_kind == "invocation").collect();
        assert_eq!(invocations.len(), 2, "scan order child_first={child_first}");
        let shared = invocations.iter().find(|row| row.name.as_deref() == Some("exec_command")).unwrap();
        let child_call = invocations.iter().find(|row| row.name.as_deref() == Some("view_image")).unwrap();
        assert!(!shared.caller_is_subagent, "scan order child_first={child_first}");
        assert!(child_call.caller_is_subagent, "scan order child_first={child_first}");
        drop(state);

        ctx.settings.execution.include_subagents = false;
        let mut main_only = MemorySink::default();
        CodexExecution.collect(&ctx, None, &mut main_only).unwrap();
        let emitted = records(&main_only, "tool.event");
        assert_eq!(emitted.len(), 1, "scan order child_first={child_first}");
        assert_eq!(emitted[0]["tool"]["name"], "exec_command");
    }
}
