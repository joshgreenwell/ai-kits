//! Synthetic lineage coverage for supported Claude and Codex local histories.

use std::collections::HashSet;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use jiff::Timestamp;
use observatory_adapters::agents::agent_key;
use observatory_adapters::claude_execution::ClaudeExecution;
use observatory_adapters::codex_execution::CodexExecution;
use observatory_contract::settings::{DetailLevel, ToolDetail};
use observatory_contract::{
    AccountId, CapabilityDimension, CapabilityState, CollectionSettings, Provider, Uuid,
};
use observatory_core::adapter::{Adapter, BindingContext, IdentityState, MemorySink, RunContext};
use observatory_core::privacy::{PrivacyKey, agent_name_hash};
use serde_json::Value;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/usage-v2/agent-detail")
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
    include_subagents: bool,
) -> RunContext {
    let mut settings = CollectionSettings::defaults();
    settings.execution.detail_level = DetailLevel::Requests;
    settings.execution.include_subagents = include_subagents;
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
        PrivacyKey::fixed_for_tests(),
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

fn capability_state(
    outcome: &observatory_core::adapter::Outcome,
    dimension: CapabilityDimension,
) -> CapabilityState {
    outcome
        .capabilities
        .as_ref()
        .unwrap()
        .iter()
        .find(|capability| capability.dimension == dimension)
        .unwrap()
        .state
}

fn token_total(record: &Value) -> u64 {
    ["input_fresh", "input_cached", "input_cache_write", "output"]
        .into_iter()
        .filter_map(|field| record["tokens"][field].as_u64())
        .sum()
}

fn assert_valid_and_private(records: &[Value], now: Timestamp) {
    for value in records {
        let record: observatory_contract::Record = serde_json::from_value(value.clone()).unwrap();
        let mut violations = Vec::new();
        record.validate(now, "record", &mut violations);
        assert!(violations.is_empty(), "{violations:?}");
        assert!(!value.to_string().contains("PRIVATE SENTINEL"));
    }
}

#[test]
fn claude_collects_nested_inline_resumed_and_failed_agent_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    let account = "claude-primary";
    let mut ctx = context(&dir, Provider::Claude, id, account, corpus().join("claude/projects"), true);
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let requests = records(&sink, "activity.request");
    let events = records(&sink, "agent.event");
    assert_valid_and_private(&requests, ctx.now);
    assert_valid_and_private(&events, ctx.now);

    assert_eq!(requests.len(), 8);
    assert_eq!(events.iter().filter(|event| event["event_kind"] == "spawn").count(), 3);
    let starts: Vec<_> = events.iter().filter(|event| event["event_kind"] == "start").collect();
    assert_eq!(starts.len(), 4);
    let distinct_children: HashSet<_> =
        starts.iter().map(|event| event["agent"]["key"].as_str().unwrap()).collect();
    assert_eq!(distinct_children.len(), 4);

    let main_key = agent_key(Provider::Claude, account, "claude-main");
    let child_key = agent_key(Provider::Claude, account, "child");
    let nested_key = agent_key(Provider::Claude, account, "nested");
    let inline_key = agent_key(Provider::Claude, account, "inline");
    let inline_nested_key = agent_key(Provider::Claude, account, "inline-nested");
    let child_requests: Vec<_> =
        requests.iter().filter(|request| request["agent"]["key"] == child_key).collect();
    assert_eq!(child_requests.len(), 2, "a resumed child keeps one identity across requests");
    for request in &child_requests {
        assert_eq!(request["agent"]["class"], "builtin");
        assert_eq!(request["agent"]["name"], "Explore");
        assert_eq!(request["agent"]["parent_key"], main_key);
        assert_eq!(request["agent"]["depth"], 1);
        assert_eq!(request["model_requested"], "claude-child-requested");
        assert_eq!(request["model_actual"], "claude-child-actual");
    }
    let nested = requests.iter().find(|request| request["agent"]["key"] == nested_key).unwrap();
    assert_eq!(nested["agent"]["class"], "custom");
    assert_eq!(nested["agent"]["name"], Value::Null);
    assert_eq!(nested["agent"]["parent_key"], child_key);
    assert_eq!(nested["agent"]["depth"], 2);
    assert_eq!(nested["model_requested"], "claude-nested-requested");
    assert_eq!(nested["model_actual"], "claude-nested-actual");
    let inline = requests.iter().find(|request| request["agent"]["key"] == inline_key).unwrap();
    assert_eq!(inline["agent"]["class"], "builtin");
    assert_eq!(inline["agent"]["parent_key"], main_key);
    assert_eq!(inline["agent"]["depth"], 1);
    let inline_nested = requests.iter().find(|request| request["agent"]["key"] == inline_nested_key).unwrap();
    assert_eq!(inline_nested["agent"]["class"], "builtin");
    assert_eq!(inline_nested["agent"]["name"], "Plan");
    assert_eq!(inline_nested["agent"]["parent_key"], child_key);
    assert_eq!(inline_nested["agent"]["depth"], 2);

    let failed = events.iter().find(|event| event["outcome"] == "failed").unwrap();
    assert_eq!(failed["event_kind"], "spawn");
    assert_eq!(failed["agent"]["key"], Value::Null);
    assert_eq!(failed["agent"]["class"], "custom");
    assert_eq!(failed["agent"]["parent_key"], main_key);
    let all_tokens: u64 = requests.iter().map(token_total).sum();
    let child_tokens: u64 =
        requests.iter().filter(|request| request["agent"]["class"] != "main").map(token_total).sum();
    let main_tokens: u64 =
        requests.iter().filter(|request| request["agent"]["class"] == "main").map(token_total).sum();
    assert_eq!((all_tokens, main_tokens, child_tokens), (65, 26, 39));
    assert_eq!(all_tokens, main_tokens + child_tokens);
    assert_eq!(capability_state(&outcome, CapabilityDimension::Agent), CapabilityState::Complete);

    ctx.settings.execution.tool_detail = ToolDetail::HashedCustom;
    let mut replay = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut replay).unwrap();
    let hashed = records(&replay, "activity.request")
        .into_iter()
        .find(|request| request["agent"]["key"] == nested_key)
        .unwrap();
    assert_eq!(hashed["agent"]["name"], agent_name_hash(&ctx.privacy_key, "private-reviewer"));
    assert_ne!(
        hashed["agent"]["name"],
        agent_name_hash(&PrivacyKey::from_bytes([0x33; 32]), "private-reviewer"),
        "another install hashes the same role name differently"
    );
}

