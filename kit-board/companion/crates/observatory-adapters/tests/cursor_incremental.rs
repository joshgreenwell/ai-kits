//! A run over an unchanged Cursor store emits nothing after the first one,
//! and no record it stores carries the run's clock.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use jiff::Timestamp;
use observatory_adapters::cursor_execution::{CursorExecution, fingerprint, mark_key};
use observatory_contract::settings::DetailLevel;
use observatory_contract::{AccountId, CollectionSettings, Lit, Provider, Uuid};
use observatory_core::adapter::{Adapter, BindingContext, IdentityState, RunContext};
use observatory_core::config::{CompanionConfig, LocalBinding, Secret};
use observatory_core::run::{ConfigSource, Prepared, RunSummary, execute};
use observatory_core::state::State;
use rusqlite::Connection;
use serde_json::{Value, json};

struct Fixture {
    dir: tempfile::TempDir,
    binding_id: Uuid,
    install_id: Uuid,
    run: u32,
}

impl Fixture {
    fn new() -> Self {
        Fixture {
            dir: tempfile::tempdir().unwrap(),
            binding_id: Uuid::from_str("33333333-3333-4333-8333-333333333333").unwrap(),
            install_id: Uuid::v4(),
            run: 0,
        }
    }

    fn store(&self) -> PathBuf {
        self.dir.path().join("state.vscdb")
    }

    fn binding(&self) -> BindingContext {
        BindingContext {
            binding_id: self.binding_id.clone(),
            account_id: AccountId::from_str("primary").unwrap(),
            provider: Provider::Cursor,
            enabled: true,
            identity_hash: None,
            identity: IdentityState::Confirmed,
            identity_conflict: false,
            roots: Vec::new(),
            codex_home: None,
            cursor_state_db: Some(self.store()),
        }
    }

    /// The clock of the next run: a distinct minute each time, so a record
    /// stamped with it would be visible.
    fn next_now(&mut self) -> Timestamp {
        self.run += 1;
        Timestamp::from_str(&format!("2026-09-20T22:{:02}:20.569Z", self.run)).unwrap()
    }

    /// One dry, offline run with everything decided locally, as `doctor` builds it.
    fn prepared(&mut self) -> Prepared {
        let dir: &Path = self.dir.path();
        let config = CompanionConfig {
            schema_version: Lit,
            url: "https://example.test".into(),
            install_id: self.install_id.clone(),
            key: Secret::new("k".repeat(43)),
            machine_label: "test".into(),
            since: Some("2025-01-01".into()),
            bindings: vec![LocalBinding {
                binding_id: self.binding_id.clone(),
                account_id: AccountId::from_str("primary").unwrap(),
                provider: Provider::Cursor,
                roots: None,
                codex_home: None,
                cursor_state_db: Some(self.store()),
                detailed_report: None,
            }],
            deny: vec![],
            resources: vec![],
            claude_statusline_inbox: None,
        };
        config.save(dir).unwrap();
        let mut settings = CollectionSettings::defaults();
        settings.execution.detail_level = DetailLevel::Requests;
        settings.providers.cursor = true;
        let now = self.next_now();
        let dir: &Path = self.dir.path();
        let ctx = RunContext::new(
            now,
            "2025-01-01".to_owned(),
            observatory_core::pyjson::epoch_text("2025-01-01T00:00:00Z").unwrap(),
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
            observatory_core::privacy::PrivacyKey::fixed_for_tests(),
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

    fn stored_records(&self) -> Vec<Value> {
        self.state()
            .pending_records(usize::MAX)
            .unwrap()
            .iter()
            .map(|row| serde_json::from_str(&row.record).unwrap())
            .collect()
    }
}

fn open_store(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE, value BLOB);
         CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE, value BLOB);",
    )
    .unwrap();
    conn
}

fn put(conn: &Connection, key: &str, value: Value) {
    conn.execute(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, &value.to_string()],
    )
    .unwrap();
}

fn bubble(input: u64, output: u64, created_at: Option<&str>) -> Value {
    let mut value =
        json!({"type": 2, "text": "SECRET", "tokenCount": {"inputTokens": input, "outputTokens": output}});
    if let Some(created_at) = created_at {
        value["createdAt"] = json!(created_at);
    }
    value
}

fn synthetic_store(path: &Path) {
    let conn = open_store(path);
    put(&conn, "composerData:comp-1", json!({"composerId": "comp-1", "createdAt": 1_757_800_000_000i64}));
    put(&conn, "bubbleId:comp-1:own-time", bubble(5728, 191, Some("2025-09-14T10:00:00.250Z")));
    put(&conn, "bubbleId:comp-1:composer-time", bubble(15124, 2436, None));
    put(&conn, "bubbleId:comp-1:zero", bubble(0, 0, Some("2025-09-14T10:01:00.000Z")));
    put(&conn, "bubbleId:comp-orphan:no-time", bubble(7, 1, None));
}

fn emitted(summary: &RunSummary) -> u64 {
    assert!(summary.skipped.is_none(), "{summary:?}");
    let adapter = &summary.adapters[0];
    assert_eq!(adapter.invalid, 0, "{summary:?}");
    adapter.records
}

#[test]
fn a_run_emits_cursor_records_once_and_never_at_the_run_clock() {
    let mut fixture = Fixture::new();
    synthetic_store(&fixture.store());
    let adapters: Vec<Box<dyn Adapter>> = vec![Box::new(CursorExecution)];
    let binding = fixture.binding_id.as_str().to_owned();

    let first = execute(fixture.prepared(), &adapters).unwrap();
    assert_eq!(emitted(&first), 2, "{first:?}");
    assert_eq!(first.adapters[0].malformed, 1, "the bubble without a store time is counted");
    let state = fixture.state();
    assert_eq!(state.record_counts().unwrap().0, 2, "every emitted record was stored");
    assert_eq!(state.cursor_emitted(&binding).unwrap().len(), 2, "the marks followed the records");
    assert_eq!(
        state.meta(&mark_key(&binding)).unwrap().as_deref(),
        Some(fingerprint(DetailLevel::Requests).as_str())
    );
    drop(state);
    let stored = fixture.stored_records();
    for record in &stored {
        for field in ["observed_at", "ended_at"] {
            let value = record[field].as_str().unwrap();
            assert!(value.starts_with("2025-09-1"), "{field} is a store time: {record}");
            assert!(!value.starts_with("2026-09-20T22:"), "{field} is the run clock: {record}");
        }
    }

    // The same store again, at a later clock: nothing is rebuilt or revised.
    let second = execute(fixture.prepared(), &adapters).unwrap();
    assert_eq!(emitted(&second), 0);
    assert_eq!(second.adapters[0].capabilities, first.adapters[0].capabilities);
    assert_eq!(fixture.stored_records(), stored, "the stored records did not move");

    // One bubble's counters change: that record alone is emitted, and it settles.
    put(
        &open_store(&fixture.store()),
        "bubbleId:comp-1:own-time",
        bubble(5728, 300, Some("2025-09-14T10:00:00.250Z")),
    );
    let third = execute(fixture.prepared(), &adapters).unwrap();
    assert_eq!(emitted(&third), 1);
    assert_eq!(fixture.state().record_counts().unwrap().0, 2);
    let fourth = execute(fixture.prepared(), &adapters).unwrap();
    assert_eq!(emitted(&fourth), 0);
}
