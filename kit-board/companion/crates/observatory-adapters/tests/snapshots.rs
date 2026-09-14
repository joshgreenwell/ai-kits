//! Golden snapshots of each adapter's normalized output over the parity
//! corpus, at `requests` detail so both buckets and records appear; the
//! account adapter's snapshot also pins its `allowance` capability row.
//! Review a change with `cargo insta review` (or set `INSTA_UPDATE=always`).

use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use jiff::Timestamp;
use observatory_adapters::claude_account::ClaudeAccount;
use observatory_adapters::claude_execution::ClaudeExecution;
use observatory_adapters::codex_execution::CodexExecution;
use observatory_contract::settings::{DetailLevel, ProjectAttribution};
use observatory_contract::{
    AccountId, CapabilityDimension, CapabilityState, CollectionSettings, Provider, Uuid,
};
use observatory_core::adapter::{
    Adapter, BindingContext, IdentityState, MemorySink, Outcome, Preflight, RunContext,
};
use observatory_core::outbox::bucket_from_row;
use observatory_core::pyjson::digest;
use observatory_core::state::State;
use serde_json::{Value, json};

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/usage-v2/parity")
}

fn context(dir: &tempfile::TempDir, bindings: Vec<BindingContext>) -> RunContext {
    let mut settings = CollectionSettings::defaults();
    settings.execution.detail_level = DetailLevel::Requests;
    RunContext::new(
        Timestamp::from_str("2026-09-12T00:00:00Z").unwrap(),
        "2026-09-01".to_owned(),
        observatory_core::pyjson::epoch_text("2026-09-01T00:00:00Z").unwrap(),
        settings,
        3,
        None,
        bindings,
        vec![],
        dir.path().to_path_buf(),
        dir.path().join("state.sqlite3"),
        corpus().join("claude-statusline"),
        true,
        Duration::from_secs(60),
    )
    // No Claude settings file: the hook status never depends on the machine running the test.
    .with_claude_settings_path(dir.path().join("claude-settings.json"))
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

fn snapshot(adapter: &dyn Adapter, ctx: &RunContext, binding_id: &str) -> Value {
    collect_snapshot(adapter, ctx, binding_id).0
}

fn collect_snapshot(adapter: &dyn Adapter, ctx: &RunContext, binding_id: &str) -> (Value, Outcome) {
    assert_eq!(adapter.preflight(ctx), Preflight::Ready);
    let mut sink = MemorySink::default();
    let outcome = adapter.collect(ctx, None, &mut sink).unwrap();
    let mut records: Vec<Value> =
        sink.records.iter().map(|e| serde_json::to_value(&e.record).unwrap()).collect();
    records.sort_by(|a, b| a["record_id"].as_str().cmp(&b["record_id"].as_str()));
    let state = State::open(&ctx.state_path).unwrap();
    let buckets: Vec<Value> = state
        .bucket_rows(binding_id)
        .unwrap()
        .iter()
        .map(|row| serde_json::to_value(bucket_from_row(row).unwrap()).unwrap())
        .collect();
    let value = json!({
        "coverage": {"state": outcome.state, "detail": outcome.detail, "files": outcome.files,
            "bytes_read": outcome.bytes_read, "records_emitted": outcome.records_emitted,
            "malformed": outcome.malformed, "stores_discovered": outcome.stores_discovered},
        "buckets": buckets,
        "records": records,
    });
    (value, outcome)
}

#[test]
fn claude_execution_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let ctx = context(
        &dir,
        vec![binding(id, Provider::Claude, "claude-primary", vec![corpus().join("claude/projects")])],
    );
    insta::assert_json_snapshot!("claude_execution", snapshot(&ClaudeExecution, &ctx, id));
}

/// The statusline readings over the parity inbox (unstamped samples, one
/// confirmed binding) with the `allowance` row: complete, `no_recent_samples`
/// because the corpus is ten days older than the run.
#[test]
fn claude_account_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let ctx = context(
        &dir,
        vec![binding(id, Provider::Claude, "claude-primary", vec![corpus().join("claude/projects")])],
    );
    let (mut value, outcome) = collect_snapshot(&ClaudeAccount, &ctx, id);
    value["capabilities"] = serde_json::to_value(outcome.capabilities.unwrap()).unwrap();
    insta::assert_json_snapshot!("claude_account", value);
}

#[test]
fn codex_execution_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let codex = corpus().join("codex");
    let ctx = context(
        &dir,
        vec![binding(
            id,
            Provider::Codex,
            "codex-primary",
            vec![codex.join("sessions"), codex.join("archived_sessions")],
        )],
    );
    insta::assert_json_snapshot!("codex_execution", snapshot(&CodexExecution, &ctx, id));
}

