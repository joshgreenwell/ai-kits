//! A run emits detail records for the rows that changed since its last
//! emission, not the whole history every time.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use jiff::Timestamp;
use observatory_adapters::claude_execution::ClaudeExecution;
use observatory_adapters::codex_execution::CodexExecution;
use observatory_contract::settings::{DetailLevel, ToolDetail};
use observatory_contract::{AccountId, CollectionSettings, Lit, Provider, Uuid};
use observatory_core::adapter::{Adapter, BindingContext, IdentityState, RunContext};
use observatory_core::config::{CompanionConfig, LocalBinding, Secret};
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
