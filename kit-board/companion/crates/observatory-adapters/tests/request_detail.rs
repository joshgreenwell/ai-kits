//! Sanitized provider fixtures for nullable request and pricing evidence.

use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use jiff::Timestamp;
use observatory_adapters::claude_execution::ClaudeExecution;
use observatory_adapters::codex_execution::CodexExecution;
use observatory_contract::settings::DetailLevel;
use observatory_contract::{
    AccountId, CapabilityDimension, CapabilityState, CollectionSettings, Provider, Uuid,
};
use observatory_core::adapter::{Adapter, BindingContext, IdentityState, MemorySink, RunContext};
use observatory_core::paths::{file_identity, mtime_ns};
use observatory_core::privacy::PrivacyKey;
use observatory_core::pyjson::digest;
use observatory_core::state::{EventRow, FileCheckpoint, State};
use serde_json::Value;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/usage-v2/request-detail")
}

fn binding(id: &str, provider: Provider, account: &str, roots: Vec<PathBuf>) -> BindingContext {
    BindingContext {
        binding_id: Uuid::from_str(id).unwrap(),
        account_id: AccountId::from_str(account).unwrap(),
        provider,
        enabled: true,
        identity_hash: None,
        identity: IdentityState::Confirmed,
        identity_conflict: false,
        roots,
        codex_home: None,
        cursor_state_db: None,
    }
}

fn context(dir: &tempfile::TempDir, detail_level: DetailLevel, binding: BindingContext) -> RunContext {
    let mut settings = CollectionSettings::defaults();
    settings.execution.detail_level = detail_level;
    RunContext::new(
        Timestamp::from_str("2026-09-12T00:00:00Z").unwrap(),
        "2026-09-01".to_owned(),
        observatory_core::pyjson::epoch_text("2026-09-01T00:00:00Z").unwrap(),
        settings,
        3,
        None,
        vec![binding],
        vec![],
        dir.path().to_path_buf(),
        dir.path().join("state.sqlite3"),
        dir.path().join("statusline"),
        true,
        Duration::from_secs(60),
        PrivacyKey::fixed_for_tests(),
    )
}

fn requests(sink: &MemorySink) -> Vec<Value> {
    let mut values: Vec<Value> = sink
        .records
        .iter()
        .filter_map(|emitted| {
            let value = serde_json::to_value(&emitted.record).unwrap();
            (value["record_type"] == "activity.request").then_some(value)
        })
        .collect();
    values.sort_by(|left, right| left["observed_at"].as_str().cmp(&right["observed_at"].as_str()));
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

fn capability_detail(
    outcome: &observatory_core::adapter::Outcome,
    dimension: CapabilityDimension,
) -> Option<String> {
    outcome
        .capabilities
        .as_ref()
        .unwrap()
        .iter()
        .find(|capability| capability.dimension == dimension)
        .unwrap()
        .detail_code
        .as_ref()
        .map(|code| code.as_str().to_owned())
}

fn assert_valid(records: &[Value], now: Timestamp) {
    for value in records {
        let record: observatory_contract::Record = serde_json::from_value(value.clone()).unwrap();
        let mut violations = Vec::new();
        record.validate(now, "record", &mut violations);
        assert!(violations.is_empty(), "{violations:?}");
        let wire = value.to_string();
        for private in ["/private", "request-safe", "session-detail", "message-detail"] {
            assert!(!wire.contains(private), "request leaked {private:?}: {wire}");
        }
    }
}

#[test]
fn claude_retains_pricing_partial_tokens_and_zero_calls() {
    let dir = tempfile::tempdir().unwrap();
    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let ctx = context(
        &dir,
        DetailLevel::Requests,
        binding(id, Provider::Claude, "claude-primary", vec![corpus().join("claude/projects")]),
    );
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let values = requests(&sink);
    assert_valid(&values, ctx.now);
    assert_eq!(values.len(), 3);
    assert_eq!(values[0]["tokens"]["reasoning"], 4);
    assert_eq!(values[0]["pricing"]["reasoning_effort"], "high");
    assert_eq!(values[0]["pricing"]["service_tier"], "standard");
    assert_eq!(values[0]["pricing"]["speed"], "fast");
    assert_eq!(values[0]["pricing"]["cache_write_ttl"], "5m");
    assert_eq!(values[0]["token_accounting"]["composition_state"], "complete");
    assert_eq!(values[1]["tokens"]["input_fresh"], 0);
    assert_eq!(values[1]["tokens"]["output"], 0);
    assert_eq!(values[1]["outcome"], "failed");
    assert_eq!(values[2]["tokens"]["input_cached"], Value::Null);
    assert_eq!(values[2]["token_accounting"]["composition_state"], "partial");
    assert_eq!(capability_state(&outcome, CapabilityDimension::Requests), CapabilityState::Complete);
    assert_eq!(capability_state(&outcome, CapabilityDimension::TokenComposition), CapabilityState::Partial);
    assert_eq!(capability_state(&outcome, CapabilityDimension::Pricing), CapabilityState::Partial);

    let state = State::open(&ctx.state_path).unwrap();
    let buckets = state.bucket_rows(id).unwrap();
    assert_eq!((buckets.len(), buckets[0].calls, buckets[0].total_tokens), (1, 2, 67));
    assert_eq!(state.request_events(id).unwrap().len(), 3);

    let first_ids: Vec<_> = values.iter().map(|value| value["record_id"].clone()).collect();
    let mut replay = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut replay).unwrap();
    let replay_ids: Vec<_> = requests(&replay).iter().map(|value| value["record_id"].clone()).collect();
    assert_eq!(replay_ids, first_ids);
    let replay_buckets = State::open(&ctx.state_path).unwrap().bucket_rows(id).unwrap();
    assert_eq!((replay_buckets[0].calls, replay_buckets[0].total_tokens), (2, 67));
}