#[test]
fn claude_subagent_setting_excludes_child_requests_and_lifecycle_records() {
    let dir = tempfile::tempdir().unwrap();
    let id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    let mut ctx =
        context(&dir, Provider::Claude, id, "claude-primary", corpus().join("claude/projects"), false);
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let requests = records(&sink, "activity.request");
    assert_eq!(requests.len(), 3);
    assert!(requests.iter().all(|request| request["agent"]["class"] == "main"));
    assert_eq!(requests.iter().map(token_total).sum::<u64>(), 26);
    assert!(records(&sink, "agent.event").is_empty());
    assert_eq!(capability_state(&outcome, CapabilityDimension::Agent), CapabilityState::DisabledBySetting);

    ctx.settings.execution.include_subagents = true;
    let mut enabled = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut enabled).unwrap();
    assert_eq!(records(&enabled, "activity.request").len(), 8);
    assert_eq!(records(&enabled, "agent.event").len(), 7);

    ctx.settings.execution.include_subagents = false;
    let mut disabled_again = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut disabled_again).unwrap();
    assert_eq!(records(&disabled_again, "activity.request").len(), 3);
    assert!(records(&disabled_again, "agent.event").is_empty());
}

#[test]
fn claude_replays_an_unchanged_transcript_when_sidecar_evidence_appears() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    let child_dir = root.join("late-session/subagents");
    std::fs::create_dir_all(&child_dir).unwrap();
    let transcript = child_dir.join("agent-late.jsonl");
    std::fs::write(
        &transcript,
        concat!(
            r#"{"type":"assistant","timestamp":"2026-09-03T01:10:00.000Z","sessionId":"late-session","agentId":"late","isSidechain":true,"message":{"id":"late-request","model":"late-model","usage":{"input_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[]}}"#,
            "\n"
        ),
    )
    .unwrap();
    let id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let ctx = context(&dir, Provider::Claude, id, "claude-primary", root, true);

    let mut first = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut first).unwrap();
    let first_request = records(&first, "activity.request").pop().unwrap();
    assert_eq!(first_request["agent"]["class"], "unknown");
    assert_eq!(first_request["agent"]["depth"], Value::Null);

    std::fs::write(
        child_dir.join("agent-late.meta.json"),
        r#"{"agentType":"Explore","toolUseId":"late-tool","spawnDepth":1}"#,
    )
    .unwrap();
    let mut second = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut second).unwrap();
    let second_request = records(&second, "activity.request").pop().unwrap();
    assert_eq!(second_request["agent"]["class"], "builtin");
    assert_eq!(second_request["agent"]["name"], "Explore");
    assert_eq!(second_request["agent"]["depth"], 1);
    assert_eq!(records(&second, "agent.event").len(), 2);
}

