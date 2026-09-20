//! Synthetic knowledge-source access coverage for supported Claude and Codex
//! local histories: which configured source a call touched, with every root
//! and file name staying on the machine.

use std::collections::{BTreeMap, HashSet};
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
use observatory_core::config::LocalResource;
use observatory_core::privacy::PrivacyKey;
use observatory_core::resources::ResourceConfiguration;
use observatory_core::state::State;
use serde_json::Value;

const CLAUDE_BINDING: &str = "51111111-1111-4111-8111-111111111111";
const CODEX_BINDING: &str = "52222222-2222-4222-8222-222222222222";

/// Root sentinels: legitimately present as working directories in `projects`
/// and `files`, never in resource rows or records.
const ROOT_SENTINELS: [&str; 4] = ["/synthetic/vault-alpha", "vault-alpha", "vault-gamma", "synthetic\\"];
/// File-name and sub-directory sentinels: never anywhere in the state database.
const NAME_SENTINELS: [&str; 3] = ["SENTINEL", "nested/inner", "alpha.test"];

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/usage-v2/resource-detail")
}

fn local(key: &str, roots: &[&str], connectors: &[&str]) -> LocalResource {
    LocalResource {
        key: key.into(),
        label: None,
        roots: roots.iter().map(PathBuf::from).collect(),
        connectors: connectors.iter().map(|value| (*value).to_owned()).collect(),
        source: None,
    }
}

/// `alpha-src` spans a POSIX root and the same vault's Windows root; `beta-src`
/// is nested inside alpha. `mcp:shared` is claimed by both on purpose.
fn configuration() -> ResourceConfiguration {
    ResourceConfiguration::from_local(
        &[
            local(
                "alpha-src",
                &["/synthetic/vault-alpha", "C:\\synthetic\\vault-gamma"],
                &["mcp:alpha", "mcp:shared", "url:https://alpha.test/"],
            ),
            local("beta-src", &["/synthetic/vault-alpha/nested"], &["mcp:shared"]),
        ],
        Some("/synthetic/home"),
    )
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
    resources: ResourceConfiguration,
    deny: Vec<String>,
) -> RunContext {
    let mut settings = CollectionSettings::defaults();
    settings.execution.detail_level = DetailLevel::RequestsWithTools;
    settings.execution.tool_detail = ToolDetail::BuiltinOnly;
    settings.execution.include_subagents = true;
    RunContext::new(
        Timestamp::from_str("2026-09-12T00:00:00Z").unwrap(),
        "2026-09-01".to_owned(),
        observatory_core::pyjson::epoch_text("2026-09-01T00:00:00Z").unwrap(),
        settings,
        3,
        None,
        vec![binding(id, provider, account, root)],
        deny,
        dir.path().to_path_buf(),
        dir.path().join("state.sqlite3"),
        dir.path().join("statusline"),
        true,
        Duration::from_secs(60),
        PrivacyKey::fixed_for_tests(),
    )
    .with_resources(resources)
}

fn claude_context(
    dir: &tempfile::TempDir,
    resources: ResourceConfiguration,
    deny: Vec<String>,
) -> RunContext {
    context(
        dir,
        Provider::Claude,
        CLAUDE_BINDING,
        "claude-primary",
        corpus().join("claude/projects"),
        resources,
        deny,
    )
}

fn codex_context(dir: &tempfile::TempDir, resources: ResourceConfiguration, deny: Vec<String>) -> RunContext {
    context(
        dir,
        Provider::Codex,
        CODEX_BINDING,
        "codex-primary",
        corpus().join("codex/sessions"),
        resources,
        deny,
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
        for private in ROOT_SENTINELS.iter().chain(NAME_SENTINELS.iter()) {
            assert!(!wire.contains(private), "record leaked {private:?}: {wire}");
        }
    }
}

/// The main database file plus its write-ahead log, when one is still present.
fn state_bytes(path: &std::path::Path) -> Vec<u8> {
    let mut bytes = std::fs::read(path).unwrap();
    let wal = path.with_extension("sqlite3-wal");
    if wal.is_file() {
        bytes.extend(std::fs::read(wal).unwrap());
    }
    bytes
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle.as_bytes())
}