#[test]
fn codex_retains_effort_context_reasoning_and_cumulative_deltas() {
    let dir = tempfile::tempdir().unwrap();
    let id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let ctx = context(
        &dir,
        DetailLevel::Requests,
        binding(id, Provider::Codex, "codex-primary", vec![corpus().join("codex/sessions")]),
    );
    let mut sink = MemorySink::default();
    let outcome = CodexExecution.collect(&ctx, None, &mut sink).unwrap();
    let values = requests(&sink);
    assert_valid(&values, ctx.now);
    assert_eq!(values.len(), 5);
    let detailed: Vec<_> = values.iter().filter(|value| value["model_actual"] == "gpt-detail").collect();
    for (value, expected) in detailed.iter().zip([(30, 20, 10, 15, 5, 75), (30, 10, 0, 10, 3, 50)]) {
        assert_eq!(value["tokens"]["input_fresh"], expected.0);
        assert_eq!(value["tokens"]["input_cached"], expected.1);
        assert_eq!(value["tokens"]["input_cache_write"], expected.2);
        assert_eq!(value["tokens"]["output"], expected.3);
        assert_eq!(value["tokens"]["reasoning"], expected.4);
        assert_eq!(value["token_accounting"]["reported_total"], expected.5);
        assert_eq!(value["token_accounting"]["unclassified"], 0);
        assert_eq!(value["pricing"]["reasoning_effort"], "xhigh");
        assert_eq!(value["pricing"]["context_window_tokens"], 200000);
        assert_eq!(value["model_actual"], "gpt-detail");
        assert_eq!(value["model_requested"], Value::Null);
    }
    let partial: Vec<_> = values.iter().filter(|value| value["model_actual"] == "gpt-partial").collect();
    assert_eq!(partial.len(), 3);
    for (value, output) in partial.iter().take(2).zip([2, 1]) {
        assert_eq!(value["tokens"]["input_fresh"], Value::Null);
        assert_eq!(value["tokens"]["input_cached"], Value::Null);
        assert_eq!(value["tokens"]["input_cache_write"], Value::Null);
        assert_eq!(value["tokens"]["output"], output);
        assert_eq!(value["tokens"]["reasoning"], Value::Null);
        assert_eq!(value["token_accounting"]["reported_total"], Value::Null);
        assert_eq!(value["token_accounting"]["composition_state"], "partial");
    }
    assert_eq!(partial[2]["tokens"]["input_fresh"], 3);
    assert_eq!(partial[2]["tokens"]["input_cached"], 1);
    assert_eq!(partial[2]["tokens"]["input_cache_write"], 0);
    assert_eq!(partial[2]["tokens"]["output"], 25);
    assert_eq!(partial[2]["tokens"]["reasoning"], 12);
    assert_eq!(partial[2]["token_accounting"]["reported_total"], 30);
    assert_eq!(partial[2]["token_accounting"]["unclassified"], 1);
    assert_eq!(partial[2]["token_accounting"]["composition_state"], "complete");
    assert_eq!(capability_state(&outcome, CapabilityDimension::TokenComposition), CapabilityState::Partial);
    let buckets = State::open(&ctx.state_path).unwrap().bucket_rows(id).unwrap();
    assert_eq!(buckets.len(), 2);
    let detailed_bucket = buckets.iter().find(|bucket| bucket.model == "gpt-detail").unwrap();
    assert_eq!((detailed_bucket.calls, detailed_bucket.total_tokens), (2, 125));
    let partial_bucket = buckets.iter().find(|bucket| bucket.model == "gpt-partial").unwrap();
    assert_eq!((partial_bucket.calls, partial_bucket.total_tokens), (3, 47));
}

