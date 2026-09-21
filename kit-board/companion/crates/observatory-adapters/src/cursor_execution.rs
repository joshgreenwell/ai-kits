//! `cursor_execution`: local Cursor conversation token counters from `state.vscdb`.
//!
//! These are on-device counters, not billed usage. They become `activity.request`
//! rows on channel `local_db` when `detail_level` is not `buckets_only`. They
//! never produce hourly buckets and never invent a project from a timestamp.
//!
//! Every timestamp on a record comes from the store: the bubble's own
//! `createdAt`, else the composer's `createdAt`. A bubble the store holds no
//! time for is skipped and counted as malformed, never stamped with the run's
//! clock, so a record's content is a pure function of the store and one run
//! cannot revise what the previous run uploaded. A bubble whose counters are
//! all zero (what current Cursor builds write for nearly every message) proves
//! nothing about usage and is skipped as well; the hosted `cursor_account`
//! reader is where Cursor token evidence comes from.
//!
//! The store has no event table the change generation could stamp, so the
//! reader remembers, per binding and record, the content digest it last
//! emitted (`cursor_emitted`, written by the run once the records are
//! persisted) and emits a record only when it is new or its digest changed.
//! A parser version or emission shape change re-emits everything once.

use std::collections::HashMap;

use observatory_contract::settings::DetailLevel;
use observatory_contract::stable_json::{content_hash, stable_json};
use observatory_contract::{
    ActivityRequest, Adapter as AdapterId, Basis, CapabilityCoverage, CapabilityDimension, CapabilityState,
    Channel, Code, CoverageState, CursorState, DetailCode, ExecutionHost, Nullable, Provider, Record,
    RequestOutcome, SessionIdentity, Sha256Hex, Stamp, Surface, Text,
};
use observatory_core::adapter::{
    Adapter, AdapterError, Cursor, EmittedMark, Outcome, Preflight, RunContext, Sink, record_id,
};
use observatory_core::cursor_store::{self, CursorComposerUsage};
use observatory_core::pyjson::digest;
use observatory_core::state::State;
use serde_json::json;

use crate::emission::EMISSION_SHAPE;
use crate::provider::{parser_text, token_accounting, tokens_from_exclusive};

/// `+cursor-local2`: observation times come from the store (bubble, then
/// composer) instead of the run clock, and zero-counter bubbles are skipped.
const PARSER_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+cursor-local2");

#[derive(Debug, Default)]
pub struct CursorExecution;

/// What one run saw across every Cursor binding.
#[derive(Debug, Default)]
struct Tally {
    /// Bubbles with usage evidence and a store time, whether or not re-emitted.
    requests: u64,
    /// Of those, bubbles missing an input or output counter.
    incomplete: u64,
    /// Bubbles skipped because every counter was zero.
    no_tokens: u64,
    /// Bubbles skipped because neither they nor their composer carry a time.
    no_time: u64,
    /// Bubbles whose record digests the same as the last emission.
    unchanged: u64,
}

