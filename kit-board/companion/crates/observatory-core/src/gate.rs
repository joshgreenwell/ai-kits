//! The upgrade gate (spec sections 0.2, 2.2 and 9, step P3).
//!
//! It runs on a dry-run copy of the state after `observatory run --dry-run
//! --offline` with the new build, and says whether installing that build would
//! change the ledger beyond what the section 0.2 table allows:
//!
//! - no `activity.request` or `agent.event` is revised, and none is new for
//!   history under a semantic key the server never received (a new key for old
//!   activity would duplicate its tokens);
//! - every new `tool.event` for history is a nested MCP call;
//! - every revised `tool.event` is a `PowerShell` or `NotebookRead` row, the
//!   only names the widened upload gate turns readable;
//! - no tool row moves to another request.
//!
//! What counts as history depends on the evidence given:
//!
//! - With `baseline` (a copy taken before the dry run, holding everything the
//!   previous build produced; ledger records are never deleted), history is
//!   what that build had read, not a time. A new record is history when the
//!   baseline holds a record of the same type and binding for the same instant
//!   (same `observed_at`, and the same `event_kind` for events) under another
//!   semantic key, which is a re-keyed duplicate, or when it falls at or before
//!   the latest activity the baseline holds for its stream (binding, session,
//!   agent), which is a line the previous build read without emitting it. A
//!   record the baseline itself holds under the same record id was produced by
//!   the previous build and is not new. Anything else is activity the previous
//!   build never read: lines appended while its last run was scanning, or the
//!   backlog a `partial` run left behind. The cutoff then decides nothing.
//! - Without a baseline, history is activity observed before `cutoff`. That
//!   is the strict answer and gives false failures for activity the last run
//!   had not read yet (written during its scan, or left by a `partial` run),
//!   so pass `--baseline` for a verdict.
//!
//! The gate only reads.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use jiff::Timestamp;
use serde::Serialize;
use serde_json::Value;

use crate::state::{GateRow, ORIGIN_NESTED_MCP, State, StateError};

/// The tool names whose `tool.event` rows 2.2.0 may revise.
pub const REVISABLE_TOOL_NAMES: &[&str] = &["PowerShell", "NotebookRead"];

const LEDGER_TYPES: [&str; 3] = ["activity.request", "agent.event", "tool.event"];

/// Counts for one ledger type.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TypeReport {
    /// Pending rows never published.
    pub new: u64,
    /// Without a baseline: new rows for activity newer than the cutoff.
    pub new_after_cutoff: u64,
    /// With a baseline: new rows for activity the previous build never read.
    pub new_unread: u64,
    /// With a baseline: pending rows the previous build already produced (same record id).
    pub new_carried: u64,
    /// New rows whose semantic key the server already holds under another record id.
    pub new_known_key: u64,
    /// New rows allowed by the section 0.2 table (nested MCP calls).
    pub new_allowed: u64,
    /// New rows that violate the gate.
    pub new_violations: u64,
    /// Published rows whose content changed.
    pub revised: u64,
    /// Revised rows allowed by the section 0.2 table.
    pub revised_allowed: u64,
    /// Revised rows that violate the gate.
    pub revised_violations: u64,
    /// With a baseline: which record fields changed on revised rows, and how often.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub revised_fields: BTreeMap<String, u64>,
}

/// The whole verdict.
#[derive(Clone, Debug, Default, Serialize)]
pub struct GateReport {
    pub ok: bool,
    pub cutoff: String,
    /// `baseline` when a baseline decided what is history, `cutoff` otherwise.
    pub history_by: String,
    pub ledger: BTreeMap<String, TypeReport>,
    /// Tool rows whose `caller_request_key` differs from the published value;
    /// `None` when no baseline was given.
    pub caller_request_changes: Option<u64>,
    /// Pending side records per type.
    pub pending_side: BTreeMap<String, u64>,
    /// Pending records per type, every type.
    pub pending: BTreeMap<String, u64>,
    /// Rows that are pending but locally rejected; never uploaded, never counted above.
    pub rejected_pending: u64,
    /// Up to five record ids per violation class, for local inspection.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub samples: BTreeMap<String, Vec<String>>,
    pub violations: BTreeSet<String>,
}

