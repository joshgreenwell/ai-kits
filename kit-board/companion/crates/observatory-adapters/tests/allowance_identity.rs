//! Identity binding for statusline allowance readings: stamped samples bind to
//! the binding whose confirmed hash they carry, whichever account is signed in
//! now; unsafe samples are quarantined, never emitted, released when a binding
//! gains the hash, and pruned only when nothing can pair with them. The
//! `allowance` capability row reads that evidence first and the hook
//! installation only when there is none.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use jiff::Timestamp;
use observatory_adapters::claude_account::{ClaudeAccount, PARSER_VERSION};
use observatory_adapters::claude_execution::ClaudeExecution;
use observatory_adapters::codex_execution::CodexExecution;
use observatory_adapters::readings::{
    QuarantineReason, ingest_statusline_inbox, prune_quarantine, release_quarantined,
};
use observatory_contract::settings::{ClaudeReader, CodexReader};
use observatory_contract::{
    AccountId, CapabilityDimension, CapabilityState, CollectionSettings, CoverageState, DetailCode, Provider,
    Sha256Hex, Uuid,
};
use observatory_core::adapter::{
    Adapter, BindingContext, IdentityState, MemorySink, Outcome, Preflight, RunContext,
};
use observatory_core::inbox::STATUS_SIDECAR;
use observatory_core::state::State;
use serde_json::{Value, json};

const NOW: &str = "2026-09-12T00:00:00Z";
const BINDING_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BINDING_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

fn hash(fill: char) -> Sha256Hex {
    Sha256Hex::try_from(std::iter::repeat_n(fill, 64).collect::<String>()).unwrap()
}

struct Harness {
    dir: tempfile::TempDir,
}

impl Harness {
    fn new() -> Self {
        Harness { dir: tempfile::tempdir().unwrap() }
    }

    fn inbox(&self) -> PathBuf {
        self.dir.path().join("inbox").join("claude-statusline")
    }

    fn settings_path(&self) -> PathBuf {
        self.dir.path().join("claude-settings.json")
    }

    fn context(&self, bindings: Vec<BindingContext>) -> RunContext {
        self.context_with(bindings, CollectionSettings::defaults())
    }

    fn context_with(&self, bindings: Vec<BindingContext>, settings: CollectionSettings) -> RunContext {
        self.context_denying(bindings, settings, &[])
    }

    fn context_denying(
        &self,
        bindings: Vec<BindingContext>,
        settings: CollectionSettings,
        deny: &[&str],
    ) -> RunContext {
        RunContext::new(
            Timestamp::from_str(NOW).unwrap(),
            "2026-09-01".to_owned(),
            observatory_core::pyjson::epoch_text("2026-09-01T00:00:00Z").unwrap(),
            settings,
            3,
            None,
            bindings,
            deny.iter().map(|entry| (*entry).to_owned()).collect(),
            self.dir.path().to_path_buf(),
            self.dir.path().join("state.sqlite3"),
            self.inbox(),
            true,
            Duration::from_secs(60),
        )
        .with_claude_settings_path(self.settings_path())
    }

    /// One part file of samples in the inbox.
    fn write_part(&self, name: &str, samples: &[Value]) {
        fs::create_dir_all(self.inbox()).unwrap();
        fs::write(self.inbox().join(name), Value::Array(samples.to_vec()).to_string()).unwrap();
    }

    /// The Claude settings file with our hook naming a configuration directory.
    fn install_hook(&self, config_dir: &Path) {
        let command =
            format!("\"/synthetic/observatory\" --config-dir \"{}\" statusline", config_dir.display());
        let settings = json!({"statusLine": {"type": "command", "command": command, "padding": 0}});
        fs::write(self.settings_path(), settings.to_string()).unwrap();
    }

    /// A sidecar beside the inbox with the given last invocation and windows.
    fn write_sidecar(&self, last_invocation_at: &str, offered_windows_ever: &[&str]) {
        fs::create_dir_all(self.inbox()).unwrap();
        let sidecar = json!({
            "last_invocation_at": last_invocation_at,
            "invocations": 12,
            "last_offered_at": last_invocation_at,
            "offered_windows_ever": offered_windows_ever,
            "published_windows": [],
            "last_published_at": null
        });
        fs::write(self.inbox().parent().unwrap().join(STATUS_SIDECAR), sidecar.to_string()).unwrap();
    }

    fn state(&self) -> State {
        State::open(&self.dir.path().join("state.sqlite3")).unwrap()
    }
}

fn binding(
    id: &str,
    account: &str,
    identity_hash: Option<Sha256Hex>,
    identity: IdentityState,
    identity_conflict: bool,
) -> BindingContext {
    BindingContext {
        binding_id: Uuid::from_str(id).unwrap(),
        account_id: AccountId::from_str(account).unwrap(),
        provider: Provider::Claude,
        enabled: true,
        identity_hash,
        identity,
        identity_conflict,
        roots: vec![],
        codex_home: None,
        cursor_state_db: None,
    }
}