#[test]
fn claude_late_spawn_attempt_enriches_an_already_observed_child() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    let child_dir = root.join("late-session/subagents");
    std::fs::create_dir_all(&child_dir).unwrap();
    std::fs::write(
        child_dir.join("agent-child.jsonl"),
        concat!(
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:00.000Z","sessionId":"late-session","agentId":"child","isSidechain":true,"message":{"id":"child-request","model":"actual-child","usage":{"input_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[]}}"#,
            "\n"
        ),
    )
    .unwrap();
    std::fs::write(
        child_dir.join("agent-child.meta.json"),
        r#"{"agentType":"Explore","toolUseId":"late-tool","spawnDepth":1}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("z-parent.jsonl"),
        concat!(
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:01.000Z","sessionId":"late-session","message":{"id":"parent-request","model":"parent-model","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[{"type":"tool_use","id":"late-tool","name":"Agent","input":{"subagent_type":"Explore","model":"requested-child"}}]}}"#,
            "\n"
        ),
    )
    .unwrap();
    let ctx =
        context(&dir, Provider::Claude, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "claude-primary", root, true);

    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let child = records(&sink, "activity.request")
        .into_iter()
        .find(|request| request["agent"]["key"] == agent_key(Provider::Claude, "claude-primary", "child"))
        .unwrap();
    assert_eq!(child["model_requested"], "requested-child");
}

#[test]
fn claude_late_explicit_spawn_replaces_a_different_structural_parent() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    let child_dir = root.join("root-session/subagents");
    std::fs::create_dir_all(&child_dir).unwrap();
    std::fs::write(
        child_dir.join("agent-grandchild.jsonl"),
        concat!(
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:00.000Z","sessionId":"root-session","agentId":"grandchild","isSidechain":true,"message":{"id":"grandchild-request","model":"grandchild-model","usage":{"input_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[]}}"#,
            "\n"
        ),
    )
    .unwrap();
    std::fs::write(
        child_dir.join("agent-grandchild.meta.json"),
        r#"{"agentType":"Plan","toolUseId":"late-nested-tool","spawnDepth":1}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("z-parent.jsonl"),
        concat!(
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:01.000Z","sessionId":"root-session","agentId":"parent-child","isSidechain":true,"attributionAgent":"Explore","message":{"id":"parent-observed","model":"parent-model","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[]}}"#,
            "\n",
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:02.000Z","sessionId":"root-session","agentId":"parent-child","isSidechain":true,"attributionAgent":"Explore","message":{"id":"parent-spawn","model":"parent-model","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[{"type":"tool_use","id":"late-nested-tool","name":"Agent","input":{"subagent_type":"Plan","model":"grandchild-requested"}}]}}"#,
            "\n"
        ),
    )
    .unwrap();
    let account = "claude-primary";
    let ctx = context(&dir, Provider::Claude, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", account, root, true);

    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let grandchild_key = agent_key(Provider::Claude, account, "grandchild");
    let parent_key = agent_key(Provider::Claude, account, "parent-child");
    let grandchild = records(&sink, "activity.request")
        .into_iter()
        .find(|request| request["agent"]["key"] == grandchild_key)
        .unwrap();
    assert_eq!(grandchild["agent"]["parent_key"], parent_key);
    assert_eq!(grandchild["agent"]["depth"], 1);
    assert_eq!(grandchild["model_requested"], "grandchild-requested");
}