impl Adapter for CursorExecution {
    fn id(&self) -> AdapterId {
        AdapterId::CursorExecution
    }
    fn parser_version(&self) -> &'static str {
        PARSER_VERSION
    }
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        let present = ctx
            .bindings_for(Provider::Cursor)
            .filter(|binding| binding.runnable())
            .any(|binding| binding.cursor_state_db.as_ref().is_some_and(|path| path.is_file()));
        if present {
            Preflight::Ready
        } else {
            Preflight::Blocked { state: CoverageState::PrerequisiteMissing, detail: DetailCode::StoreMissing }
        }
    }
    fn collect(
        &self,
        ctx: &RunContext,
        _cursor: Option<Cursor>,
        sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError> {
        let state = ctx.open_state()?;
        let mut outcome = Outcome::ok();
        outcome.cursor_state = CursorState::Complete;
        let detail_level = ctx.settings.execution.detail_level;
        let emit_requests = detail_level != DetailLevel::BucketsOnly;
        let mut tally = Tally::default();
        for binding in ctx.bindings_for(Provider::Cursor).filter(|binding| binding.runnable()) {
            let Some(path) = binding.cursor_state_db.as_ref().filter(|path| path.is_file()) else { continue };
            outcome.stores_discovered += 1;
            let (bytes, rows) = cursor_store::cursor_local_usage(path).map_err(|_| AdapterError::Io)?;
            outcome.bytes_read += bytes;
            outcome.files += 1;
            let binding_id = binding.binding_id.as_str();
            let memory = if emit_requests {
                Some(EmissionMemory::load(&state, binding_id, detail_level)?)
            } else {
                None
            };
            for row in rows {
                if !row.has_token_evidence() {
                    tally.no_tokens += 1;
                    continue;
                }
                let Some(observed_at) = observed_at(&row) else {
                    tally.no_time += 1;
                    continue;
                };
                if !eligible(&observed_at, ctx.since) {
                    continue;
                }
                let Some(memory) = memory.as_ref() else { continue };
                let Some(record) = request_record(&binding.binding_id, &row, &observed_at) else {
                    outcome.malformed += 1;
                    continue;
                };
                let Ok(content_digest) = content_hash(&record) else {
                    outcome.malformed += 1;
                    continue;
                };
                tally.requests += 1;
                if incomplete_tokens(&row) {
                    tally.incomplete += 1;
                }
                let record_id = record.record_id().as_str().to_owned();
                if memory.unchanged(&record_id, content_digest.as_str()) {
                    tally.unchanged += 1;
                    continue;
                }
                sink.emit(record, None);
                outcome.records_emitted += 1;
                outcome.after_persist_emitted.push(EmittedMark {
                    binding_id: binding_id.to_owned(),
                    record_id,
                    content_digest: content_digest.as_str().to_owned(),
                });
            }
            if let Some(memory) = memory {
                outcome.after_persist.push((mark_key(binding_id), memory.fingerprint));
            }
        }
        if tally.no_time > 0 {
            outcome.malformed += tally.no_time;
            if outcome.state == CoverageState::Ok {
                outcome.state = CoverageState::Partial;
                outcome.detail = Some(DetailCode::ParseError);
            }
        }
        outcome.capabilities = Some(cursor_capabilities(detail_level, &tally));
        if outcome.stores_discovered == 0 {
            outcome.state = CoverageState::PrerequisiteMissing;
            outcome.detail = Some(DetailCode::StoreMissing);
        }
        Ok(outcome)
    }
}

/// What one binding emitted last time, valid only under the same fingerprint.
struct EmissionMemory {
    fingerprint: String,
    /// Record id to content digest; empty when the fingerprint moved, so
    /// everything is emitted once more.
    known: HashMap<String, String>,
}

impl EmissionMemory {
    fn load(state: &State, binding_id: &str, detail_level: DetailLevel) -> Result<Self, AdapterError> {
        let fingerprint = fingerprint(detail_level);
        let known = if state.meta(&mark_key(binding_id))?.as_deref() == Some(fingerprint.as_str()) {
            state.cursor_emitted(binding_id)?
        } else {
            HashMap::new()
        };
        Ok(EmissionMemory { fingerprint, known })
    }

    fn unchanged(&self, record_id: &str, content_digest: &str) -> bool {
        self.known.get(record_id).is_some_and(|digest| digest == content_digest)
    }
}

/// Everything a Cursor record's shape depends on: the emission shape, this
/// reader's parser version, and the detail level.
pub fn fingerprint(detail_level: DetailLevel) -> String {
    digest(&json!([EMISSION_SHAPE, PARSER_VERSION, detail_level.as_str()])).as_str().to_owned()
}

/// The meta key holding the fingerprint a binding's `cursor_emitted` rows were written under.
pub fn mark_key(binding_id: &str) -> String {
    format!("emitted:{}:{binding_id}", AdapterId::CursorExecution.as_str())
}

/// The bubble's store time, never the run clock.
fn observed_at(row: &CursorComposerUsage) -> Option<Stamp> {
    row.observed_at_ms().and_then(|ms| Stamp::from_millis(ms).ok())
}