fn confirmed(id: &str, account: &str, fill: char) -> BindingContext {
    binding(id, account, Some(hash(fill)), IdentityState::Confirmed, false)
}

/// A five-hour sample observed at `observed_at` (`2026-09-11T23:MM:00Z`), stamped or not.
fn sample(minute: u32, used: f64, stamp: Option<&Sha256Hex>) -> Value {
    let mut value = json!({
        "window_key": "five_hour",
        "label": "Claude · 5h",
        "observed_at": format!("2026-09-11T23:{minute:02}:00Z"),
        "used_percent": used,
        "resets_at": "2026-09-12T02:00:00Z",
        "window_minutes": 300
    });
    if let Some(stamp) = stamp {
        value["identity_hash"] = json!(stamp.as_str());
    }
    value
}

fn collect(ctx: &RunContext) -> (Outcome, MemorySink) {
    assert_eq!(ClaudeAccount.preflight(ctx), Preflight::Ready);
    let mut sink = MemorySink::default();
    let outcome = ClaudeAccount.collect(ctx, None, &mut sink).unwrap();
    for emitted in &sink.records {
        let mut violations = Vec::new();
        emitted.record.validate(ctx.now, "record", &mut violations);
        assert!(violations.is_empty(), "{violations:?}");
        let wire = serde_json::to_string(&emitted.record).unwrap();
        assert!(!wire.contains("identity_hash"), "the stamp stays local: {wire}");
        assert!(!wire.contains(&"a".repeat(64)) && !wire.contains(&"b".repeat(64)), "hash leaked: {wire}");
    }
    (outcome, sink)
}

fn allowance(outcome: &Outcome) -> (CapabilityState, Option<String>) {
    let rows = outcome.capabilities.as_ref().expect("the account adapter reports capabilities");
    assert_eq!(rows.len(), 1, "one allowance row: {rows:?}");
    let row = &rows[0];
    assert_eq!(row.dimension, CapabilityDimension::Allowance);
    (row.state, row.detail_code.as_ref().map(|code| code.as_str().to_owned()))
}