#[test]
fn claude_explicit_spawn_parent_replaces_an_earlier_session_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("a-inline.jsonl"),
        concat!(
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:00.000Z","sessionId":"root-session","agentId":"nested","isSidechain":true,"attributionAgent":"Plan","message":{"id":"nested-request","model":"nested-model","usage":{"input_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[]}}"#,
            "\n"
        ),
    )
    .unwrap();
    std::fs::write(
        root.join("z-parent.jsonl"),
        concat!(
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:01.000Z","sessionId":"root-session","agentId":"parent-child","isSidechain":true,"attributionAgent":"Explore","message":{"id":"parent-observed","model":"parent-model","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[]}}"#,
            "\n",
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:02.000Z","sessionId":"root-session","agentId":"parent-child","isSidechain":true,"attributionAgent":"Explore","message":{"id":"parent-spawn","model":"parent-model","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[{"type":"tool_use","id":"nested-tool","name":"Agent","input":{"subagent_type":"Plan","model":"nested-requested"}}]}}"#,
            "\n",
            r#"{"type":"user","timestamp":"2026-09-03T01:00:03.000Z","sessionId":"root-session","agentId":"parent-child","message":{"content":[{"type":"tool_result","tool_use_id":"nested-tool","content":"done"}]},"toolUseResult":{"status":"completed","agentId":"nested"}}"#,
            "\n"
        ),
    )
    .unwrap();
    let account = "claude-primary";
    let ctx = context(&dir, Provider::Claude, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", account, root, true);

    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let nested_key = agent_key(Provider::Claude, account, "nested");
    let parent_key = agent_key(Provider::Claude, account, "parent-child");
    let nested = records(&sink, "activity.request")
        .into_iter()
        .find(|request| request["agent"]["key"] == nested_key)
        .unwrap();
    assert_eq!(nested["agent"]["parent_key"], parent_key);
    assert_eq!(nested["agent"]["depth"], 2);
    assert_eq!(nested["model_requested"], "nested-requested");
    let started = records(&sink, "agent.event")
        .into_iter()
        .find(|event| event["event_kind"] == "start" && event["agent"]["key"] == nested_key)
        .unwrap();
    assert_eq!(started["agent"]["parent_key"], parent_key);
    assert_eq!(started["agent"]["depth"], 2);
}

#[test]
fn claude_unmatched_result_preserves_its_explicit_parent() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("a-inline.jsonl"),
        concat!(
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:00.000Z","sessionId":"root-session","agentId":"nested","isSidechain":true,"attributionAgent":"Plan","message":{"id":"nested-request","model":"nested-model","usage":{"input_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[]}}"#,
            "\n"
        ),
    )
    .unwrap();
    std::fs::write(
        root.join("z-result.jsonl"),
        concat!(
            r#"{"type":"user","timestamp":"2026-09-03T01:00:01.000Z","sessionId":"root-session","agentId":"parent-child","message":{"content":[{"type":"tool_result","tool_use_id":"missing-tool","content":"done"}]},"toolUseResult":{"status":"completed","agentId":"nested"}}"#,
            "\n"
        ),
    )
    .unwrap();
    let account = "claude-primary";
    let ctx = context(&dir, Provider::Claude, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", account, root, true);

    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let nested_key = agent_key(Provider::Claude, account, "nested");
    let parent_key = agent_key(Provider::Claude, account, "parent-child");
    let nested = records(&sink, "activity.request")
        .into_iter()
        .find(|request| request["agent"]["key"] == nested_key)
        .unwrap();
    assert_eq!(nested["agent"]["parent_key"], parent_key);
    assert_eq!(nested["agent"]["depth"], Value::Null);
}