fn eligible(observed_at: &Stamp, since: f64) -> bool {
    (observed_at.epoch_millis() as f64) / 1000.0 >= since
}

fn incomplete_tokens(row: &CursorComposerUsage) -> bool {
    row.input_tokens.is_none()
        || row.output_tokens.is_none()
        || (row.bubble_id.is_none() && row.cache_read_tokens.is_none() && row.cache_write_tokens.is_none())
}

fn as_u64(value: Option<i64>) -> Option<u64> {
    value.and_then(|n| u64::try_from(n).ok())
}

fn request_record(
    binding: &observatory_contract::Uuid,
    row: &CursorComposerUsage,
    observed_at: &Stamp,
) -> Option<Record> {
    let bubble = row.bubble_id.as_deref().unwrap_or("");
    let semantic =
        Sha256Hex::digest(stable_json(&json!(["cursor", row.composer_id.as_str(), bubble])).as_bytes());
    let session =
        Sha256Hex::digest(stable_json(&json!(["cursor_session", row.composer_id.as_str()])).as_bytes());
    let input = as_u64(row.input_tokens);
    let cached = as_u64(row.cache_read_tokens);
    let cache_write = as_u64(row.cache_write_tokens);
    let output = as_u64(row.output_tokens);
    let accounting = token_accounting(input, cached, cache_write, output, None);
    let model = row.model.as_deref().and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed == "unknown" {
            None
        } else {
            Text::try_from(trimmed.to_owned()).ok()
        }
    });
    Some(Record::ActivityRequest(ActivityRequest {
        record_id: record_id(binding, Channel::LocalDb, &format!("cursor:{}:{}", row.composer_id, bubble)),
        binding_id: binding.clone(),
        adapter: AdapterId::CursorExecution,
        channel: Channel::LocalDb,
        observed_at: observed_at.clone(),
        basis: Basis::Reported,
        parser_version: parser_text(PARSER_VERSION)?,
        semantic_key: semantic,
        product: Code::try_from("cursor_ide".to_owned()).ok()?,
        surface: Surface::Ide,
        execution_host: ExecutionHost::Local,
        session_hash: session,
        session_identity: SessionIdentity::Derived,
        parent_session_hash: Nullable::NULL,
        model_requested: Nullable::NULL,
        model_actual: Nullable(model),
        started_at: Nullable::NULL,
        ended_at: Nullable::some(observed_at.clone()),
        tokens: tokens_from_exclusive(input, cached, cache_write, output),
        token_accounting: accounting,
        pricing: None,
        tool_calls: Nullable::NULL,
        tools: None,
        project_hash: Nullable::NULL,
        project: None,
        agent: None,
        client_version: Nullable::NULL,
        latency_ms: Nullable::NULL,
        outcome: RequestOutcome::Unknown,
    }))
}

fn capability(
    dimension: CapabilityDimension,
    state: CapabilityState,
    detail: Option<&str>,
) -> CapabilityCoverage {
    CapabilityCoverage {
        dimension,
        state,
        detail_code: Nullable(detail.and_then(|value| Code::try_from(value.to_owned()).ok())),
    }
}