/// Root sentinels must not reach the resource tables or emitted records;
/// file-name sentinels must not reach the database at all. The `records` and
/// outbox ledgers are written by `run::execute` from these same emitted
/// records, so they are covered by the run-level tests, not here.
fn assert_state_private(ctx: &RunContext, binding_id: &str, emitted: &[Value]) {
    let state = State::open(&ctx.state_path).unwrap();
    let mut local = String::new();
    for row in state.resource_accesses(binding_id).unwrap() {
        local.push_str(&format!("{row:?}"));
    }
    local.push_str(&format!("{:?}", state.resource_inspection_counts(binding_id).unwrap()));
    for record in emitted {
        local.push_str(&record.to_string());
    }
    drop(state);
    for private in ROOT_SENTINELS.iter().chain(NAME_SENTINELS.iter()) {
        assert!(!local.contains(private), "resource rows or records leaked {private:?}");
    }
    let bytes = state_bytes(&ctx.state_path);
    assert!(contains(&bytes, binding_id), "the byte scan must see the real database");
    for private in NAME_SENTINELS {
        assert!(!contains(&bytes, private), "the state database retained {private:?}");
    }
}

/// Emitted resource records joined to their tool name through the invocation
/// key, keyed by the fixture's tool_use id (recoverable from the tool.event
/// list because the tool name and observed_at are unique per call here).
fn by_invocation(sink: &MemorySink) -> BTreeMap<String, Vec<Value>> {
    let mut grouped: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for record in records(sink, "resource.access") {
        grouped.entry(record["invocation_key"].as_str().unwrap().to_owned()).or_default().push(record);
    }
    for group in grouped.values_mut() {
        group.sort_by(|left, right| left["resource_key"].as_str().cmp(&right["resource_key"].as_str()));
    }
    grouped
}

fn triple(record: &Value) -> (&str, &str, &str, &str) {
    (
        record["resource_key"].as_str().unwrap(),
        record["access_kind"].as_str().unwrap(),
        record["evidence_basis"].as_str().unwrap(),
        record["outcome"].as_str().unwrap(),
    )
}

fn invocation_key(account: &str, provider: Provider, id: &str) -> String {
    observatory_adapters::agents::invocation_key(provider, account, id)
}