/// With `hashed` attribution every request names its project by the hash of the working
/// directory the transcript recorded, the same hash for the same directory from either
/// provider, and never the directory itself. The default (`off`) leaves the field null.
#[test]
fn hashed_project_attribution_names_directories_by_hash_only() {
    let dir = tempfile::tempdir().unwrap();
    let claude = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let codex_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let codex = corpus().join("codex");
    let mut ctx = context(
        &dir,
        vec![
            binding(claude, Provider::Claude, "claude-primary", vec![corpus().join("claude/projects")]),
            binding(
                codex_id,
                Provider::Codex,
                "codex-primary",
                vec![codex.join("sessions"), codex.join("archived_sessions")],
            ),
        ],
    );
    ctx.settings.execution.project_attribution = ProjectAttribution::Hashed;
    let mut sink = MemorySink::default();
    let claude_outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    CodexExecution.collect(&ctx, None, &mut sink).unwrap();
    assert!(claude_outcome.capabilities.as_ref().is_some_and(|coverage| coverage.iter().any(|item| {
        item.dimension == CapabilityDimension::Project && item.state != CapabilityState::DisabledBySetting
    })));
    let claude_project = digest(&json!(["project", "/private/synthetic/project"])).as_str().to_owned();
    let codex_project = digest(&json!(["project", "/private/synthetic"])).as_str().to_owned();
    let mut seen: std::collections::BTreeMap<Option<String>, usize> = std::collections::BTreeMap::new();
    for emitted in &sink.records {
        let value = serde_json::to_value(&emitted.record).unwrap();
        if value["record_type"] != "activity.request" {
            continue;
        }
        let text = value.to_string();
        // `session_identity` is legitimately "synthetic"; the directory itself must not appear.
        assert!(!text.contains("/private") && !text.contains("synthetic/"), "path leaked: {text}");
        if let Some(key) = value["project_hash"].as_str() {
            assert_eq!(value["project"], json!({ "key": key, "basis": "working_directory" }));
        } else {
            assert_eq!(value["project"], json!({ "key": null, "basis": "unknown" }));
        }
        *seen.entry(value["project_hash"].as_str().map(str::to_owned)).or_insert(0) += 1;
    }
    assert!(seen.get(&Some(claude_project)).is_some_and(|n| *n > 0), "claude requests carry the hash");
    assert!(seen.get(&Some(codex_project)).is_some_and(|n| *n > 0), "codex requests carry the hash");
    assert!(seen.get(&None).is_some_and(|n| *n > 0), "a rollout without session_meta stays unattributed");
    assert_eq!(seen.len(), 3, "{seen:?}");
    let state = State::open(&ctx.state_path).unwrap();
    let listed: Vec<String> = state.projects(claude).unwrap().into_iter().map(|row| row.path).collect();
    assert_eq!(listed, vec!["/private/synthetic/project".to_owned()]);

    ctx.deny.push("execution.project_attribution".into());
    let mut denied = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut denied).unwrap();
    assert!(outcome.capabilities.as_ref().is_some_and(|coverage| coverage.iter().any(|item| {
        item.dimension == CapabilityDimension::Project && item.state == CapabilityState::DisabledBySetting
    })));
    for emitted in denied.records {
        let value = serde_json::to_value(emitted.record).unwrap();
        if value["record_type"] == "activity.request" {
            assert_eq!(value["project_hash"], Value::Null);
            assert!(value.get("project").is_none(), "local deny removes structured project attribution");
        }
    }
}

#[test]
fn every_emitted_record_validates_and_leaks_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let claude = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let codex_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let codex = corpus().join("codex");
    let ctx = context(
        &dir,
        vec![
            binding(claude, Provider::Claude, "claude-primary", vec![corpus().join("claude/projects")]),
            binding(
                codex_id,
                Provider::Codex,
                "codex-primary",
                vec![codex.join("sessions"), codex.join("archived_sessions")],
            ),
        ],
    );
    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    CodexExecution.collect(&ctx, None, &mut sink).unwrap();
    ClaudeAccount.collect(&ctx, None, &mut sink).unwrap();
    assert!(sink.records.len() > 10);
    let now = ctx.now;
    for emitted in &sink.records {
        let mut violations = Vec::new();
        emitted.record.validate(now, "record", &mut violations);
        assert!(violations.is_empty(), "{violations:?}");
        let text = serde_json::to_string(&emitted.record).unwrap();
        for private in ["PRIVATE", "SENTINEL", "/private", "synthetic/project", "sess-a", "msg_"] {
            assert!(!text.contains(private), "record leaks {private:?}: {text}");
        }
    }
}