fn cursor_capabilities(detail_level: DetailLevel, tally: &Tally) -> Vec<CapabilityCoverage> {
    if detail_level == DetailLevel::BucketsOnly {
        return [
            CapabilityDimension::Requests,
            CapabilityDimension::TokenComposition,
            CapabilityDimension::Pricing,
            CapabilityDimension::Project,
            CapabilityDimension::Agent,
            CapabilityDimension::Tool,
            CapabilityDimension::Resource,
        ]
        .into_iter()
        .map(|dimension| {
            capability(dimension, CapabilityState::DisabledBySetting, Some("detail_level_buckets_only"))
        })
        .collect();
    }
    // Local counters are never billed totals, so composition is partial whenever any request exists,
    // whether or not some of them were incomplete. A store whose bubbles all carry zero counters
    // yields no request and no token evidence at all; the hosted reader is where Cursor tokens come from.
    let (request_state, request_detail, token_state, token_detail) = if tally.requests > 0 {
        (CapabilityState::Complete, None, CapabilityState::Partial, Some("local_counters_not_billed"))
    } else if tally.no_tokens > 0 {
        (
            CapabilityState::Unknown,
            Some("local_counters_zero"),
            CapabilityState::Unsupported,
            Some("local_counters_zero"),
        )
    } else {
        (
            CapabilityState::Unknown,
            Some("no_request_evidence"),
            CapabilityState::Unknown,
            Some("no_request_evidence"),
        )
    };
    vec![
        capability(CapabilityDimension::Requests, request_state, request_detail),
        capability(CapabilityDimension::TokenComposition, token_state, token_detail),
        capability(CapabilityDimension::Pricing, CapabilityState::Unsupported, Some("not_in_local_state")),
        capability(
            CapabilityDimension::Project,
            CapabilityState::Unsupported,
            Some("timestamp_join_not_supported"),
        ),
        capability(CapabilityDimension::Agent, CapabilityState::Unsupported, Some("not_in_local_state")),
        capability(CapabilityDimension::Tool, CapabilityState::Unsupported, Some("not_in_local_state")),
        capability(CapabilityDimension::Resource, CapabilityState::Unsupported, Some("not_in_local_state")),
    ]
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::str::FromStr;
    use std::time::Duration;

    use jiff::Timestamp;
    use observatory_contract::{AccountId, CollectionSettings, Uuid};
    use observatory_core::adapter::{BindingContext, IdentityState, MemorySink};
    use observatory_core::cursor_store::CursorComposerUsage;
    use observatory_core::privacy::PrivacyKey;
    use rusqlite::Connection;
    use serde_json::Value;

    use super::*;

    /// A run clock no store row could ever carry.
    const RUN_NOW: &str = "2026-09-20T22:46:20.569Z";

    fn stamp(text: &str) -> Stamp {
        Stamp::parse(text).unwrap()
    }

    fn row(
        bubble: &str,
        created_at_ms: Option<i64>,
        composer_created_at_ms: Option<i64>,
    ) -> CursorComposerUsage {
        CursorComposerUsage {
            composer_id: "comp-1".into(),
            bubble_id: Some(bubble.into()),
            input_tokens: Some(12),
            output_tokens: Some(4),
            cache_read_tokens: Some(3),
            cache_write_tokens: Some(1),
            created_at_ms,
            composer_created_at_ms,
            composer_updated_at_ms: None,
            model: Some("composer-1".into()),
        }
    }

    #[test]
    fn local_counters_become_requests_never_buckets() {
        let row = row("bubble-1", Some(1_725_000_000_000), None);
        let record =
            request_record(&crate::provider::zero_uuid(), &row, &observed_at(&row).unwrap()).unwrap();
        let Record::ActivityRequest(request) = record else { panic!("request") };
        assert_eq!(request.channel, Channel::LocalDb);
        assert_eq!(request.product.as_str(), "cursor_ide");
        assert_eq!(request.observed_at.as_str(), "2024-08-30T06:40:00.000Z");
        assert_eq!(request.ended_at.0.as_ref().map(Stamp::as_str), Some("2024-08-30T06:40:00.000Z"));
        assert_eq!(request.parser_version.as_str(), PARSER_VERSION);
        assert!(request.parser_version.as_str().ends_with("+cursor-local2"));
        assert_eq!(request.tokens.input_fresh.as_ref().map(|v| v.get()), Some(12));
        assert_eq!(request.tokens.input_cached.as_ref().map(|v| v.get()), Some(3));
        assert!(request.project.is_none());
    }

    #[test]
    fn observation_time_is_the_bubble_then_the_composer_then_nothing() {
        let bubble = row("a", Some(1_767_139_800_500), Some(1_735_600_170_253));
        assert_eq!(observed_at(&bubble).unwrap().as_str(), "2025-12-31T00:10:00.500Z");
        let composer = row("b", None, Some(1_735_600_170_253));
        assert_eq!(observed_at(&composer).unwrap().as_str(), "2024-12-30T23:09:30.253Z");
        let neither = row("c", None, None);
        assert!(observed_at(&neither).is_none(), "no clock stands in for a missing store time");
        assert!(observed_at(&row("d", Some(i64::MAX), None)).is_none(), "an unrepresentable time is absent");
    }

    #[test]
    fn eligibility_uses_the_stable_time_against_the_backfill_start() {
        let since = observatory_core::pyjson::epoch_text("2025-01-01T00:00:00Z").unwrap();
        assert!(eligible(&stamp("2025-01-01T00:00:00.000Z"), since));
        assert!(!eligible(&stamp("2024-12-31T23:59:59.999Z"), since));
    }

    #[test]
    fn the_fingerprint_moves_with_the_parser_version_and_detail_level() {
        assert_ne!(fingerprint(DetailLevel::Requests), fingerprint(DetailLevel::RequestsWithTools));
        assert_eq!(fingerprint(DetailLevel::Requests), fingerprint(DetailLevel::Requests));
        assert_eq!(mark_key("b-1"), "emitted:cursor_execution:b-1");
    }

    // --- collect against a synthetic store --------------------------------

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
            "INSERT INTO cursorDiskKV(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, &value.to_string()],
        )
        .unwrap();
    }

    /// Four bubbles as a current Cursor build writes them: one with its own
    /// time, one that needs the composer's, one with zero counters, and one
    /// the store holds no time for.
    fn synthetic_store(path: &Path) {
        let conn = open_store(path);
        put(
            &conn,
            "composerData:comp-1",
            json!({"composerId": "comp-1", "text": "SECRET", "createdAt": 1_757_800_000_000i64}),
        );
        put(
            &conn,
            "bubbleId:comp-1:own-time",
            json!({"type": 2, "text": "SECRET", "createdAt": "2025-09-14T10:00:00.250Z",
                   "tokenCount": {"inputTokens": 5728, "outputTokens": 191}}),
        );
        put(
            &conn,
            "bubbleId:comp-1:composer-time",
            json!({"type": 2, "text": "SECRET", "tokenCount": {"inputTokens": 15124, "outputTokens": 2436}}),
        );
        put(
            &conn,
            "bubbleId:comp-1:zero",
            json!({"type": 2, "text": "SECRET", "createdAt": "2025-09-14T10:01:00.000Z",
                   "tokenCount": {"inputTokens": 0, "outputTokens": 0}}),
        );
        put(
            &conn,
            "bubbleId:comp-orphan:no-time",
            json!({"type": 2, "text": "SECRET", "tokenCount": {"inputTokens": 7, "outputTokens": 1}}),
        );
    }

    fn binding(store: PathBuf) -> BindingContext {
        BindingContext {
            binding_id: Uuid::from_str("33333333-3333-4333-8333-333333333333").unwrap(),
            account_id: AccountId::from_str("primary").unwrap(),
            provider: Provider::Cursor,
            enabled: true,
            identity_hash: None,
            identity: IdentityState::Confirmed,
            identity_conflict: false,
            roots: Vec::new(),
            codex_home: None,
            cursor_state_db: Some(store),
        }
    }

    fn context(dir: &tempfile::TempDir, detail_level: DetailLevel) -> RunContext {
        let mut settings = CollectionSettings::defaults();
        settings.execution.detail_level = detail_level;
        RunContext::new(
            Timestamp::from_str(RUN_NOW).unwrap(),
            "2025-01-01".to_owned(),
            observatory_core::pyjson::epoch_text("2025-01-01T00:00:00Z").unwrap(),
            settings,
            3,
            None,
            vec![binding(dir.path().join("state.vscdb"))],
            vec![],
            dir.path().to_path_buf(),
            dir.path().join("state.sqlite3"),
            dir.path().join("statusline"),
            true,
            Duration::from_secs(60),
            PrivacyKey::fixed_for_tests(),
        )
    }

    /// What the run does once the sink's records are stored.
    fn persist(ctx: &RunContext, outcome: &Outcome) {
        let state = ctx.open_state().unwrap();
        for (key, value) in &outcome.after_persist {
            state.set_meta(key, value).unwrap();
        }
        for mark in &outcome.after_persist_emitted {
            state
                .mark_cursor_emitted(&mark.binding_id, &mark.record_id, &mark.content_digest, RUN_NOW)
                .unwrap();
        }
    }

    fn collect(ctx: &RunContext) -> (Outcome, Vec<Value>) {
        let mut sink = MemorySink::default();
        let outcome = CursorExecution.collect(ctx, None, &mut sink).unwrap();
        let records = sink.records.iter().map(|entry| serde_json::to_value(&entry.record).unwrap()).collect();
        (outcome, records)
    }

    fn capability_of(outcome: &Outcome, dimension: CapabilityDimension) -> (CapabilityState, Option<String>) {
        let row = outcome
            .capabilities
            .as_ref()
            .unwrap()
            .iter()
            .find(|capability| capability.dimension == dimension)
            .unwrap();
        (row.state, row.detail_code.0.as_ref().map(|code| code.as_str().to_owned()))
    }

    fn assert_never_the_run_clock(records: &[Value]) {
        for record in records {
            for field in ["observed_at", "ended_at", "started_at"] {
                assert_ne!(record[field].as_str(), Some(RUN_NOW), "{field} carries the run clock: {record}");
            }
            assert_eq!(record["observed_at"], record["ended_at"], "ended_at is the same store time");
        }
    }

    #[test]
    fn records_carry_store_times_and_bubbles_without_one_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        synthetic_store(&dir.path().join("state.vscdb"));
        let ctx = context(&dir, DetailLevel::Requests);
        let (outcome, records) = collect(&ctx);
        assert_eq!(records.len(), 2, "{records:?}");
        assert_never_the_run_clock(&records);
        let mut observed: Vec<&str> =
            records.iter().map(|record| record["observed_at"].as_str().unwrap()).collect();
        observed.sort_unstable();
        assert_eq!(observed, ["2025-09-13T21:46:40.000Z", "2025-09-14T10:00:00.250Z"]);
        assert!(
            records
                .iter()
                .all(|record| record["parser_version"].as_str().unwrap().ends_with("+cursor-local2"))
        );

        assert_eq!(outcome.records_emitted, 2);
        assert_eq!(outcome.malformed, 1, "the bubble with no store time is counted, not emitted");
        assert_eq!((outcome.state, outcome.detail), (CoverageState::Partial, Some(DetailCode::ParseError)));
        assert_eq!(outcome.after_persist_emitted.len(), 2);
        assert_eq!(outcome.after_persist.len(), 1);
        assert_eq!(capability_of(&outcome, CapabilityDimension::Requests), (CapabilityState::Complete, None));
        assert_eq!(
            capability_of(&outcome, CapabilityDimension::TokenComposition),
            (CapabilityState::Partial, Some("local_counters_not_billed".into()))
        );
    }

    #[test]
    fn an_unchanged_store_emits_nothing_and_a_changed_bubble_emits_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("state.vscdb");
        synthetic_store(&store);
        let ctx = context(&dir, DetailLevel::Requests);
        let (first, records) = collect(&ctx);
        assert_eq!(records.len(), 2);
        persist(&ctx, &first);

        // The same store again: nothing is emitted, the evidence is still counted.
        let (second, records) = collect(&ctx);
        assert!(records.is_empty(), "{records:?}");
        assert_eq!(second.records_emitted, 0);
        assert!(second.after_persist_emitted.is_empty());
        assert_eq!(second.capabilities, first.capabilities);
        persist(&ctx, &second);

        // A bubble whose counters moved is emitted once more, alone, then settles.
        put(
            &open_store(&store),
            "bubbleId:comp-1:own-time",
            json!({"type": 2, "text": "SECRET", "createdAt": "2025-09-14T10:00:00.250Z",
                   "tokenCount": {"inputTokens": 5728, "outputTokens": 300}}),
        );
        let (third, records) = collect(&ctx);
        assert_eq!(records.len(), 1, "{records:?}");
        assert_eq!(records[0]["tokens"]["output"], json!(300));
        assert_never_the_run_clock(&records);
        persist(&ctx, &third);
        let (fourth, records) = collect(&ctx);
        assert!(records.is_empty(), "{records:?}");
        assert_eq!(fourth.records_emitted, 0);

        // A new bubble is emitted without touching the others.
        put(
            &open_store(&store),
            "bubbleId:comp-1:later",
            json!({"type": 2, "text": "SECRET", "createdAt": "2025-09-14T11:00:00.000Z",
                   "tokenCount": {"inputTokens": 9, "outputTokens": 2}}),
        );
        let (fifth, records) = collect(&ctx);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["observed_at"], json!("2025-09-14T11:00:00.000Z"));
        persist(&ctx, &fifth);
        assert!(collect(&ctx).1.is_empty());
    }

    #[test]
    fn a_fingerprint_change_re_emits_everything_once() {
        let dir = tempfile::tempdir().unwrap();
        synthetic_store(&dir.path().join("state.vscdb"));
        let ctx = context(&dir, DetailLevel::Requests);
        let (first, _) = collect(&ctx);
        persist(&ctx, &first);
        assert!(collect(&ctx).1.is_empty());

        // The mark the previous parser version left.
        let state = ctx.open_state().unwrap();
        let key = mark_key(ctx.bindings[0].binding_id.as_str());
        assert_eq!(state.meta(&key).unwrap().as_deref(), Some(fingerprint(DetailLevel::Requests).as_str()));
        state.set_meta(&key, "previous-fingerprint").unwrap();
        drop(state);

        let (upgraded, records) = collect(&ctx);
        assert_eq!(records.len(), 2, "every record is emitted once more");
        persist(&ctx, &upgraded);
        assert!(collect(&ctx).1.is_empty());

        // A different detail level is a different fingerprint too.
        let with_tools = context(&dir, DetailLevel::RequestsWithTools);
        let (moved, records) = collect(&with_tools);
        assert_eq!(records.len(), 2);
        persist(&with_tools, &moved);
        assert!(collect(&with_tools).1.is_empty());
    }

    #[test]
    fn a_store_of_zero_counters_yields_no_records_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_store(&dir.path().join("state.vscdb"));
        put(&conn, "composerData:comp-1", json!({"createdAt": 1_757_800_000_000i64}));
        for bubble in ["a", "b", "c"] {
            put(
                &conn,
                &format!("bubbleId:comp-1:{bubble}"),
                json!({"type": 2, "text": "SECRET", "createdAt": "2025-09-14T10:00:00.000Z",
                       "tokenCount": {"inputTokens": 0, "outputTokens": 0}}),
            );
        }
        drop(conn);
        let ctx = context(&dir, DetailLevel::Requests);
        let (outcome, records) = collect(&ctx);
        assert!(records.is_empty());
        assert_eq!((outcome.state, outcome.detail, outcome.malformed), (CoverageState::Ok, None, 0));
        assert_eq!(
            capability_of(&outcome, CapabilityDimension::Requests),
            (CapabilityState::Unknown, Some("local_counters_zero".into()))
        );
        assert_eq!(
            capability_of(&outcome, CapabilityDimension::TokenComposition),
            (CapabilityState::Unsupported, Some("local_counters_zero".into()))
        );
    }

    #[test]
    fn buckets_only_reads_nothing_into_the_sink_and_leaves_no_mark() {
        let dir = tempfile::tempdir().unwrap();
        synthetic_store(&dir.path().join("state.vscdb"));
        let ctx = context(&dir, DetailLevel::BucketsOnly);
        let (outcome, records) = collect(&ctx);
        assert!(records.is_empty());
        assert!(outcome.after_persist.is_empty() && outcome.after_persist_emitted.is_empty());
        assert_eq!(
            capability_of(&outcome, CapabilityDimension::Requests),
            (CapabilityState::DisabledBySetting, Some("detail_level_buckets_only".into()))
        );
    }
}