#[test]
fn claude_classifies_explicit_shell_and_connector_evidence_per_source() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = claude_context(&dir, configuration(), vec![]);
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let accesses = records(&sink, "resource.access");
    assert_valid_and_private(&accesses, ctx.now);
    assert_valid_and_private(&records(&sink, "tool.event"), ctx.now);
    assert_eq!(accesses.len(), 14);
    let grouped = by_invocation(&sink);
    let key = |id: &str| invocation_key("claude-primary", Provider::Claude, id);
    let rows = |id: &str| grouped.get(&key(id)).map(|group| group.iter().map(triple).collect::<Vec<_>>());

    // Explicit arguments, absolute and relative, with their result outcomes.
    assert_eq!(rows("res-read-alpha"), Some(vec![("alpha-src", "read", "explicit_argument", "succeeded")]));
    assert_eq!(rows("res-edit-relative"), Some(vec![("alpha-src", "write", "explicit_argument", "denied")]));
    assert_eq!(rows("res-child-read"), Some(vec![("alpha-src", "read", "explicit_argument", "succeeded")]));
    // Nested roots: one row per source for the same invocation.
    assert_eq!(
        rows("res-read-nested"),
        Some(vec![
            ("alpha-src", "read", "explicit_argument", "succeeded"),
            ("beta-src", "read", "explicit_argument", "succeeded")
        ])
    );
    assert_eq!(
        rows("res-glob"),
        Some(vec![
            ("alpha-src", "search", "explicit_argument", "succeeded"),
            ("beta-src", "search", "explicit_argument", "succeeded")
        ])
    );
    assert_eq!(
        rows("res-write"),
        Some(vec![
            ("alpha-src", "write", "explicit_argument", "succeeded"),
            ("beta-src", "write", "explicit_argument", "succeeded")
        ])
    );
    // Shell text: cd chains, an MSYS alias, an unquoted PowerShell path.
    assert_eq!(rows("res-cd-chain"), Some(vec![("alpha-src", "read", "indirect_shell", "succeeded")]));
    assert_eq!(rows("res-msys"), Some(vec![("alpha-src", "read", "indirect_shell", "unknown")]));
    assert_eq!(rows("res-pwsh"), Some(vec![("alpha-src", "read", "indirect_shell", "failed")]));
    // Connectors: one configured source matches; a URL matches by prefix.
    assert_eq!(rows("res-mcp-alpha"), Some(vec![("alpha-src", "search", "connector", "failed")]));
    assert_eq!(rows("res-webfetch"), Some(vec![("alpha-src", "read", "connector", "unknown")]));
    // No row: a working directory alone, a heredoc body, an out-of-root read,
    // an ambiguous connector, and forms the classifier cannot read.
    for id in
        ["res-grep-cwd", "res-heredoc", "res-read-outside", "res-mcp-shared", "res-python", "res-workflow"]
    {
        assert_eq!(rows(id), None, "{id} must not produce a row");
    }
    // Every record joins an emitted invocation; semantic keys are per (invocation, resource).
    let invocations: HashSet<String> = records(&sink, "tool.event")
        .iter()
        .filter(|row| row["event_kind"] == "invocation")
        .map(|row| row["invocation_key"].as_str().unwrap().to_owned())
        .collect();
    assert!(accesses.iter().all(|row| invocations.contains(row["invocation_key"].as_str().unwrap())));
    let semantic: HashSet<&str> = accesses.iter().map(|row| row["semantic_key"].as_str().unwrap()).collect();
    assert_eq!(semantic.len(), accesses.len());
    let versions: HashSet<&str> =
        accesses.iter().map(|row| row["configuration_version"].as_str().unwrap()).collect();
    assert_eq!(versions.len(), 2, "one opaque token per configured key");
    assert!(versions.iter().all(|version| version.len() == 20 && version.starts_with("cfg:")));

    // Inspection classes and the capability: the opaque script forms dominate.
    let state = State::open(&ctx.state_path).unwrap();
    let counts = state.resource_inspection_counts(CLAUDE_BINDING).unwrap();
    assert_eq!(
        (
            counts.matched,
            counts.unmatched,
            counts.no_evidence,
            counts.unresolved,
            counts.unsupported,
            counts.ambiguous
        ),
        (11, 1, 2, 0, 2, 1)
    );
    assert_eq!(counts.overlapping, 3);
    assert_eq!(counts.inspected(), 17);
    assert_eq!(state.resource_accesses(CLAUDE_BINDING).unwrap().len(), 14);
    assert!(
        state.resource_accesses(CLAUDE_BINDING).unwrap().iter().filter(|row| row.nested_overlap).count() == 6
    );
    drop(state);
    assert_eq!(
        capability(&outcome, CapabilityDimension::Resource),
        (CapabilityState::Partial, Some("unsupported_forms".into()))
    );
    assert_state_private(&ctx, CLAUDE_BINDING, &accesses);

    // A replay changes nothing: same ids, same rows.
    let ids: Vec<_> = accesses.iter().map(|row| row["record_id"].clone()).collect();
    let mut replay = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut replay).unwrap();
    assert_eq!(
        records(&replay, "resource.access").iter().map(|row| row["record_id"].clone()).collect::<Vec<_>>(),
        ids
    );
    let state = State::open(&ctx.state_path).unwrap();
    assert_eq!(state.resource_inspection_counts(CLAUDE_BINDING).unwrap().inspected(), 17);
    assert_eq!(state.resource_accesses(CLAUDE_BINDING).unwrap().len(), 14);
}