/// `(binding_id, observed_at)` of every emitted reading, sorted.
fn readings(sink: &MemorySink) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = sink
        .records
        .iter()
        .map(|emitted| {
            let value = serde_json::to_value(&emitted.record).unwrap();
            assert_eq!(value["record_type"], "allowance.reading");
            assert_eq!(value["adapter"], "claude_account");
            assert_eq!(value["reader"], "statusline");
            assert_eq!(value["channel"], "hook_snapshot");
            assert_eq!(value["parser_version"], PARSER_VERSION);
            (
                value["binding_id"].as_str().unwrap().to_owned(),
                value["observed_at"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    out.sort();
    out
}

fn held(state: &State) -> BTreeMap<String, u64> {
    state.quarantine_counts().unwrap()
}

#[test]
fn stamped_samples_bind_to_their_own_binding_whichever_account_is_signed_in() {
    let h = Harness::new();
    // B is `Changed` because A's account is signed in now; that is not a conflict.
    let b = binding(BINDING_B, "claude-second", Some(hash('b')), IdentityState::Changed, false);
    assert!(!b.runnable(), "the transcript scan still skips a switched binding");
    let ctx = h.context(vec![confirmed(BINDING_A, "claude-primary", 'a'), b]);
    h.write_part(
        "2026-09-11T23-1789254000000000.json",
        &[sample(0, 20.0, Some(&hash('a'))), sample(5, 61.5, Some(&hash('b')))],
    );
    let (outcome, sink) = collect(&ctx);
    assert_eq!(outcome.state, CoverageState::Ok);
    assert_eq!(outcome.records_emitted, 2);
    assert_eq!(outcome.files, 1);
    assert_eq!(outcome.malformed, 0);
    assert_eq!(
        readings(&sink),
        vec![
            (BINDING_A.to_owned(), "2026-09-11T23:00:00Z".to_owned()),
            (BINDING_B.to_owned(), "2026-09-11T23:05:00Z".to_owned())
        ]
    );
    assert_eq!(allowance(&outcome), (CapabilityState::Complete, None));
    assert!(held(&h.state()).is_empty());
}

#[test]
fn identical_stamped_readings_remain_distinct_across_accounts() {
    let h = Harness::new();
    let a = confirmed(BINDING_A, "claude-primary", 'a');
    let b = confirmed(BINDING_B, "claude-second", 'b');
    let ctx = h.context(vec![a, b]);
    let first = sample(0, 20.0, Some(&hash('a')));
    let mut second = first.clone();
    second["identity_hash"] = json!(hash('b').as_str());
    h.write_part("2026-09-11T23-1.json", &[first, second]);

    let (outcome, sink) = collect(&ctx);
    assert_eq!(outcome.records_emitted, 2);
    assert_eq!(
        readings(&sink),
        vec![
            (BINDING_A.to_owned(), "2026-09-11T23:00:00Z".to_owned()),
            (BINDING_B.to_owned(), "2026-09-11T23:00:00Z".to_owned()),
        ],
        "the local replay key includes the stamp even though the emitted records do not"
    );
    assert!(held(&h.state()).is_empty());
}

#[test]
fn a_binding_in_conflict_keeps_its_samples_in_quarantine_as_unpaired() {
    let h = Harness::new();
    let a = binding(BINDING_A, "claude-primary", Some(hash('a')), IdentityState::Changed, true);
    let ctx = h.context(vec![a, confirmed(BINDING_B, "claude-second", 'b')]);
    h.write_part(
        "2026-09-11T23-1.json",
        &[sample(0, 20.0, Some(&hash('a'))), sample(1, 30.0, Some(&hash('b')))],
    );
    let (outcome, sink) = collect(&ctx);
    assert_eq!(readings(&sink), vec![(BINDING_B.to_owned(), "2026-09-11T23:01:00Z".to_owned())]);
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("unpaired_identity".into())));
    let state = h.state();
    assert_eq!(held(&state), BTreeMap::from([("unpaired_identity".to_owned(), 1)]));
    assert!(state.dirty_allowance_slots(BINDING_A).unwrap().is_empty(), "held rows are not slots");
    assert!(state.dirty_allowance_slots(BINDING_B).unwrap().is_empty(), "emitted slots are clean");
    let row = &state.quarantined_samples().unwrap()[0];
    assert_eq!(row.identity_hash.as_deref(), Some(hash('a').as_str()));
    assert!(!row.payload.contains("identity_hash"), "the digest excludes the stamp and so does the payload");
}

#[test]
fn an_unstamped_sample_binds_only_to_a_lone_confirmed_binding() {
    // One confirmed binding: an older hook's sample binds.
    let h = Harness::new();
    let ctx = h.context(vec![confirmed(BINDING_A, "claude-primary", 'a')]);
    h.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, None)]);
    let (outcome, sink) = collect(&ctx);
    assert_eq!(readings(&sink).len(), 1);
    assert_eq!(allowance(&outcome), (CapabilityState::Complete, None));

    // One binding that is not confirmed: held as `identity_unconfirmed` for that binding.
    let h = Harness::new();
    let ctx = h.context(vec![binding(BINDING_A, "claude-primary", None, IdentityState::Unconfirmed, false)]);
    h.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, None)]);
    let (outcome, sink) = collect(&ctx);
    assert!(sink.records.is_empty());
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("identity_unconfirmed".into())));
    let state = h.state();
    assert_eq!(held(&state), BTreeMap::from([("identity_unconfirmed".to_owned(), 1)]));
    let row = &state.quarantined_samples().unwrap()[0];
    assert_eq!((row.identity_hash.as_deref(), row.candidate_binding_id.as_deref()), (None, Some(BINDING_A)));

    // Two bindings: held as `identity_ambiguous`, and nothing reaches the sink or the slots.
    let h = Harness::new();
    let ctx = h.context(vec![
        confirmed(BINDING_A, "claude-primary", 'a'),
        confirmed(BINDING_B, "claude-second", 'b'),
    ]);
    h.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, None), sample(1, 21.0, None)]);
    let (outcome, sink) = collect(&ctx);
    assert!(sink.records.is_empty());
    assert_eq!(outcome.records_emitted, 0);
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("identity_ambiguous".into())));
    let state = h.state();
    assert_eq!(held(&state), BTreeMap::from([("identity_ambiguous".to_owned(), 2)]));
    for id in [BINDING_A, BINDING_B] {
        assert!(state.dirty_allowance_slots(id).unwrap().is_empty());
        assert_eq!(state.newest_allowance_observed_at(id).unwrap(), None);
    }
    assert!(state.quarantined_samples().unwrap().iter().all(|row| row.candidate_binding_id.is_none()));
}

