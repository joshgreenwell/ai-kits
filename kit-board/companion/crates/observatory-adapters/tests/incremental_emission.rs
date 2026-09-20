//! A run emits detail records for the rows that changed since its last
//! emission, not the whole history every time.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use jiff::Timestamp;
use observatory_adapters::EXECUTION_PARSER_VERSION;
use observatory_adapters::claude_execution::ClaudeExecution;
use observatory_adapters::codex_execution::CodexExecution;
use observatory_adapters::emission::{EMISSION_SHAPE, fingerprint};
use observatory_contract::settings::{DetailLevel, ProjectAttribution, ToolDetail};
use observatory_contract::{
    AccountId, Arch, CollectionSettings, Counter, Lit, Platform, Provider, Record, Run, Stamp, Text, Uuid,
};
use observatory_core::adapter::{Adapter, BindingContext, IdentityState, RunContext};
use observatory_core::config::{CompanionConfig, LocalBinding, Secret};
use observatory_core::outbox::build_bodies;
use observatory_core::privacy::PrivacyKey;
use observatory_core::run::{ConfigSource, Prepared, RunSummary, execute};
use observatory_core::state::State;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/usage-v2/tool-detail")
}

struct Fixture {
    dir: tempfile::TempDir,
    binding_id: Uuid,
    install_id: Uuid,
    provider: Provider,
    root: PathBuf,
    run: u32,
}

impl Fixture {
    fn new(provider: Provider, root: PathBuf) -> Self {
        let id = match provider {
            Provider::Claude => "11111111-1111-4111-8111-111111111111",
            _ => "22222222-2222-4222-8222-222222222222",
        };
        Fixture {
            dir: tempfile::tempdir().unwrap(),
            binding_id: Uuid::from_str(id).unwrap(),
            install_id: Uuid::v4(),
            provider,
            root,
            run: 0,
        }
    }

    fn binding(&self) -> BindingContext {
        BindingContext {
            binding_id: self.binding_id.clone(),
            account_id: AccountId::from_str("primary").unwrap(),
            provider: self.provider,
            enabled: true,
            identity_hash: None,
            identity: IdentityState::Confirmed,
            identity_conflict: false,
            roots: vec![self.root.clone()],
            codex_home: None,
            cursor_state_db: None,
        }
    }

    /// One dry, offline run with everything decided locally, as `doctor` builds it.
    fn prepared(&mut self, settings: CollectionSettings) -> Prepared {
        let dir: &Path = self.dir.path();
        let config = CompanionConfig {
            schema_version: Lit,
            url: "https://example.test".into(),
            install_id: self.install_id.clone(),
            key: Secret::new("k".repeat(43)),
            machine_label: "test".into(),
            since: Some("2026-09-01".into()),
            bindings: vec![LocalBinding {
                binding_id: self.binding_id.clone(),
                account_id: AccountId::from_str("primary").unwrap(),
                provider: self.provider,
                roots: Some(vec![self.root.clone()]),
                codex_home: None,
                cursor_state_db: None,
                detailed_report: None,
            }],
            deny: vec![],
            resources: vec![],
            claude_statusline_inbox: None,
        };
        config.save(dir).unwrap();
        self.run += 1;
        let now = Timestamp::from_str(&format!("2026-09-12T00:{:02}:00Z", self.run)).unwrap();
        let ctx = RunContext::new(
            now,
            "2026-09-01".to_owned(),
            observatory_core::pyjson::epoch_text("2026-09-01T00:00:00Z").unwrap(),
            settings,
            3,
            None,
            vec![self.binding()],
            vec![],
            dir.to_path_buf(),
            config.state_path(dir),
            config.statusline_inbox(dir),
            true,
            Duration::from_secs(60),
            PrivacyKey::fixed_for_tests(),
        )
        .with_claude_settings_path(dir.join("claude-settings.json"));
        let lock = observatory_core::lock::acquire(&config.lock_path(dir)).unwrap();
        assert!(lock.is_some());
        Prepared {
            config_dir: dir.to_path_buf(),
            config,
            ctx,
            config_source: ConfigSource::Defaults,
            config_error: None,
            lock,
            offline: true,
        }
    }