#[test]
fn codex_classifies_exec_scripts_patches_shell_forms_and_connectors() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = codex_context(&dir, configuration(), vec![]);
    let mut sink = MemorySink::default();
    let outcome = CodexExecution.collect(&ctx, None, &mut sink).unwrap();
    let accesses = records(&sink, "resource.access");
    assert_valid_and_private(&accesses, ctx.now);
    assert_valid_and_private(&records(&sink, "tool.event"), ctx.now);
    assert_eq!(accesses.len(), 11);
    let grouped = by_invocation(&sink);
    let key = |id: &str| invocation_key("codex-primary", Provider::Codex, id);
    let rows = |id: &str| grouped.get(&key(id)).map(|group| group.iter().map(triple).collect::<Vec<_>>());

    // A relative command operand resolves from the call's workdir (nested root: two rows).
    assert_eq!(
        rows("codex-res-relative"),
        Some(vec![
            ("alpha-src", "read", "indirect_shell", "failed"),
            ("beta-src", "read", "indirect_shell", "failed")
        ])
    );
    // exec scripts: tools.shell_command with a Windows path, tools.apply_patch, tools.view_image.
    assert_eq!(rows("codex-res-exec-pwsh"), Some(vec![("alpha-src", "read", "indirect_shell", "succeeded")]));
    assert_eq!(
        rows("codex-res-exec-patch"),
        Some(vec![("alpha-src", "write", "explicit_argument", "unknown")])
    );
    assert_eq!(
        rows("codex-res-exec-image"),
        Some(vec![
            ("alpha-src", "read", "explicit_argument", "succeeded"),
            ("beta-src", "read", "explicit_argument", "succeeded")
        ])
    );
    // function_call exec_command, a direct patch, a local_shell_call, an unquoted PowerShell path.
    assert_eq!(
        rows("codex-res-exec-command"),
        Some(vec![("alpha-src", "read", "indirect_shell", "succeeded")])
    );
    assert_eq!(
        rows("codex-res-apply-patch"),
        Some(vec![("alpha-src", "write", "explicit_argument", "denied")])
    );
    assert_eq!(
        rows("codex-res-local-shell"),
        Some(vec![("alpha-src", "read", "indirect_shell", "succeeded")])
    );
    assert_eq!(
        rows("codex-res-pwsh-unquoted"),
        Some(vec![("alpha-src", "read", "indirect_shell", "unknown")])
    );
    // The MCP namespace configured once matches; the shared one is ambiguous.
    assert_eq!(rows("codex-res-mcp-alpha"), Some(vec![("alpha-src", "search", "connector", "succeeded")]));
    for id in ["codex-res-workdir-only", "codex-res-mcp-shared", "codex-res-cd-relative"] {
        assert_eq!(rows(id), None, "{id} must not produce a row");
    }
    let state = State::open(&ctx.state_path).unwrap();
    let counts = state.resource_inspection_counts(CODEX_BINDING).unwrap();
    assert_eq!(
        (
            counts.matched,
            counts.unmatched,
            counts.no_evidence,
            counts.unresolved,
            counts.unsupported,
            counts.ambiguous
        ),
        (9, 0, 2, 1, 0, 1)
    );
    assert_eq!(counts.overlapping, 2);
    assert_eq!(state.resource_accesses(CODEX_BINDING).unwrap().len(), 11);
    drop(state);
    assert_eq!(
        capability(&outcome, CapabilityDimension::Resource),
        (CapabilityState::Partial, Some("unresolved_paths".into()))
    );
    assert_state_private(&ctx, CODEX_BINDING, &accesses);

    let ids: Vec<_> = accesses.iter().map(|row| row["record_id"].clone()).collect();
    let mut replay = MemorySink::default();
    CodexExecution.collect(&ctx, None, &mut replay).unwrap();
    assert_eq!(
        records(&replay, "resource.access").iter().map(|row| row["record_id"].clone()).collect::<Vec<_>>(),
        ids
    );
}

#[test]
fn the_local_deny_keeps_rows_on_the_machine() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = claude_context(&dir, configuration(), vec!["execution.resource_attribution".into()]);
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    assert!(records(&sink, "resource.access").is_empty());
    assert!(!records(&sink, "tool.event").is_empty(), "tool events are unaffected by the resource deny");
    assert_eq!(
        capability(&outcome, CapabilityDimension::Resource),
        (CapabilityState::DisabledBySetting, Some("denied_locally".into()))
    );
    // Classification still ran, so lifting the deny needs no rescan.
    let state = State::open(&ctx.state_path).unwrap();
    assert_eq!(state.resource_accesses(CLAUDE_BINDING).unwrap().len(), 14);
    assert_eq!(state.resource_inspection_counts(CLAUDE_BINDING).unwrap().inspected(), 17);
    drop(state);
    assert_state_private(&ctx, CLAUDE_BINDING, &[]);

    let lifted = claude_context(&dir, configuration(), vec![]);
    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&lifted, None, &mut sink).unwrap();
    assert_eq!(records(&sink, "resource.access").len(), 14);
}