#[test]
fn bucket_only_setting_reports_detail_as_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let ctx = context(
        &dir,
        DetailLevel::BucketsOnly,
        binding(id, Provider::Claude, "claude-primary", vec![corpus().join("claude/projects")]),
    );
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    assert!(requests(&sink).is_empty());
    for dimension in
        [CapabilityDimension::Requests, CapabilityDimension::TokenComposition, CapabilityDimension::Pricing]
    {
        assert_eq!(capability_state(&outcome, dimension), CapabilityState::DisabledBySetting);
    }
    assert_eq!(State::open(&ctx.state_path).unwrap().bucket_rows(id).unwrap()[0].calls, 2);
}

#[test]
fn unavailable_history_marks_request_capability_partial() {
    let dir = tempfile::tempdir().unwrap();
    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let ctx = context(
        &dir,
        DetailLevel::Requests,
        binding(
            id,
            Provider::Claude,
            "claude-primary",
            vec![corpus().join("claude/projects"), corpus().join("missing-history")],
        ),
    );
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    assert_eq!(outcome.state, observatory_contract::CoverageState::Partial);
    assert_eq!(capability_state(&outcome, CapabilityDimension::Requests), CapabilityState::Partial);
}

#[test]
fn parser_generation_backfills_retained_v2_events() {
    let dir = tempfile::tempdir().unwrap();
    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let root = corpus().join("claude/projects");
    let source = std::fs::canonicalize(root.join("session-detail.jsonl")).unwrap();
    let ctx =
        context(&dir, DetailLevel::Requests, binding(id, Provider::Claude, "claude-primary", vec![root]));
    let state = State::open(&ctx.state_path).unwrap();
    let event_id = digest(&serde_json::json!(["claude", "claude-primary", "message-detail-1"]));
    let session = digest(&serde_json::json!(["claude", "claude-primary", "session-detail"]));
    state
        .insert_event(
            id,
            &EventRow {
                id: event_id.as_str().to_owned(),
                session: session.as_str().to_owned(),
                hour: "2026-09-02T02:00:00Z".into(),
                model: "claude-detail".into(),
                input_tokens: 12,
                cached_tokens: 30,
                cache_write_tokens: 8,
                output_tokens: 10,
                session_identity: "provider".into(),
                timestamp: "2026-09-02T02:00:00.000Z".into(),
                product: "claude_code".into(),
                client_version: None,
                parent_session: None,
                project_hash: None,
                project_key: None,
                project_basis: "unknown".into(),
                surface: None,
                detail_observed: false,
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
                agent_observed: false,
                agent_key: None,
                agent_identity_basis: "unknown".into(),
                parent_agent_key: None,
                parent_agent_identity_basis: "unknown".into(),
                agent_class: "unknown".into(),
                agent_name: None,
                agent_depth: None,
            },
        )
        .unwrap();
    let metadata = std::fs::metadata(&source).unwrap();
    state
        .save_file_checkpoint(
            id,
            &FileCheckpoint {
                path: source.to_string_lossy().into_owned(),
                size: i64::try_from(metadata.len()).unwrap(),
                mtime_ns: i64::try_from(mtime_ns(&metadata)).unwrap(),
                inode: file_identity(&source).unwrap(),
                offset: i64::try_from(metadata.len()).unwrap(),
                context: "{}".into(),
            },
        )
        .unwrap();
    state.set_meta(&format!("file_parser:{id}"), "older-parser").unwrap();
    drop(state);

    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let backfilled = State::open(&ctx.state_path).unwrap().event(id, event_id.as_str()).unwrap().unwrap();
    assert!(backfilled.detail_observed);
    assert_eq!(backfilled.detail_reasoning, Some(4));
    assert_eq!(backfilled.reasoning_effort.as_deref(), Some("high"));
    assert_eq!(backfilled.cache_write_ttl.as_deref(), Some("5m"));
}