#[test]
fn claude_child_file_identity_owns_nested_spawns_when_lines_omit_agent_ids() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    let child_dir = root.join("root-session/subagents");
    std::fs::create_dir_all(&child_dir).unwrap();
    std::fs::write(
        child_dir.join("agent-parent-child.meta.json"),
        r#"{"agentType":"Explore","spawnDepth":1}"#,
    )
    .unwrap();
    std::fs::write(
        child_dir.join("agent-parent-child.jsonl"),
        concat!(
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:00.000Z","sessionId":"root-session","isSidechain":true,"message":{"id":"parent-spawn","model":"parent-model","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[{"type":"tool_use","id":"nested-tool","name":"Agent","input":{"subagent_type":"Plan","model":"nested-requested"}}]}}"#,
            "\n",
            r#"{"type":"user","timestamp":"2026-09-03T01:00:01.000Z","sessionId":"root-session","isSidechain":true,"message":{"content":[{"type":"tool_result","tool_use_id":"nested-tool","content":"done"}]},"toolUseResult":{"status":"completed","agentId":"nested"}}"#,
            "\n"
        ),
    )
    .unwrap();
    let account = "claude-primary";
    let ctx = context(&dir, Provider::Claude, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", account, root, true);

    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let nested_key = agent_key(Provider::Claude, account, "nested");
    let parent_key = agent_key(Provider::Claude, account, "parent-child");
    let spawn = records(&sink, "agent.event")
        .into_iter()
        .find(|event| event["event_kind"] == "spawn" && event["agent"]["key"] == nested_key)
        .unwrap();
    assert_eq!(spawn["agent"]["parent_key"], parent_key);
    assert_eq!(spawn["agent"]["depth"], 2);
    assert_eq!(spawn["agent"]["class"], "builtin");
    assert_eq!(spawn["agent"]["name"], "Plan");
}

#[test]
fn claude_nested_spawn_resolves_parent_depth_after_the_parents_first_request() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("inline.jsonl"),
        concat!(
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:00.000Z","sessionId":"root-session","agentId":"parent-child","isSidechain":true,"attributionAgent":"Explore","message":{"id":"parent-spawn","model":"parent-model","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[{"type":"tool_use","id":"nested-tool","name":"Agent","input":{"subagent_type":"Plan"}}]}}"#,
            "\n",
            r#"{"type":"user","timestamp":"2026-09-03T01:00:01.000Z","sessionId":"root-session","agentId":"parent-child","message":{"content":[{"type":"tool_result","tool_use_id":"nested-tool","content":"done"}]},"toolUseResult":{"status":"completed","agentId":"nested"}}"#,
            "\n",
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:02.000Z","sessionId":"root-session","agentId":"nested","isSidechain":true,"attributionAgent":"Plan","message":{"id":"nested-request","model":"nested-model","usage":{"input_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[]}}"#,
            "\n"
        ),
    )
    .unwrap();
    let account = "claude-primary";
    let ctx = context(&dir, Provider::Claude, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", account, root, true);

    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let nested_key = agent_key(Provider::Claude, account, "nested");
    let nested = records(&sink, "activity.request")
        .into_iter()
        .find(|request| request["agent"]["key"] == nested_key)
        .unwrap();
    assert_eq!(nested["agent"]["depth"], 2);
    let spawn = records(&sink, "agent.event")
        .into_iter()
        .find(|event| event["event_kind"] == "spawn" && event["agent"]["key"] == nested_key)
        .unwrap();
    assert_eq!(spawn["agent"]["depth"], 2);
}

#[test]
fn claude_disabled_subagents_preserve_fully_unknown_requests() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("unknown.jsonl"),
        concat!(
            r#"{"type":"assistant","timestamp":"2026-09-03T01:00:00.000Z","message":{"id":"unknown-request","model":"unknown-model","usage":{"input_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[]}}"#,
            "\n"
        ),
    )
    .unwrap();
    let ctx = context(
        &dir,
        Provider::Claude,
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "claude-primary",
        root,
        false,
    );

    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let requests = records(&sink, "activity.request");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["agent"]["identity_basis"], "unknown");
    assert_eq!(requests[0]["agent"]["key"], Value::Null);
    assert_eq!(requests[0]["agent"]["class"], "unknown");
    assert_eq!(requests.iter().map(token_total).sum::<u64>(), 3);
}