#[test]
fn subagent_rows_follow_the_include_subagents_setting() {
    let dir = tempfile::tempdir().unwrap();
    let mut ctx = claude_context(&dir, configuration(), vec![]);
    ctx.settings.execution.include_subagents = false;
    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let accesses = records(&sink, "resource.access");
    assert_eq!(accesses.len(), 13);
    let child = invocation_key("claude-primary", Provider::Claude, "res-child-read");
    assert!(accesses.iter().all(|row| row["invocation_key"] != child));
    let state = State::open(&ctx.state_path).unwrap();
    assert_eq!(state.resource_accesses(CLAUDE_BINDING).unwrap().len(), 14, "the row itself is retained");
    drop(state);

    ctx.settings.execution.include_subagents = true;
    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let accesses = records(&sink, "resource.access");
    assert_eq!(accesses.len(), 14);
    assert!(accesses.iter().any(|row| row["invocation_key"] == child));
}

#[test]
fn lower_detail_levels_and_no_configuration_emit_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut ctx = claude_context(&dir, configuration(), vec![]);
    ctx.settings.execution.detail_level = DetailLevel::Requests;
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    assert!(records(&sink, "resource.access").is_empty());
    assert_eq!(
        capability(&outcome, CapabilityDimension::Resource),
        (CapabilityState::DisabledBySetting, Some("detail_level".into()))
    );
    let state = State::open(&ctx.state_path).unwrap();
    assert_eq!(state.resource_accesses(CLAUDE_BINDING).unwrap().len(), 14, "classified regardless of detail");
    drop(state);
    ctx.settings.execution.detail_level = DetailLevel::BucketsOnly;
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    assert_eq!(
        capability(&outcome, CapabilityDimension::Resource),
        (CapabilityState::DisabledBySetting, Some("detail_level_buckets_only".into()))
    );

    let dir = tempfile::tempdir().unwrap();
    let ctx = claude_context(&dir, ResourceConfiguration::default(), vec![]);
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    assert!(records(&sink, "resource.access").is_empty());
    assert_eq!(
        capability(&outcome, CapabilityDimension::Resource),
        (CapabilityState::DisabledBySetting, Some("no_resources_configured".into()))
    );
    let state = State::open(&ctx.state_path).unwrap();
    assert!(state.resource_accesses(CLAUDE_BINDING).unwrap().is_empty());
    assert_eq!(state.resource_inspection_counts(CLAUDE_BINDING).unwrap().inspected(), 0, "not inspected");
}

#[test]
fn expected_outcomes_are_complete_and_ambiguity_is_partial() {
    let read_outside = concat!(
        r#"{"type":"assistant","timestamp":"2026-09-05T03:00:00.000Z","sessionId":"claude-outside","cwd":"/synthetic/vault-alpha","message":{"id":"outside-1","model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[{"type":"tool_use","id":"outside-read","name":"Read","input":{"file_path":"/synthetic/elsewhere/PRIVATE SENTINEL note.md"}},{"type":"tool_use","id":"outside-grep","name":"Grep","input":{"pattern":"todo"}}]}}"#,
        "\n"
    );
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("outside.jsonl"), read_outside).unwrap();
    let ctx =
        context(&dir, Provider::Claude, CLAUDE_BINDING, "claude-primary", root, configuration(), vec![]);
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    assert!(records(&sink, "resource.access").is_empty());
    assert_eq!(capability(&outcome, CapabilityDimension::Resource), (CapabilityState::Complete, None));
    let state = State::open(&ctx.state_path).unwrap();
    let counts = state.resource_inspection_counts(CLAUDE_BINDING).unwrap();
    assert_eq!((counts.unmatched, counts.no_evidence, counts.inspected()), (1, 1, 2));
    drop(state);
    assert_state_private(&ctx, CLAUDE_BINDING, &[]);

    let ambiguous = concat!(
        r#"{"type":"assistant","timestamp":"2026-09-05T03:00:00.000Z","sessionId":"claude-ambiguous","message":{"id":"ambiguous-1","model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1},"content":[{"type":"tool_use","id":"ambiguous-mcp","name":"mcp__shared__read_note","input":{"name":"PRIVATE SENTINEL note.md"}}]}}"#,
        "\n"
    );
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("ambiguous.jsonl"), ambiguous).unwrap();
    let ctx =
        context(&dir, Provider::Claude, CLAUDE_BINDING, "claude-primary", root, configuration(), vec![]);
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    assert!(records(&sink, "resource.access").is_empty());
    assert_eq!(
        capability(&outcome, CapabilityDimension::Resource),
        (CapabilityState::Partial, Some("ambiguous_connectors".into()))
    );
}