/// Two enabled bindings both without a hash (`prepare` posts neither's evidence,
/// since it is ambiguous between them): stamped samples are unpaired, unstamped
/// ones ambiguous. Disabling one binding in the Observatory leaves one
/// candidate, which confirms; its stamped samples are then released, while the
/// unstamped ones stay held.
#[test]
fn two_unconfirmed_bindings_hold_everything_until_one_is_disabled_and_the_other_confirms() {
    let h = Harness::new();
    h.write_sidecar("2026-09-11T23:50:00Z", &["five_hour"]);
    h.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, Some(&hash('a'))), sample(1, 21.0, None)]);
    let a = binding(BINDING_A, "claude-primary", None, IdentityState::Unconfirmed, false);
    let b = binding(BINDING_B, "claude-second", None, IdentityState::Unconfirmed, false);
    let (outcome, sink) = collect(&h.context(vec![a.clone(), b.clone()]));
    assert!(sink.records.is_empty());
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("identity_ambiguous".into())));
    assert_eq!(
        held(&h.state()),
        BTreeMap::from([("identity_ambiguous".to_owned(), 1), ("unpaired_identity".to_owned(), 1)])
    );

    // B disabled, A confirmed with the hash it observed: the stamped row is A's.
    let (outcome, sink) = collect(&h.context(vec![
        confirmed(BINDING_A, "claude-primary", 'a'),
        BindingContext { enabled: false, ..b.clone() },
    ]));
    assert_eq!(readings(&sink), vec![(BINDING_A.to_owned(), "2026-09-11T23:00:00Z".to_owned())]);
    assert_eq!(held(&h.state()), BTreeMap::from([("identity_ambiguous".to_owned(), 1)]));
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("quarantined_samples".into())));
}

/// An unstamped row held as `identity_unconfirmed` names the lone binding it met
/// and is released only to that binding, once it is confirmed; not to whichever
/// binding is the lone confirmed one later.
#[test]
fn an_unconfirmed_hold_is_released_only_to_the_binding_it_was_held_for() {
    let h = Harness::new();
    // A fresh sidecar, so the row reads the held rows rather than the hook installation.
    h.write_sidecar("2026-09-11T23:50:00Z", &["five_hour"]);
    h.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, None)]);
    let waiting = binding(BINDING_A, "claude-primary", None, IdentityState::Unconfirmed, false);
    let (outcome, sink) = collect(&h.context(vec![waiting.clone()]));
    assert!(sink.records.is_empty());
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("identity_unconfirmed".into())));

    // A is disabled and B, confirmed, is now the lone enabled binding: the row is not B's.
    let disabled = BindingContext { enabled: false, ..waiting.clone() };
    let (outcome, sink) = collect(&h.context(vec![disabled, confirmed(BINDING_B, "claude-second", 'b')]));
    assert!(sink.records.is_empty(), "an unstamped hold never moves to another binding");
    assert_eq!(held(&h.state()), BTreeMap::from([("identity_unconfirmed".to_owned(), 1)]));
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("quarantined_samples".into())));

    // A confirmed but in conflict does not take it either.
    let conflict = binding(BINDING_A, "claude-primary", Some(hash('a')), IdentityState::Changed, true);
    let (_, sink) = collect(&h.context(vec![conflict]));
    assert!(sink.records.is_empty());
    assert_eq!(held(&h.state()), BTreeMap::from([("identity_unconfirmed".to_owned(), 1)]));

    // A confirmed: released to A, emitted once, and a replay adds nothing.
    let settled = h.context(vec![confirmed(BINDING_A, "claude-primary", 'a')]);
    let (outcome, sink) = collect(&settled);
    assert_eq!(readings(&sink), vec![(BINDING_A.to_owned(), "2026-09-11T23:00:00Z".to_owned())]);
    assert_eq!(allowance(&outcome), (CapabilityState::Complete, None));
    assert!(held(&h.state()).is_empty());
    let (_, sink) = collect(&settled);
    assert!(sink.records.is_empty());
}

/// An unstamped row held as `identity_ambiguous` is never released: no later
/// change of bindings can say whose reading it was. Retention prunes it.
#[test]
fn an_ambiguous_unstamped_hold_is_never_released_only_pruned() {
    let h = Harness::new();
    h.write_sidecar("2026-09-11T23:50:00Z", &["five_hour"]);
    h.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, None)]);
    let a = confirmed(BINDING_A, "claude-primary", 'a');
    let b = confirmed(BINDING_B, "claude-second", 'b');
    let (outcome, sink) = collect(&h.context(vec![a.clone(), b.clone()]));
    assert!(sink.records.is_empty());
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("identity_ambiguous".into())));

    // B disabled: A is the lone confirmed binding, which would bind a fresh unstamped
    // sample, but the held one stays held.
    let lone = h.context(vec![a.clone(), BindingContext { enabled: false, ..b.clone() }]);
    let (outcome, sink) = collect(&lone);
    assert!(sink.records.is_empty());
    assert_eq!(held(&h.state()), BTreeMap::from([("identity_ambiguous".to_owned(), 1)]));
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("quarantined_samples".into())));
    assert!(h.state().dirty_allowance_slots(BINDING_A).unwrap().is_empty());
    let state = h.state();
    assert_eq!(release_quarantined(&state, &[&a]).unwrap(), 0);

    // Only retention removes it: unstamped rows are never pairable.
    let cutoff_ctx = h.context(vec![a.clone()]);
    assert_eq!(prune_quarantine(&state, &cutoff_ctx, &[&a]).unwrap(), 0, "held today, inside retention");
    let old = "2026-08-20T00:00:00.000Z";
    state
        .quarantine_sample(
            "old-ambiguous",
            &sample(1, 21.0, None).to_string(),
            None,
            "identity_ambiguous",
            old,
            None,
        )
        .unwrap();
    assert_eq!(prune_quarantine(&state, &cutoff_ctx, &[&a]).unwrap(), 1);
}