#[test]
fn codex_collects_parent_links_missing_parent_and_unknown_attribution() {
    let dir = tempfile::tempdir().unwrap();
    let id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let account = "codex-primary";
    let ctx = context(&dir, Provider::Codex, id, account, corpus().join("codex/sessions"), true);
    let mut sink = MemorySink::default();
    let outcome = CodexExecution.collect(&ctx, None, &mut sink).unwrap();
    let requests = records(&sink, "activity.request");
    let events = records(&sink, "agent.event");
    assert_valid_and_private(&requests, ctx.now);
    assert_valid_and_private(&events, ctx.now);

    assert_eq!(requests.len(), 5, "the resumed rollout must not duplicate its request");
    assert_eq!(events.iter().filter(|event| event["event_kind"] == "spawn").count(), 3);
    assert_eq!(events.iter().filter(|event| event["event_kind"] == "start").count(), 3);

    let main_key = agent_key(Provider::Codex, account, "codex-main");
    let child_key = agent_key(Provider::Codex, account, "codex-child");
    let nested_key = agent_key(Provider::Codex, account, "codex-nested");
    let orphan_key = agent_key(Provider::Codex, account, "codex-orphan");
    let missing_parent_key = agent_key(Provider::Codex, account, "codex-missing-parent");
    let child = requests.iter().find(|request| request["agent"]["key"] == child_key).unwrap();
    assert_eq!(child["agent"]["class"], "builtin");
    assert_eq!(child["agent"]["parent_key"], main_key);
    assert_eq!(child["agent"]["depth"], 1);
    assert_eq!(child["model_actual"], "gpt-child");
    let nested = requests.iter().find(|request| request["agent"]["key"] == nested_key).unwrap();
    assert_eq!(nested["agent"]["class"], "custom");
    assert_eq!(nested["agent"]["name"], Value::Null);
    assert_eq!(nested["agent"]["parent_key"], child_key);
    assert_eq!(nested["agent"]["depth"], 2);
    let orphan = requests.iter().find(|request| request["agent"]["key"] == orphan_key).unwrap();
    assert_eq!(orphan["agent"]["class"], "builtin");
    assert_eq!(orphan["agent"]["name"], "codex-auto-review");
    assert_eq!(orphan["agent"]["parent_key"], missing_parent_key);
    assert!(!requests.iter().any(|request| request["agent"]["key"] == missing_parent_key));
    let unknown = requests.iter().find(|request| request["agent"]["identity_basis"] == "unknown").unwrap();
    assert_eq!(unknown["agent"]["key"], Value::Null);
    assert_eq!(unknown["agent"]["class"], "unknown");
    assert_eq!(unknown["agent"]["parent_identity_basis"], "unknown");

    let all_tokens: u64 = requests.iter().map(token_total).sum();
    let child_tokens: u64 = requests
        .iter()
        .filter(|request| matches!(request["agent"]["class"].as_str(), Some("builtin" | "custom")))
        .map(token_total)
        .sum();
    assert_eq!((all_tokens, child_tokens), (69, 37));
    assert!(child_tokens <= all_tokens);
    assert_eq!(capability_state(&outcome, CapabilityDimension::Agent), CapabilityState::Partial);
}

#[test]
fn codex_subagent_setting_retains_main_and_unknown_requests_only() {
    let dir = tempfile::tempdir().unwrap();
    let id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let mut ctx = context(&dir, Provider::Codex, id, "codex-primary", corpus().join("codex/sessions"), false);
    let mut sink = MemorySink::default();
    let outcome = CodexExecution.collect(&ctx, None, &mut sink).unwrap();
    let requests = records(&sink, "activity.request");
    assert_eq!(requests.len(), 2);
    assert_eq!(requests.iter().map(token_total).sum::<u64>(), 32);
    assert!(
        requests.iter().all(|request| matches!(request["agent"]["class"].as_str(), Some("main" | "unknown")))
    );
    assert!(records(&sink, "agent.event").is_empty());
    assert_eq!(capability_state(&outcome, CapabilityDimension::Agent), CapabilityState::DisabledBySetting);

    ctx.settings.execution.include_subagents = true;
    let mut enabled = MemorySink::default();
    CodexExecution.collect(&ctx, None, &mut enabled).unwrap();
    assert_eq!(records(&enabled, "activity.request").len(), 5);
    assert_eq!(records(&enabled, "agent.event").len(), 6);

    ctx.settings.execution.include_subagents = false;
    let mut disabled_again = MemorySink::default();
    CodexExecution.collect(&ctx, None, &mut disabled_again).unwrap();
    assert_eq!(records(&disabled_again, "activity.request").len(), 2);
    assert!(records(&disabled_again, "agent.event").is_empty());
}
