//! USG-035: the git branch on `activity.request`, over synthetic Claude
//! transcripts and Codex rollouts. The field is absent unless
//! `branch_attribution` is `plain`, a local deny keeps it home, and only the
//! branch name ever leaves the transcript. Every path, id and name here is
//! synthetic.

use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use jiff::Timestamp;
use observatory_adapters::claude_execution::ClaudeExecution;
use observatory_adapters::codex_execution::CodexExecution;
use observatory_contract::settings::{BranchAttribution, DetailLevel};
use observatory_contract::{AccountId, CollectionSettings, Provider, Uuid};
use observatory_core::adapter::{Adapter, BindingContext, IdentityState, MemorySink, RunContext};
use observatory_core::privacy::PrivacyKey;
use serde_json::{Value, json};

const CLAUDE: &str = "44444444-4444-4444-8444-444444444444";
const CODEX: &str = "55555555-5555-4555-8555-555555555555";

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

fn write(path: &Path, lines: &[Value]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    fs::write(path, text).unwrap();
}

/// One Claude assistant line with its own message id, so each line is one request.
fn claude_line(ts: &str, message: &str, branch: Option<&str>) -> Value {
    let mut line = json!({
        "type": "assistant", "timestamp": ts, "version": "2.0.0", "cwd": "/private/synthetic/work",
        "sessionId": "sess-branch",
        "message": { "id": message, "model": "claude-synthetic", "role": "assistant",
            "usage": { "input_tokens": 2, "output_tokens": 10 },
            "content": [{ "type": "text", "text": "PRIVATE SENTINEL" }] }
    });
    if let Some(branch) = branch {
        line["gitBranch"] = json!(branch);
    }
    line
}

fn codex_line(ts: &str, kind: &str, payload: Value) -> Value {
    json!({ "timestamp": ts, "type": kind, "payload": payload })
}