fn observed(row: &GateRow) -> Option<Timestamp> {
    row.observed_at.as_deref().and_then(|text| text.parse::<Timestamp>().ok())
}

fn observed_before(row: &GateRow, cutoff: Timestamp) -> bool {
    match observed(row) {
        Some(at) => at < cutoff,
        // A record without a readable time counts as history: the strict answer.
        None => true,
    }
}

/// One instant of one kind of activity on one binding.
type Instant = (String, String, Timestamp, Option<String>);
/// One stream of activity: binding, session, agent.
type Stream = (String, String, Option<String>);

/// What the previous build had read, from the baseline copy.
#[derive(Default)]
struct History {
    record_ids: HashSet<String>,
    /// Semantic keys per instant.
    instants: HashMap<Instant, HashSet<String>>,
    /// The latest activity per stream.
    read_to: HashMap<Stream, Timestamp>,
}

impl History {
    fn load(baseline: &State) -> Result<History, StateError> {
        let mut history = History::default();
        for record_type in LEDGER_TYPES {
            for row in baseline.gate_history_rows(record_type)? {
                history.record_ids.insert(row.record_id.clone());
                let Some(at) = observed(&row) else { continue };
                history
                    .instants
                    .entry(instant(record_type, &row, at))
                    .or_default()
                    .insert(row.semantic_key.clone());
                if let Some(stream) = stream(&row) {
                    let latest = history.read_to.entry(stream).or_insert(at);
                    if at > *latest {
                        *latest = at;
                    }
                }
            }
        }
        Ok(history)
    }

    /// Whether a new row is activity the previous build had read: a re-keyed
    /// duplicate of an instant it holds, or a line at or before where it read
    /// the row's stream to. Unreadable times are history, the strict answer.
    fn read(&self, record_type: &str, row: &GateRow) -> bool {
        let Some(at) = observed(row) else { return true };
        let rekeyed = self
            .instants
            .get(&instant(record_type, row, at))
            .is_some_and(|keys| keys.iter().any(|key| *key != row.semantic_key));
        let read_past = stream(row).and_then(|stream| self.read_to.get(&stream)).is_some_and(|to| at <= *to);
        rekeyed || read_past
    }
}

fn instant(record_type: &str, row: &GateRow, at: Timestamp) -> Instant {
    (record_type.to_owned(), row.binding_id.clone(), at, row.event_kind.clone())
}

fn stream(row: &GateRow) -> Option<Stream> {
    let session = row.session_hash.clone()?;
    Some((row.binding_id.clone(), session, row.agent_key.clone()))
}

fn sample(report: &mut GateReport, class: &str, id: &str) {
    let list = report.samples.entry(class.to_owned()).or_default();
    if list.len() < 5 {
        list.push(id.to_owned());
    }
}

/// The top-level fields two record texts disagree on, ignoring the header.
fn changed_fields(before: &str, after: &str) -> Vec<String> {
    let (Ok(Value::Object(before)), Ok(Value::Object(after))) =
        (serde_json::from_str::<Value>(before), serde_json::from_str::<Value>(after))
    else {
        return vec!["<unreadable>".to_owned()];
    };
    let header = ["record_id", "binding_id", "observed_at", "parser_version"];
    let keys: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    keys.into_iter()
        .filter(|key| !header.contains(&key.as_str()))
        .filter(|key| before.get(*key) != after.get(*key))
        .cloned()
        .collect()
}