    fn state(&self) -> State {
        State::open(&self.dir.path().join(format!("{}.sqlite3", self.install_id))).unwrap()
    }
}

fn settings(tool_detail: ToolDetail) -> CollectionSettings {
    let mut settings = CollectionSettings::defaults();
    settings.execution.detail_level = DetailLevel::RequestsWithTools;
    settings.execution.tool_detail = tool_detail;
    settings
}

fn emitted(summary: &RunSummary) -> u64 {
    assert!(summary.skipped.is_none(), "{summary:?}");
    let adapter = &summary.adapters[0];
    assert_eq!(adapter.invalid, 0);
    adapter.records
}

#[test]
fn claude_emits_only_what_changed_after_the_first_run() {
    let mut fixture = Fixture::new(Provider::Claude, corpus().join("claude/projects"));
    let adapters: Vec<Box<dyn Adapter>> = vec![Box::new(ClaudeExecution)];
    let binding = fixture.binding_id.as_str().to_owned();

    let first = execute(fixture.prepared(settings(ToolDetail::BuiltinOnly)), &adapters).unwrap();
    let all = emitted(&first);
    assert!(all > 0);
    let state = fixture.state();
    assert_eq!(state.record_counts().unwrap().0, all, "every emitted record was stored");
    assert!(state.meta(&format!("emitted:claude_execution:{binding}")).unwrap().is_some());
    drop(state);

    // Nothing changed: no record is rebuilt, hashed, or upserted, and the
    // capability rows the run reports are the same.
    let second = execute(fixture.prepared(settings(ToolDetail::BuiltinOnly)), &adapters).unwrap();
    assert_eq!(emitted(&second), 0);
    assert_eq!(second.adapters[0].capabilities, first.adapters[0].capabilities);
    assert_eq!(fixture.state().record_counts().unwrap().0, all);

    // One request row revised between runs (as a later transcript line would)
    // re-emits that request alone.
    let state = fixture.state();
    let event = state.request_events(&binding).unwrap().into_iter().next().unwrap();
    state.update_event_tokens(&binding, &event.id, [1, 2, 3, 4]).unwrap();
    drop(state);
    let third = execute(fixture.prepared(settings(ToolDetail::BuiltinOnly)), &adapters).unwrap();
    assert_eq!(emitted(&third), 1);
    assert_eq!(fixture.state().record_counts().unwrap().0, all);

    // A setting the record shape depends on re-emits everything once.
    let fourth = execute(fixture.prepared(settings(ToolDetail::HashedCustom)), &adapters).unwrap();
    assert_eq!(emitted(&fourth), all);
    let fifth = execute(fixture.prepared(settings(ToolDetail::HashedCustom)), &adapters).unwrap();
    assert_eq!(emitted(&fifth), 0);
}