/// A local deny of the statusline reader reaches the fallback under `oauth_usage`,
/// whose effective gate names the OAuth reader: the adapter still runs but reads
/// nothing and reports the deny.
#[test]
fn a_statusline_deny_keeps_the_oauth_usage_fallback_from_reading() {
    let h = Harness::new();
    let mut settings = CollectionSettings::defaults();
    settings.allowance.claude_reader = ClaudeReader::OauthUsage;
    let a = confirmed(BINDING_A, "claude-primary", 'a');
    h.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, Some(&hash('a')))]);
    for entry in ["allowance.claude_reader.statusline", "allowance.claude_reader"] {
        let ctx = h.context_denying(vec![a.clone()], settings.clone(), &[entry]);
        // The run-level gate under `oauth_usage` names the other reader, so the adapter runs.
        let decided = observatory_core::effective::effective(
            observatory_contract::Adapter::ClaudeAccount,
            &settings,
            &ctx.deny,
            &ctx.bindings,
        );
        assert_eq!(
            decided.runs,
            entry != "allowance.claude_reader",
            "{entry}: only the prefix entry reaches the gate"
        );
        let (outcome, sink) = collect(&ctx);
        assert!(sink.records.is_empty(), "{entry}");
        assert_eq!((outcome.state, outcome.detail), (CoverageState::DeniedLocally, Some(DetailCode::Denied)));
        assert_eq!(outcome.records_emitted, 0);
        assert_eq!(outcome.files, 0, "{entry}: the inbox is not read");
        assert_eq!(allowance(&outcome), (CapabilityState::DisabledBySetting, Some("denied_locally".into())));
        let state = h.state();
        assert!(state.dirty_allowance_slots(BINDING_A).unwrap().is_empty(), "{entry}: nothing bound");
        assert!(state.quarantined_samples().unwrap().is_empty(), "{entry}: nothing held");
    }
    // An unrelated deny leaves the fallback reading.
    let ctx = h.context_denying(vec![a.clone()], settings.clone(), &["allowance.codex_reader"]);
    let (outcome, sink) = collect(&ctx);
    assert_eq!(sink.records.len(), 1);
    assert_eq!((outcome.state, outcome.detail), (CoverageState::Partial, Some(DetailCode::NotImplemented)));
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("reader_fallback_statusline".into())));
}

/// The sibling-hash case: the second binding's evidence equalled the first's
/// server hash, so confirmation was skipped and it stays `Unconfirmed` with no
/// hash. Stamped samples still bind to the confirmed binding; unstamped ones
/// cannot be told apart and are held as ambiguous.
#[test]
fn a_sibling_left_unconfirmed_makes_unstamped_samples_ambiguous_but_not_stamped_ones() {
    let h = Harness::new();
    let ctx = h.context(vec![
        confirmed(BINDING_A, "claude-primary", 'a'),
        binding(BINDING_B, "claude-second", None, IdentityState::Unconfirmed, false),
    ]);
    h.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, None), sample(1, 21.0, Some(&hash('a')))]);
    let (outcome, sink) = collect(&ctx);
    assert_eq!(readings(&sink), vec![(BINDING_A.to_owned(), "2026-09-11T23:01:00Z".to_owned())]);
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("identity_ambiguous".into())));
    assert_eq!(held(&h.state()), BTreeMap::from([("identity_ambiguous".to_owned(), 1)]));
}

#[test]
fn a_held_sample_is_released_once_its_binding_gains_the_hash() {
    let h = Harness::new();
    h.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, Some(&hash('a')))]);
    let first = h.context(vec![
        binding(BINDING_A, "claude-primary", None, IdentityState::Unconfirmed, false),
        confirmed(BINDING_B, "claude-second", 'b'),
    ]);
    let (outcome, sink) = collect(&first);
    assert!(sink.records.is_empty());
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("unpaired_identity".into())));

    // The next run sees A confirmed with that hash: the row is released and emitted once.
    let second = h.context(vec![
        confirmed(BINDING_A, "claude-primary", 'a'),
        confirmed(BINDING_B, "claude-second", 'b'),
    ]);
    let (outcome, sink) = collect(&second);
    assert_eq!(readings(&sink), vec![(BINDING_A.to_owned(), "2026-09-11T23:00:00Z".to_owned())]);
    assert_eq!(allowance(&outcome), (CapabilityState::Complete, None));
    assert!(held(&h.state()).is_empty());

    // A third run replays the same part file: the digest already exists, nothing new.
    let (outcome, sink) = collect(&second);
    assert!(sink.records.is_empty());
    assert_eq!(outcome.records_emitted, 0);
    assert_eq!(allowance(&outcome), (CapabilityState::Unsupported, Some("hook_not_installed".into())));
}