/// Evaluates the gate over a dry-run state copy.
pub fn evaluate(
    state: &State,
    cutoff: Timestamp,
    baseline: Option<&State>,
) -> Result<GateReport, StateError> {
    let history = baseline.map(History::load).transpose()?;
    let history_by = if history.is_some() { "baseline" } else { "cutoff" };
    let mut report =
        GateReport { cutoff: cutoff.to_string(), history_by: history_by.to_owned(), ..GateReport::default() };
    for record_type in LEDGER_TYPES {
        let published_keys = state.published_semantic_keys(record_type)?;
        let mut entry = TypeReport::default();
        for row in state.gate_rows(record_type)? {
            if row.rejected_reason.is_some() {
                report.rejected_pending += 1;
                continue;
            }
            if let Some(baseline) = baseline
                && row.published_hash.is_some()
            {
                let before = baseline.record_text(&row.record_id)?;
                let after = state.record_text(&row.record_id)?;
                if let (Some(before), Some(after)) = (before, after) {
                    for field in changed_fields(&before, &after) {
                        *entry.revised_fields.entry(field).or_default() += 1;
                    }
                }
            }
            if row.published_hash.is_none() {
                entry.new += 1;
                if published_keys.contains(&row.semantic_key) {
                    entry.new_known_key += 1;
                }
                let origin = match record_type {
                    "tool.event" => state.tool_event_origin(&row.binding_id, &row.semantic_key)?,
                    _ => None,
                };
                if origin.as_deref() == Some(ORIGIN_NESTED_MCP) {
                    entry.new_allowed += 1;
                    continue;
                }
                let is_history = match &history {
                    Some(history) => {
                        // The previous build's own pending record, not something this build adds.
                        if history.record_ids.contains(&row.record_id) {
                            entry.new_carried += 1;
                            continue;
                        }
                        let read = history.read(record_type, &row);
                        if !read {
                            entry.new_unread += 1;
                        }
                        read
                    }
                    None => {
                        let before = observed_before(&row, cutoff);
                        if !before {
                            entry.new_after_cutoff += 1;
                        }
                        before
                    }
                };
                if !is_history {
                    continue;
                }
                let violation = match record_type {
                    // A new tool row for history that is not a nested call.
                    "tool.event" => true,
                    // A new request or agent event for history is a duplicate unless its key is known.
                    _ => !published_keys.contains(&row.semantic_key),
                };
                if violation {
                    entry.new_violations += 1;
                    sample(&mut report, &format!("{record_type}:new"), &row.record_id);
                }
            } else {
                entry.revised += 1;
                let name = row.tool_name.as_deref();
                let revisable = name.is_some_and(|name| REVISABLE_TOOL_NAMES.contains(&name));
                if record_type == "tool.event" && revisable {
                    entry.revised_allowed += 1;
                } else {
                    entry.revised_violations += 1;
                    sample(&mut report, &format!("{record_type}:revised"), &row.record_id);
                }
            }
        }
        if entry.new_violations > 0 {
            report.violations.insert(format!("{record_type}:new"));
        }
        if entry.revised_violations > 0 {
            report.violations.insert(format!("{record_type}:revised"));
        }
        report.ledger.insert(record_type.to_owned(), entry);
    }
    if let Some(baseline) = baseline {
        let published = baseline.published_tool_callers()?;
        let mut changes = 0;
        let mut seen = HashSet::new();
        for row in state.gate_rows("tool.event")? {
            if row.published_hash.is_none() || !seen.insert(row.record_id.clone()) {
                continue;
            }
            if let Some(before) = published.get(&row.record_id)
                && *before != row.caller_request_key
            {
                changes += 1;
                sample(&mut report, "tool.event:caller_request_key", &row.record_id);
            }
        }
        if changes > 0 {
            report.violations.insert("tool.event:caller_request_key".to_owned());
        }
        report.caller_request_changes = Some(changes);
    }
    report.pending = state.pending_counts()?;
    for record_type in ["name.label", "project.catalog", "project.membership"] {
        if let Some(count) = report.pending.get(record_type) {
            report.pending_side.insert(record_type.to_owned(), *count);
        }
    }
    report.ok = report.violations.is_empty();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::state::{ORIGIN_DIRECT, RecordRow, ToolEventRow};

    const BINDING: &str = "11111111-1111-4111-8111-111111111111";
    const CUTOFF: &str = "2026-09-20T12:00:00Z";

    fn cutoff() -> Timestamp {
        CUTOFF.parse().unwrap()
    }

    const OLD: &str = "2026-09-10T00:00:00Z";
    const NEW: &str = "2026-09-20T12:30:00Z";

    /// Stores a record row. `ids` is (record id, semantic key); `hashes` is
    /// (content hash, the hash the server holds, if any).
    fn put(state: &State, kind: &str, ids: (&str, &str), hashes: (&str, Option<&str>), record: Value) {
        let (id, semantic) = ids;
        let (content, published) = hashes;
        state
            .upsert_record(&RecordRow {
                record_id: id.into(),
                binding_id: BINDING.into(),
                adapter: "codex_execution".into(),
                record_type: kind.into(),
                semantic_key: semantic.into(),
                content_hash: content.into(),
                published_hash: None,
                rejected_reason: None,
                record: record.to_string(),
                updated_at: "2026-09-20T00:00:00.000Z".into(),
            })
            .unwrap();
        if let Some(hash) = published {
            state.mark_record_published(id, hash).unwrap();
        }
    }

    fn tool_row(state: &State, id: &str, origin: &str) {
        state
            .upsert_tool_event(
                BINDING,
                &ToolEventRow {
                    id: id.into(),
                    timestamp: "2026-09-10T00:00:00Z".into(),
                    event_kind: "invocation".into(),
                    invocation_key: id.into(),
                    session_hash: None,
                    caller_request_key: None,
                    caller_agent_key: None,
                    caller_is_subagent: false,
                    parent_invocation_key: None,
                    class: "mcp".into(),
                    name: Some("synthetic".into()),
                    name_hash: None,
                    namespace: None,
                    namespace_hash: None,
                    outcome: "unknown".into(),
                    name_truncated: false,
                    origin: origin.into(),
                },
            )
            .unwrap();
    }

    const REQUEST: &str = "activity.request";
    const TOOL: &str = "tool.event";

    fn request(observed_at: &str) -> Value {
        json!({ "record_type": "activity.request", "observed_at": observed_at })
    }

    fn tool(observed_at: &str, name: &str, caller: &str) -> Value {
        json!({
            "record_type": "tool.event",
            "observed_at": observed_at,
            "tool": { "name": name },
            "caller_request_key": caller
        })
    }

    /// A state copy that passes: nothing revised but PowerShell, new rows only after the
    /// cutoff or nested, and a known semantic key under a new record id.
    fn passing() -> (tempfile::TempDir, State, State) {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("gate.sqlite3")).unwrap();
        let baseline = State::open(&dir.path().join("baseline.sqlite3")).unwrap();
        for target in [&state, &baseline] {
            put(target, REQUEST, ("r-old", "k-old"), ("h1", Some("h1")), request(OLD));
            put(target, TOOL, ("t-ps", "t-ps"), ("h2", Some("h2")), tool(OLD, "PowerShell", "c1"));
        }
        // After the dry run: PowerShell is revised, a nested call and new activity appear.
        put(&state, TOOL, ("t-ps", "t-ps"), ("h2b", None), tool(OLD, "PowerShell", "c1"));
        put(&state, TOOL, ("t-nested", "t-nested"), ("h3", None), tool(OLD, "h:0000000000000000", "c1"));
        tool_row(&state, "t-nested", ORIGIN_NESTED_MCP);
        put(&state, REQUEST, ("r-new", "k-new"), ("h4", None), request(NEW));
        put(&state, REQUEST, ("r-same-key", "k-old"), ("h5", None), request(OLD));
        put(&state, TOOL, ("t-new", "t-new"), ("h6", None), tool(NEW, "Read", "c2"));
        tool_row(&state, "t-new", ORIGIN_DIRECT);
        (dir, state, baseline)
    }

    /// Spec test R14: a clean copy passes, and each violation class fails it.
    #[test]
    fn the_gate_passes_a_clean_copy_and_fails_every_violation_class() {
        let (_dir, state, baseline) = passing();
        let report = evaluate(&state, cutoff(), Some(&baseline)).unwrap();
        assert!(report.ok, "{report:#?}");
        assert_eq!(report.ledger["tool.event"].revised_allowed, 1);
        assert_eq!(report.ledger["tool.event"].new_allowed, 1);
        assert_eq!(report.history_by, "baseline");
        assert_eq!(report.ledger["activity.request"].new_unread, 2, "r-new and r-same-key");
        assert_eq!(report.ledger["activity.request"].new_after_cutoff, 0, "the cutoff decides nothing");
        assert_eq!(report.ledger["activity.request"].new_known_key, 1);
        assert_eq!(report.caller_request_changes, Some(0));

        let fails = |mutate: &dyn Fn(&State), class: &str| {
            let (_dir, state, baseline) = passing();
            mutate(&state);
            let report = evaluate(&state, cutoff(), Some(&baseline)).unwrap();
            assert!(!report.ok, "{class} must fail");
            assert!(report.violations.contains(class), "{class}: {:?}", report.violations);
        };
        fails(
            &|state| put(state, REQUEST, ("r-dup", "k-dup"), ("h7", None), request(OLD)),
            "activity.request:new",
        );
        fails(
            &|state| put(state, REQUEST, ("r-old", "k-old"), ("h1b", None), request(OLD)),
            "activity.request:revised",
        );
        fails(
            &|state| {
                let event = json!({ "observed_at": OLD });
                put(state, "agent.event", ("a-1", "a-1"), ("h8", Some("h8")), event.clone());
                put(state, "agent.event", ("a-1", "a-1"), ("h8b", None), event);
            },
            "agent.event:revised",
        );
        fails(
            &|state| {
                put(state, TOOL, ("t-direct", "t-direct"), ("h9", None), tool(OLD, "Read", "c3"));
                tool_row(state, "t-direct", ORIGIN_DIRECT);
            },
            "tool.event:new",
        );
        fails(
            &|state| {
                put(state, TOOL, ("t-read", "t-read"), ("h10", Some("h10")), tool(OLD, "Read", "c1"));
                put(state, TOOL, ("t-read", "t-read"), ("h10b", None), tool(OLD, "Read", "c1"));
            },
            "tool.event:revised",
        );
        fails(
            &|state| put(state, TOOL, ("t-ps", "t-ps"), ("h2c", None), tool(OLD, "PowerShell", "c-moved")),
            "tool.event:caller_request_key",
        );
    }

    #[test]
    fn without_a_baseline_the_membership_check_is_not_claimed() {
        let (_dir, state, _baseline) = passing();
        let report = evaluate(&state, cutoff(), None).unwrap();
        assert!(report.ok);
        assert_eq!(report.history_by, "cutoff");
        assert_eq!(report.ledger["activity.request"].new_after_cutoff, 1);
        assert_eq!(report.caller_request_changes, None);
    }

    const SESSION: &str = "5555555555555555555555555555555555555555555555555555555555555555";
    const OTHER_SESSION: &str = "6666666666666666666666666666666666666666666666666666666666666666";
    const AGENT: &str = "7777777777777777777777777777777777777777777777777777777777777777";
    /// Before the last run read its stream to.
    const EARLY: &str = "2026-09-20T11:40:00Z";
    /// The last line the last run read in the stream.
    const READ_TO: &str = "2026-09-20T11:45:00Z";
    /// Appended while the last run was still scanning; still before the cutoff.
    const DURING_SCAN: &str = "2026-09-20T11:50:00Z";

    fn request_in(observed_at: &str, session: &str) -> Value {
        json!({
            "record_type": "activity.request",
            "observed_at": observed_at,
            "session_hash": session,
            "agent": { "key": AGENT }
        })
    }

    fn tool_in(observed_at: &str, session: &str) -> Value {
        json!({
            "record_type": "tool.event",
            "observed_at": observed_at,
            "event_kind": "invocation",
            "session_hash": session,
            "caller_agent_key": AGENT,
            "tool": { "name": "Read" }
        })
    }

    /// A baseline whose last run read one stream to `READ_TO`; the copy starts equal.
    fn streams() -> (tempfile::TempDir, State, State) {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("gate.sqlite3")).unwrap();
        let baseline = State::open(&dir.path().join("baseline.sqlite3")).unwrap();
        for target in [&state, &baseline] {
            put(target, REQUEST, ("r-read", "k-read"), ("h1", Some("h1")), request_in(READ_TO, SESSION));
            put(target, REQUEST, ("r-pending", "k-pending"), ("h2", None), request_in(EARLY, OTHER_SESSION));
        }
        (dir, state, baseline)
    }

    /// Activity the last run had not read yet (appended during its scan, or a
    /// `partial` run's backlog) is new activity, not a duplicate, even before the cutoff.
    #[test]
    fn activity_the_previous_build_never_read_is_not_history() {
        let (_dir, state, baseline) = streams();
        // Appended to the stream after the last run read it.
        put(&state, REQUEST, ("r-appended", "k-appended"), ("h3", None), request_in(DURING_SCAN, SESSION));
        put(&state, TOOL, ("t-appended", "t-appended"), ("h4", None), tool_in(DURING_SCAN, SESSION));
        tool_row(&state, "t-appended", ORIGIN_DIRECT);
        // A session a partial run never reached: older than the cutoff, at no instant it holds.
        let backlog = "8888888888888888888888888888888888888888888888888888888888888888";
        put(
            &state,
            REQUEST,
            ("r-backlog", "k-backlog"),
            ("h5", None),
            request_in("2026-09-20T11:30:00Z", backlog),
        );
        let report = evaluate(&state, cutoff(), Some(&baseline)).unwrap();
        assert!(report.ok, "{report:#?}");
        assert_eq!(report.ledger["activity.request"].new_unread, 2);
        assert_eq!(report.ledger["activity.request"].new_carried, 1, "the old build's own pending row");
        assert_eq!(report.ledger["tool.event"].new_unread, 1);
        // Without the baseline the same copy fails: the cutoff alone cannot tell them apart.
        let report = evaluate(&state, cutoff(), None).unwrap();
        assert!(report.violations.contains("activity.request:new"));
        assert!(report.violations.contains("tool.event:new"));
    }

    /// A line the previous build read but never emitted, and old activity under a
    /// new key, are history and fail the gate.
    #[test]
    fn read_but_unemitted_lines_and_rekeyed_activity_are_history() {
        let fails = |mutate: &dyn Fn(&State), class: &str| {
            let (_dir, state, baseline) = streams();
            mutate(&state);
            let report = evaluate(&state, cutoff(), Some(&baseline)).unwrap();
            assert!(report.violations.contains(class), "{class}: {report:#?}");
        };
        // Earlier than where the last run read the stream to.
        fails(
            &|state| {
                put(state, REQUEST, ("r-skipped", "k-skipped"), ("h6", None), request_in(EARLY, SESSION))
            },
            "activity.request:new",
        );
        fails(
            &|state| {
                put(state, TOOL, ("t-skipped", "t-skipped"), ("h7", None), tool_in(EARLY, SESSION));
                tool_row(state, "t-skipped", ORIGIN_DIRECT);
            },
            "tool.event:new",
        );
        // The same instant under a new session: a re-keyed duplicate.
        let rekeyed = "9999999999999999999999999999999999999999999999999999999999999999";
        fails(
            &|state| {
                put(state, REQUEST, ("r-rekeyed", "k-rekeyed"), ("h8", None), request_in(READ_TO, rekeyed))
            },
            "activity.request:new",
        );
    }
}
