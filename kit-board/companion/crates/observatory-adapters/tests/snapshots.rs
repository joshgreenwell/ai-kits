//! Golden snapshots of each execution adapter's normalized output over the
//! parity corpus, at `requests` detail so both buckets and records appear.
//! Review a change with `cargo insta review` (or set `INSTA_UPDATE=always`).

use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use jiff::Timestamp;
use observatory_adapters::claude_execution::ClaudeExecution;
use observatory_adapters::codex_execution::CodexExecution;
use observatory_contract::settings::{DetailLevel, ProjectAttribution};
use observatory_contract::{AccountId, CollectionSettings, Provider, Uuid};
use observatory_core::adapter::{Adapter, BindingContext, IdentityState, MemorySink, Preflight, RunContext};
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
}

fn binding(id: &str, provider: Provider, account: &str, roots: Vec<PathBuf>) -> BindingContext {
    BindingContext {
        binding_id: Uuid::from_str(id).unwrap(),
        account_id: AccountId::from_str(account).unwrap(),
        provider,
        enabled: true,
        identity_hash: None,
        identity: IdentityState::Confirmed,
        roots,
        codex_home: None,
        cursor_state_db: None,
    }
}

fn snapshot(adapter: &dyn Adapter, ctx: &RunContext, binding_id: &str) -> Value {
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
    json!({
        "coverage": {"state": outcome.state, "detail": outcome.detail, "files": outcome.files,
            "bytes_read": outcome.bytes_read, "records_emitted": outcome.records_emitted,
            "malformed": outcome.malformed, "stores_discovered": outcome.stores_discovered},
        "buckets": buckets,
        "records": records,
    })
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
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    CodexExecution.collect(&ctx, None, &mut sink).unwrap();
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
        *seen.entry(value["project_hash"].as_str().map(str::to_owned)).or_insert(0) += 1;
    }
    assert!(seen.get(&Some(claude_project)).is_some_and(|n| *n > 0), "claude requests carry the hash");
    assert!(seen.get(&Some(codex_project)).is_some_and(|n| *n > 0), "codex requests carry the hash");
    assert!(seen.get(&None).is_some_and(|n| *n > 0), "a rollout without session_meta stays unattributed");
    assert_eq!(seen.len(), 3, "{seen:?}");
    let state = State::open(&ctx.state_path).unwrap();
    let listed: Vec<String> = state.projects(claude).unwrap().into_iter().map(|row| row.path).collect();
    assert_eq!(listed, vec!["/private/synthetic/project".to_owned()]);
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