#[test]
fn a_replayed_digest_is_skipped_before_any_binding_decision() {
    let h = Harness::new();
    let a = confirmed(BINDING_A, "claude-primary", 'a');
    let ctx = h.context(vec![a.clone()]);
    // Two sessions wrote the same stamped reading. A third file carries the same
    // meter fields without identity evidence, so it receives the legacy local key
    // rather than suppressing a possibly different account's observation.
    h.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, Some(&hash('a')))]);
    h.write_part("2026-09-11T23-2.json", &[sample(0, 20.0, Some(&hash('a')))]);
    h.write_part("2026-09-11T23-3.json", &[sample(0, 20.0, None)]);
    let state = h.state();
    let summary = ingest_statusline_inbox(&state, &ctx, &[&a]).unwrap();
    assert_eq!((summary.files, summary.bound, summary.skipped_existing), (3, 2, 1));
    assert_eq!(summary.quarantined_total(), 0);
    assert_eq!(summary.unstamped, 1, "identity evidence participates in the replay key");
    assert_eq!(summary.newest_bound_observed_at.as_deref(), Some("2026-09-11T23:00:00Z"));
    let again = ingest_statusline_inbox(&state, &ctx, &[&a]).unwrap();
    assert_eq!((again.bound, again.skipped_existing), (0, 3));

    // A digest already held in quarantine is skipped the same way.
    let unconfirmed = binding(BINDING_B, "claude-second", None, IdentityState::Unconfirmed, false);
    let other = Harness::new();
    other.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, None)]);
    other.write_part("2026-09-11T23-2.json", &[sample(0, 20.0, None)]);
    let ctx = other.context(vec![unconfirmed.clone()]);
    let summary = ingest_statusline_inbox(&other.state(), &ctx, &[&unconfirmed]).unwrap();
    assert_eq!((summary.bound, summary.skipped_existing, summary.quarantined_total()), (0, 1, 1));
    assert_eq!(summary.quarantined[&QuarantineReason::IdentityUnconfirmed], 1);
}

#[test]
fn quarantine_pruning_keeps_rows_that_still_pair_with_a_binding() {
    let h = Harness::new();
    let state = h.state();
    let payload = sample(0, 20.0, None).to_string();
    let old = "2026-08-20T00:00:00.000Z";
    let fresh = "2026-09-11T00:00:00.000Z";
    state
        .quarantine_sample("pairs-with-a", &payload, Some(hash('a').as_str()), "unpaired_identity", old, None)
        .unwrap();
    state
        .quarantine_sample("nobody", &payload, Some(hash('c').as_str()), "unpaired_identity", old, None)
        .unwrap();
    state.quarantine_sample("unstamped", &payload, None, "identity_ambiguous", old, None).unwrap();
    state.quarantine_sample("recent", &payload, None, "identity_ambiguous", fresh, None).unwrap();
    // A waits for its conflict to clear; its row is pairable and stays.
    let a = binding(BINDING_A, "claude-primary", Some(hash('a')), IdentityState::Changed, true);
    let b = confirmed(BINDING_B, "claude-second", 'b');
    let ctx = h.context(vec![a.clone(), b.clone()]);
    assert_eq!(prune_quarantine(&state, &ctx, &[&a, &b]).unwrap(), 2);
    let slots: Vec<String> = state.quarantined_samples().unwrap().into_iter().map(|row| row.slot).collect();
    assert_eq!(slots, vec!["pairs-with-a", "recent"]);
    // Nothing is released while the conflict stands.
    assert_eq!(release_quarantined(&state, &[&a, &b]).unwrap(), 0);
    assert!(state.dirty_allowance_slots(BINDING_A).unwrap().is_empty());
}