#[test]
fn a_configuration_change_purges_and_reclassifies_retained_history() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = claude_context(&dir, configuration(), vec![]);
    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let before = records(&sink, "resource.access");
    assert!(before.iter().any(|row| row["resource_key"] == "beta-src"));
    let alpha_before =
        before.iter().find(|row| row["resource_key"] == "alpha-src").unwrap()["configuration_version"]
            .as_str()
            .unwrap()
            .to_owned();

    // beta-src is removed and alpha-src loses its Windows root: every old row
    // is gone, the retained transcript is replayed, and alpha-src carries a
    // new token because its own definition changed. The Windows-path calls no
    // longer match; the shared connector now resolves to alpha-src alone.
    let changed = ResourceConfiguration::from_local(
        &[local(
            "alpha-src",
            &["/synthetic/vault-alpha"],
            &["mcp:alpha", "mcp:shared", "url:https://alpha.test/"],
        )],
        Some("/synthetic/home"),
    );
    let ctx = claude_context(&dir, changed, vec![]);
    let mut sink = MemorySink::default();
    let outcome = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    let after = records(&sink, "resource.access");
    assert!(after.iter().all(|row| row["resource_key"] == "alpha-src"));
    assert_eq!(after.len(), 10);
    let key = |id: &str| invocation_key("claude-primary", Provider::Claude, id);
    let has = |id: &str| after.iter().any(|row| row["invocation_key"] == key(id));
    assert!(!has("res-msys") && !has("res-pwsh"));
    assert!(has("res-mcp-shared"));
    let alpha_after = after[0]["configuration_version"].as_str().unwrap();
    assert_ne!(alpha_after, alpha_before);
    assert!(after.iter().all(|row| row["configuration_version"] == alpha_after));
    let state = State::open(&ctx.state_path).unwrap();
    let rows = state.resource_accesses(CLAUDE_BINDING).unwrap();
    assert_eq!(rows.len(), 10);
    assert!(rows.iter().all(|row| !row.nested_overlap));
    let counts = state.resource_inspection_counts(CLAUDE_BINDING).unwrap();
    assert_eq!(
        (counts.matched, counts.unmatched, counts.ambiguous, counts.overlapping, counts.inspected()),
        (10, 3, 0, 0, 17)
    );
    drop(state);
    assert_eq!(
        capability(&outcome, CapabilityDimension::Resource),
        (CapabilityState::Partial, Some("unsupported_forms".into()))
    );
    assert_state_private(&ctx, CLAUDE_BINDING, &after);

    // The same configuration again is the same generation: no purge, same rows.
    let ctx = claude_context(
        &dir,
        ResourceConfiguration::from_local(
            &[local(
                "alpha-src",
                &["/synthetic/vault-alpha"],
                &["mcp:alpha", "mcp:shared", "url:https://alpha.test/"],
            )],
            Some("/synthetic/home"),
        ),
        vec![],
    );
    let mut sink = MemorySink::default();
    ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    assert_eq!(
        records(&sink, "resource.access").iter().map(|row| row["record_id"].clone()).collect::<Vec<_>>(),
        after.iter().map(|row| row["record_id"].clone()).collect::<Vec<_>>()
    );
}