fn codex_tokens(ts: &str, total: i64) -> Value {
    let usage = json!({
        "input_tokens": total, "cached_input_tokens": 0, "output_tokens": 10, "total_tokens": total + 10
    });
    let info = json!({ "total_token_usage": usage, "last_token_usage": usage });
    codex_line(ts, "event_msg", json!({ "type": "token_count", "info": info }))
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    write(
        &root.join("claude/projects/-private-synthetic-work/sess-branch.jsonl"),
        &[
            claude_line("2026-09-10T10:00:00Z", "msg_named", Some("feature/SYN-1-synthetic")),
            claude_line("2026-09-10T10:00:01Z", "msg_detached", Some("HEAD")),
            claude_line("2026-09-10T10:00:02Z", "msg_missing", None),
            claude_line("2026-09-10T10:00:03Z", "msg_invalid", Some("-not a branch")),
        ],
    );
    let git = json!({
        "branch": "main", "commit_hash": "PRIVATE-COMMIT", "repository_url": "https://private.invalid/repo"
    });
    let meta = json!({
        "id": "codex-branch", "timestamp": "2026-09-10T11:00:00Z", "cwd": "/private/synthetic/work",
        "originator": "codex_cli_rs", "source": "cli", "git": git
    });
    write(
        &root.join("codex/sessions/rollout-branch.jsonl"),
        &[
            codex_line("2026-09-10T11:00:00Z", "session_meta", meta),
            codex_line(
                "2026-09-10T11:00:01Z",
                "event_msg",
                json!({ "type": "task_started", "turn_id": "t" }),
            ),
            codex_line(
                "2026-09-10T11:00:01Z",
                "turn_context",
                json!({ "model": "gpt-synthetic", "cwd": "/private/synthetic/work" }),
            ),
            codex_tokens("2026-09-10T11:00:05Z", 100),
        ],
    );
    Fixture { _dir: dir, root }
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

fn context(fixture: &Fixture, branch: BranchAttribution) -> RunContext {
    let mut settings = CollectionSettings::defaults();
    settings.execution.detail_level = DetailLevel::Requests;
    settings.execution.branch_attribution = branch;
    RunContext::new(
        Timestamp::from_str("2026-09-12T00:00:00Z").unwrap(),
        "2026-09-01".to_owned(),
        observatory_core::pyjson::epoch_text("2026-09-01T00:00:00Z").unwrap(),
        settings,
        3,
        None,
        vec![
            binding(CLAUDE, Provider::Claude, "claude-synthetic", vec![fixture.root.join("claude/projects")]),
            binding(CODEX, Provider::Codex, "codex-synthetic", vec![fixture.root.join("codex/sessions")]),
        ],
        vec![],
        fixture.root.clone(),
        fixture.root.join("state.sqlite3"),
        fixture.root.join("statusline"),
        true,
        Duration::from_secs(60),
        PrivacyKey::fixed_for_tests(),
    )
    .with_claude_settings_path(fixture.root.join("claude-settings.json"))
}

/// The emitted requests by provider, in timestamp order.
fn requests(ctx: &RunContext) -> (Vec<Value>, Vec<Value>) {
    let collect = |adapter: &dyn Adapter| {
        let mut sink = MemorySink::default();
        adapter.collect(ctx, None, &mut sink).unwrap();
        let mut records: Vec<Value> = sink
            .records
            .iter()
            .map(|emitted| serde_json::to_value(&emitted.record).unwrap())
            .filter(|record| record["record_type"] == "activity.request")
            .collect();
        records.sort_by(|a, b| a["ended_at"].as_str().cmp(&b["ended_at"].as_str()));
        records
    };
    (collect(&ClaudeExecution), collect(&CodexExecution))
}

#[test]
fn branch_is_absent_by_default() {
    let fixture = fixture();
    let (claude, codex) = requests(&context(&fixture, BranchAttribution::Off));
    assert_eq!(claude.len(), 4);
    assert_eq!(codex.len(), 1);
    for record in claude.iter().chain(&codex) {
        assert!(record.get("git_branch").is_none(), "{record}");
        assert!(!record.to_string().contains("feature/SYN-1"), "{record}");
    }
}

#[test]
fn plain_carries_the_recorded_branch_and_nothing_else_from_git() {
    let fixture = fixture();
    let (claude, codex) = requests(&context(&fixture, BranchAttribution::Plain));
    let branches: Vec<&Value> = claude.iter().map(|record| &record["git_branch"]).collect();
    assert_eq!(
        branches,
        vec![
            &json!({ "name": "feature/SYN-1-synthetic", "basis": "recorded" }),
            &json!({ "name": null, "basis": "detached" }),
            &json!({ "name": null, "basis": "unknown" }),
            &json!({ "name": null, "basis": "unknown" }),
        ]
    );
    assert_eq!(codex[0]["git_branch"], json!({ "name": "main", "basis": "recorded" }));
    let text = codex[0].to_string();
    assert!(!text.contains("PRIVATE-COMMIT") && !text.contains("private.invalid"), "{text}");
}

/// Turning the setting on after a run re-emits the saved requests with the branch,
/// because the setting is part of the emission fingerprint.
#[test]
fn enabling_after_a_run_re_emits_with_the_branch() {
    let fixture = fixture();
    let (before, _) = requests(&context(&fixture, BranchAttribution::Off));
    assert!(before.iter().all(|record| record.get("git_branch").is_none()));
    let (after, codex) = requests(&context(&fixture, BranchAttribution::Plain));
    assert_eq!(after.len(), 4);
    assert_eq!(after[0]["git_branch"]["name"], "feature/SYN-1-synthetic");
    assert_eq!(codex[0]["git_branch"]["name"], "main");
}

#[test]
fn local_deny_keeps_the_branch_home() {
    let fixture = fixture();
    let mut ctx = context(&fixture, BranchAttribution::Plain);
    ctx.deny.push("execution.branch_attribution".into());
    let (claude, codex) = requests(&ctx);
    assert!(claude.iter().chain(&codex).all(|record| record.get("git_branch").is_none()));
}