#[test]
fn without_samples_the_row_reports_the_hook_or_the_idle_meter() {
    let h = Harness::new();
    let ctx = h.context(vec![confirmed(BINDING_A, "claude-primary", 'a')]);
    // No inbox, no sidecar, no settings file.
    let (outcome, _) = collect(&ctx);
    assert_eq!(outcome.stores_discovered, 0);
    assert_eq!(allowance(&outcome), (CapabilityState::Unsupported, Some("hook_not_installed".into())));

    // The hook is installed for this directory but never ran.
    h.install_hook(h.dir.path());
    let (outcome, _) = collect(&ctx);
    assert_eq!(allowance(&outcome), (CapabilityState::Unknown, Some("hook_not_executing".into())));

    // The hook names another directory: its samples land where this run never reads.
    h.install_hook(&h.dir.path().join("elsewhere"));
    let (outcome, _) = collect(&ctx);
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("hook_config_dir_mismatch".into())));
    h.install_hook(h.dir.path());

    // A stale sidecar is no evidence either.
    h.write_sidecar("2026-09-09T00:00:00Z", &["five_hour"]);
    let (outcome, _) = collect(&ctx);
    assert_eq!(allowance(&outcome), (CapabilityState::Unknown, Some("hook_not_executing".into())));

    // A fresh sidecar proves the hook runs; an idle meter is complete, with no recent samples.
    h.write_sidecar("2026-09-11T23:50:00Z", &["five_hour", "seven_day"]);
    let (outcome, _) = collect(&ctx);
    assert_eq!(outcome.stores_discovered, 1);
    assert_eq!(allowance(&outcome), (CapabilityState::Complete, Some("no_recent_samples".into())));

    // A hook that runs but was never offered a meter.
    h.write_sidecar("2026-09-11T23:50:00Z", &[]);
    let (outcome, _) = collect(&ctx);
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("no_samples_offered".into())));

    // A sample older than the threshold: complete, but not recent.
    h.write_sidecar("2026-09-11T23:50:00Z", &["five_hour"]);
    h.write_part(
        "2026-09-11T20-1.json",
        &[json!({
            "window_key": "five_hour", "label": "Claude · 5h", "observed_at": "2026-09-11T20:00:00Z",
            "used_percent": 5, "resets_at": "2026-09-11T23:00:00Z", "window_minutes": 300,
            "identity_hash": hash('a').as_str()
        })],
    );
    let (outcome, sink) = collect(&ctx);
    assert_eq!(sink.records.len(), 1);
    assert_eq!(allowance(&outcome), (CapabilityState::Complete, Some("no_recent_samples".into())));
    // A fresh one clears the detail.
    h.write_part("2026-09-11T23-1.json", &[sample(30, 20.0, Some(&hash('a')))]);
    let (outcome, _) = collect(&ctx);
    assert_eq!(allowance(&outcome), (CapabilityState::Complete, None));
}

#[test]
fn the_freshness_threshold_follows_the_cadence_with_a_floor() {
    for (cadence, minutes_old, fresh) in
        [(60, 134, true), (60, 136, false), (15, 119, true), (15, 121, false)]
    {
        let h = Harness::new();
        let mut settings = CollectionSettings::defaults();
        settings.cadence_minutes = observatory_contract::settings::Cadence::try_from(cadence).unwrap();
        let ctx = h.context_with(vec![confirmed(BINDING_A, "claude-primary", 'a')], settings);
        let observed =
            Timestamp::from_str(NOW).unwrap().checked_sub(Duration::from_secs(minutes_old * 60)).unwrap();
        let observed_text = observatory_core::inbox::py_isoformat(observed);
        h.write_part(
            "2026-09-11T21-1.json",
            &[json!({
                "window_key": "five_hour", "label": "Claude · 5h", "observed_at": observed_text,
                "used_percent": 5, "resets_at": "2026-09-12T02:00:00Z", "window_minutes": 300,
                "identity_hash": hash('a').as_str()
            })],
        );
        let (outcome, _) = collect(&ctx);
        let expected = if fresh { None } else { Some("no_recent_samples".to_owned()) };
        assert_eq!(
            allowance(&outcome),
            (CapabilityState::Complete, expected),
            "cadence {cadence}, {minutes_old} min old"
        );
    }
}

#[test]
fn oauth_usage_mode_falls_back_to_the_statusline_and_says_so() {
    let h = Harness::new();
    let mut settings = CollectionSettings::defaults();
    settings.allowance.claude_reader = ClaudeReader::OauthUsage;
    let ctx = h.context_with(vec![confirmed(BINDING_A, "claude-primary", 'a')], settings);
    h.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, Some(&hash('a')))]);
    let (outcome, sink) = collect(&ctx);
    assert_eq!((outcome.state, outcome.detail), (CoverageState::Partial, Some(DetailCode::NotImplemented)));
    assert_eq!(sink.records.len(), 1, "the passive fallback still publishes the reading");
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("reader_fallback_statusline".into())));
}

#[test]
fn a_hook_writing_elsewhere_is_reported_beside_arriving_samples() {
    let h = Harness::new();
    let ctx = h.context(vec![confirmed(BINDING_A, "claude-primary", 'a')]);
    h.install_hook(&h.dir.path().join("elsewhere"));
    h.write_part("2026-09-11T23-1.json", &[sample(0, 20.0, Some(&hash('a')))]);
    let (outcome, sink) = collect(&ctx);
    assert_eq!(sink.records.len(), 1);
    assert_eq!(allowance(&outcome), (CapabilityState::Partial, Some("hook_config_dir_mismatch".into())));
}