/// An install whose last mark was written by the previous emission shape
/// (plain, unkeyed hashes) emits everything once more under the new keys and
/// then settles again.
#[test]
fn an_install_upgraded_from_the_previous_emission_shape_re_emits_once() {
    let mut fixture = Fixture::new(Provider::Claude, corpus().join("claude/projects"));
    let adapters: Vec<Box<dyn Adapter>> = vec![Box::new(ClaudeExecution)];
    let binding = fixture.binding_id.as_str().to_owned();
    let mark_key = format!("emitted:claude_execution:{binding}");

    let first = execute(fixture.prepared(settings(ToolDetail::HashedCustom)), &adapters).unwrap();
    let all = emitted(&first);
    assert!(all > 0);
    let second = execute(fixture.prepared(settings(ToolDetail::HashedCustom)), &adapters).unwrap();
    assert_eq!(emitted(&second), 0);

    let prepared = fixture.prepared(settings(ToolDetail::HashedCustom));
    let current = fingerprint(&prepared.ctx, EXECUTION_PARSER_VERSION, EMISSION_SHAPE);
    let previous = fingerprint(&prepared.ctx, EXECUTION_PARSER_VERSION, "1");
    assert_ne!(previous, current, "the shape bump changes the fingerprint");
    let state = fixture.state();
    let stored = state.meta(&mark_key).unwrap().unwrap();
    let (generation, stored_fingerprint) = stored.split_once(':').unwrap();
    assert_eq!(stored_fingerprint, current);
    // The mark the previous build left: the same generation under the old shape.
    state.set_meta(&mark_key, &format!("{generation}:{previous}")).unwrap();
    drop(state);

    let upgraded = execute(prepared, &adapters).unwrap();
    assert_eq!(emitted(&upgraded), all, "every record is emitted once more under the new keys");
    let stored = fixture.state().meta(&mark_key).unwrap().unwrap();
    assert!(stored.ends_with(&format!(":{current}")), "the mark carries the current shape: {stored}");
    let settled = execute(fixture.prepared(settings(ToolDetail::HashedCustom)), &adapters).unwrap();
    assert_eq!(emitted(&settled), 0);
}

/// The bodies a run would upload carry keyed hashes and never the key itself
/// (project keys are covered by the snapshot corpus, which records `cwd`).
#[test]
fn upload_bodies_carry_keyed_hashes_and_never_the_privacy_key() {
    let mut fixture = Fixture::new(Provider::Claude, corpus().join("claude/projects"));
    let adapters: Vec<Box<dyn Adapter>> = vec![Box::new(ClaudeExecution)];
    let mut settings = settings(ToolDetail::HashedCustom);
    settings.execution.project_attribution = ProjectAttribution::Hashed;
    let prepared = fixture.prepared(settings);
    let key = prepared.ctx.privacy_key.clone();
    let summary = execute(prepared, &adapters).unwrap();
    assert!(emitted(&summary) > 0);

    let state = fixture.state();
    let records: Vec<Record> = state
        .pending_records(usize::MAX)
        .unwrap()
        .iter()
        .map(|row| serde_json::from_str(&row.record).unwrap())
        .collect();
    assert!(!records.is_empty());
    let run = Run {
        run_id: Uuid::v4(),
        started_at: Stamp::from_timestamp(Timestamp::UNIX_EPOCH),
        finished_at: Stamp::from_timestamp(Timestamp::UNIX_EPOCH),
        companion_version: Text::try_from(observatory_core::VERSION.to_owned()).unwrap(),
        platform: Platform::current(),
        arch: Arch::current(),
        settings_version: Counter::saturating(3),
    };
    let bodies = build_bodies(&run, vec![], records, vec![]).unwrap();
    assert!(!bodies.is_empty());
    let key_hex = key.to_hex();
    assert!(bodies.iter().any(|body| body.contains("\"h:")), "hashed custom names are uploaded");
    for body in &bodies {
        assert!(!body.contains(&key_hex), "the privacy key is in an upload body");
        assert!(!body.contains(&key_hex[..16]), "a prefix of the privacy key is in an upload body");
        assert!(!body.contains("privacy_salt") && !body.contains("privacy_key"), "{body}");
    }
}

#[test]
fn codex_emits_only_what_changed_after_the_first_run() {
    let mut fixture = Fixture::new(Provider::Codex, corpus().join("codex/sessions"));
    let adapters: Vec<Box<dyn Adapter>> = vec![Box::new(CodexExecution)];

    let first = execute(fixture.prepared(settings(ToolDetail::BuiltinOnly)), &adapters).unwrap();
    let all = emitted(&first);
    assert!(all > 0);
    let second = execute(fixture.prepared(settings(ToolDetail::BuiltinOnly)), &adapters).unwrap();
    assert_eq!(emitted(&second), 0);
    assert_eq!(second.adapters[0].capabilities, first.adapters[0].capabilities);
    assert_eq!(fixture.state().record_counts().unwrap().0, all);
}