#[test]
fn unbackfilled_rows_expose_their_coverage_limit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    std::fs::create_dir(&root).unwrap();
    let id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let ctx =
        context(&dir, DetailLevel::Requests, binding(id, Provider::Claude, "claude-primary", vec![root]));
    let state = State::open(&ctx.state_path).unwrap();
    state
        .insert_event(
            id,
            &EventRow {
                id: "0".repeat(64),
                session: "1".repeat(64),
                hour: "2026-09-02T02:00:00.000Z".into(),
                model: "legacy-model".into(),
                input_tokens: 12,
                cached_tokens: 3,
                cache_write_tokens: 0,
                output_tokens: 4,
                session_identity: "provider".into(),
                timestamp: "2026-09-02T02:00:00Z".into(),
                product: "claude_code".into(),
                client_version: None,
                parent_session: None,
                project_hash: None,
                project_key: None,
                project_basis: "unknown".into(),
                surface: None,
                detail_observed: false,
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
                agent_observed: false,
                agent_key: None,
                agent_identity_basis: "unknown".into(),
                parent_agent_key: None,
                parent_agent_identity_basis: "unknown".into(),
                agent_class: "unknown".into(),
                agent_name: None,
                agent_depth: None,
            },
        )
        .unwrap();
    state.set_meta(&format!("file_parser:{id}"), observatory_adapters::EXECUTION_PARSER_VERSION).unwrap();
    drop(state);

    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    assert_eq!(requests(&sink).len(), 1);
    assert_eq!(capability_state(&outcome, CapabilityDimension::Requests), CapabilityState::Partial);
    assert_eq!(capability_state(&outcome, CapabilityDimension::TokenComposition), CapabilityState::Partial);
    assert_eq!(
        capability_detail(&outcome, CapabilityDimension::TokenComposition).as_deref(),
        Some("detail_backfill_unavailable")
    );
}

#[test]
fn malformed_history_remains_partial_after_an_unchanged_replay() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("broken.jsonl"), b"{\"type\":\"assistant\"\n").unwrap();
    let id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let ctx =
        context(&dir, DetailLevel::Requests, binding(id, Provider::Claude, "claude-primary", vec![root]));

    let mut first_sink = MemorySink::default();
    let first = ClaudeExecution.collect(&ctx, None, &mut first_sink).unwrap();
    assert_eq!(first.malformed, 1);
    assert_eq!(first.state, observatory_contract::CoverageState::Partial);
    assert_eq!(first.detail, Some(observatory_contract::DetailCode::ParseError));
    assert_eq!(capability_state(&first, CapabilityDimension::Requests), CapabilityState::Partial);

    let mut second_sink = MemorySink::default();
    let second = ClaudeExecution.collect(&ctx, None, &mut second_sink).unwrap();
    assert_eq!(second.malformed, 0);
    assert_eq!(second.state, observatory_contract::CoverageState::Partial);
    assert_eq!(second.detail, Some(observatory_contract::DetailCode::ParseError));
    assert_eq!(capability_state(&second, CapabilityDimension::Requests), CapabilityState::Partial);

    std::fs::remove_file(dir.path().join("history/broken.jsonl")).unwrap();
    let mut deleted_sink = MemorySink::default();
    let deleted = ClaudeExecution.collect(&ctx, None, &mut deleted_sink).unwrap();
    assert_eq!(deleted.malformed, 0);
    assert_eq!(deleted.state, observatory_contract::CoverageState::Partial);
    assert_eq!(deleted.detail, Some(observatory_contract::DetailCode::ParseError));
    assert_eq!(capability_state(&deleted, CapabilityDimension::Requests), CapabilityState::Partial);
}