#[test]
fn preflight_needs_only_an_enabled_claude_binding() {
    let h = Harness::new();
    let blocked =
        Preflight::Blocked { state: CoverageState::PrerequisiteMissing, detail: DetailCode::NoBinding };
    assert_eq!(ClaudeAccount.preflight(&h.context(vec![])), blocked);
    let disabled = BindingContext { enabled: false, ..confirmed(BINDING_A, "claude-primary", 'a') };
    assert_eq!(ClaudeAccount.preflight(&h.context(vec![disabled])), blocked);
    let conflict = binding(BINDING_A, "claude-primary", Some(hash('a')), IdentityState::Changed, true);
    assert_eq!(ClaudeAccount.preflight(&h.context(vec![conflict])), Preflight::Ready);
    assert_eq!(ClaudeAccount.parser_version(), PARSER_VERSION);
    assert!(PARSER_VERSION.ends_with("+statusline1"));
}

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/usage-v2/parity")
}

fn execution_context(dir: &tempfile::TempDir, settings: CollectionSettings) -> RunContext {
    let codex = corpus().join("codex");
    let mut claude = confirmed(BINDING_A, "claude-primary", 'a');
    claude.roots = vec![corpus().join("claude/projects")];
    let mut codex_binding = confirmed(BINDING_B, "codex-primary", 'b');
    codex_binding.provider = Provider::Codex;
    codex_binding.roots = vec![codex.join("sessions"), codex.join("archived_sessions")];
    RunContext::new(
        Timestamp::from_str(NOW).unwrap(),
        "2026-09-01".to_owned(),
        observatory_core::pyjson::epoch_text("2026-09-01T00:00:00Z").unwrap(),
        settings,
        3,
        None,
        vec![claude, codex_binding],
        vec![],
        dir.path().to_path_buf(),
        dir.path().join("state.sqlite3"),
        corpus().join("claude-statusline"),
        true,
        Duration::from_secs(60),
    )
    .with_claude_settings_path(dir.path().join("claude-settings.json"))
}

fn allowance_row(outcome: &Outcome) -> Option<(CapabilityState, Option<String>)> {
    let rows = outcome.capabilities.as_ref().unwrap();
    assert!(rows.len() <= 8, "at most eight capability rows: {rows:?}");
    rows.iter()
        .find(|row| row.dimension == CapabilityDimension::Allowance)
        .map(|row| (row.state, row.detail_code.as_ref().map(|code| code.as_str().to_owned())))
}

#[test]
fn the_execution_adapters_report_the_embedded_row_for_codex_only() {
    let dir = tempfile::tempdir().unwrap();
    // With the unimplemented app server selected, the embedded row is reported as a fallback.
    let mut settings = CollectionSettings::defaults();
    settings.allowance.codex_reader = CodexReader::AppServer;
    let ctx = execution_context(&dir, settings);
    let mut sink = MemorySink::default();
    let claude = ClaudeExecution.collect(&ctx, None, &mut sink).unwrap();
    assert_eq!(allowance_row(&claude), None, "the transcript scan no longer claims the meter");
    assert_eq!(claude.capabilities.as_ref().unwrap().len(), 7);
    assert!(
        sink.records
            .iter()
            .all(|emitted| serde_json::to_value(&emitted.record).unwrap()["record_type"]
                != "allowance.reading"),
        "no statusline readings from claude_execution"
    );
    let codex = CodexExecution.collect(&ctx, None, &mut sink).unwrap();
    assert_eq!(
        allowance_row(&codex),
        Some((CapabilityState::Partial, Some("reader_fallback_embedded".into())))
    );
    assert_eq!(codex.capabilities.as_ref().unwrap().len(), 8);

    // The default (embedded) reader: complete, but the corpus is ten days old.
    let dir = tempfile::tempdir().unwrap();
    let ctx = execution_context(&dir, CollectionSettings::defaults());
    let codex = CodexExecution.collect(&ctx, None, &mut MemorySink::default()).unwrap();
    assert_eq!(allowance_row(&codex), Some((CapabilityState::Complete, Some("no_recent_samples".into()))));

    // Buckets only still carries the row, as the eighth.
    let dir = tempfile::tempdir().unwrap();
    let mut settings = CollectionSettings::defaults();
    settings.allowance.codex_reader = CodexReader::Off;
    settings.execution.detail_level = observatory_contract::settings::DetailLevel::BucketsOnly;
    let ctx = execution_context(&dir, settings);
    let codex = CodexExecution.collect(&ctx, None, &mut MemorySink::default()).unwrap();
    assert_eq!(allowance_row(&codex), Some((CapabilityState::DisabledBySetting, Some("reader_off".into()))));
    assert_eq!(codex.capabilities.as_ref().unwrap().len(), 8);
}
