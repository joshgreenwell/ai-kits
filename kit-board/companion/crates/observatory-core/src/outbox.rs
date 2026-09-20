//! Envelope batching, the outbox, uploads, and receipts (run loop step 7).
//!
//! Buckets (400 per envelope), records, and coverage are batched into
//! envelopes, written to the outbox as exact bodies, uploaded in order, and
//! deleted once acknowledged. Per-record rejections are marked locally with the
//! server's reason and never retried.
//!
//! A body the Observatory refuses outright (a 4xx other than 401, 403, 408, or
//! 429, or a receipt this build cannot read) would otherwise be rebuilt
//! identically every run and block everything queued behind it. Such a body is
//! bisected until the refused record or bucket stands alone, that one is marked
//! locally and dropped, and the rest of the queue still uploads. Transport
//! failures, 5xx, 408, and 429 retain the queue for the next run as before, and
//! a 401 or 403 stops the run because no other body would be accepted either.

use std::collections::VecDeque;

use jiff::Timestamp;
use observatory_contract::{
    AdapterCoverage, Bucket, BucketEntry, Counter, Envelope, Lit, MAX_BODY_BYTES, Record, Run, Sha256Hex,
    Stamp, Text, Uuid,
};
use serde::Serialize;
use serde_json::json;

use crate::http::{Client, HttpError};
use crate::pyjson::digest;
use crate::state::{BucketRow, OutboxRow, State, StateError};

/// Bisections one queued body may spend per run isolating what the Observatory
/// refuses. Ten halvings reach a single record in a full body; the remainder
/// finds a second refused record in the same run. Halves that were accepted are
/// marked published, so the body rebuilt next run carries only what is still
/// unacknowledged and isolation resumes from there.
pub const MAX_SPLITS_PER_BODY: usize = 24;

/// Buckets per envelope, as v1 batched them.
pub const BUCKETS_PER_ENVELOPE: usize = 400;
/// Records per envelope; well under the schema's 2000 so a body stays under 2 MB.
pub const RECORDS_PER_ENVELOPE: usize = 1000;

/// The v1 `published` key for a bucket, scoped to its binding.
pub fn bucket_key(binding_id: &Uuid, row: &BucketRow) -> String {
    format!("{binding_id}:{}", digest(&json!([row.session_hash, row.hour, row.model])))
}

/// `digest(row)` as `collect.py` computes it over the sqlite row dictionary.
pub fn bucket_digest(row: &BucketRow) -> Sha256Hex {
    digest(&json!({
        "session_hash": row.session_hash, "hour": row.hour, "model": row.model,
        "input_tokens": row.input_tokens, "cached_tokens": row.cached_tokens,
        "cache_write_tokens": row.cache_write_tokens, "output_tokens": row.output_tokens,
        "calls": row.calls, "total_tokens": row.total_tokens,
    }))
}

/// Converts a local bucket row to the wire bucket; `None` when a component is
/// outside the contract (which the parity port makes impossible for real data).
pub fn bucket_from_row(row: &BucketRow) -> Option<Bucket> {
    let counter = |value: i64| Counter::new(u64::try_from(value).ok()?).ok();
    Some(Bucket {
        session_hash: row.session_hash.parse().ok()?,
        hour: Stamp::parse(&row.hour).ok()?,
        model: Text::try_from(row.model.clone()).ok()?,
        input_tokens: counter(row.input_tokens)?,
        cached_tokens: counter(row.cached_tokens)?,
        cache_write_tokens: counter(row.cache_write_tokens)?,
        output_tokens: counter(row.output_tokens)?,
        total_tokens: counter(row.total_tokens)?,
        calls: counter(row.calls)?,
    })
}

/// A record queued for publication with its stored content hash.
#[derive(Clone, Debug)]
pub struct Pending {
    pub record: Record,
    pub content_hash: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct Batched {
    pub envelopes: usize,
    pub buckets: usize,
    pub records: usize,
    pub bytes: u64,
}

fn split_until_fits(
    run: &Run,
    coverage: &[AdapterCoverage],
    buckets: &[BucketEntry],
    records: &[Record],
    bodies: &mut Vec<String>,
) -> Result<(), serde_json::Error> {
    let envelope = Envelope {
        schema_version: Lit,
        run: run.clone(),
        buckets: buckets.to_vec(),
        records: records.to_vec(),
        coverage: coverage.to_vec(),
    };
    let text = envelope.to_json()?;
    if text.len() <= MAX_BODY_BYTES || (buckets.len() + records.len()) <= 1 {
        bodies.push(text);
        return Ok(());
    }
    // Halve the larger side until the body fits.
    if records.len() >= buckets.len() {
        let (left, right) = records.split_at(records.len() / 2);
        split_until_fits(run, coverage, buckets, left, bodies)?;
        split_until_fits(run, &[], &[], right, bodies)
    } else {
        let (left, right) = buckets.split_at(buckets.len() / 2);
        split_until_fits(run, coverage, left, records, bodies)?;
        split_until_fits(run, &[], right, &[], bodies)
    }
}

/// Builds the envelope bodies for one run. There is always at least one body,
/// carrying coverage, as v1 always sent one.
pub fn build_bodies(
    run: &Run,
    buckets: Vec<BucketEntry>,
    records: Vec<Record>,
    coverage: Vec<AdapterCoverage>,
) -> Result<Vec<String>, serde_json::Error> {
    let mut bodies = Vec::new();
    let mut bucket_chunks = buckets.chunks(BUCKETS_PER_ENVELOPE).peekable();
    let mut record_chunks = records.chunks(RECORDS_PER_ENVELOPE).peekable();
    let mut first = true;
    while first || bucket_chunks.peek().is_some() || record_chunks.peek().is_some() {
        let bucket_chunk = bucket_chunks.next().unwrap_or(&[]);
        let record_chunk = record_chunks.next().unwrap_or(&[]);
        let coverage_for_body: &[AdapterCoverage] = if first { &coverage } else { &[] };
        split_until_fits(run, coverage_for_body, bucket_chunk, record_chunk, &mut bodies)?;
        first = false;
    }
    Ok(bodies)
}

/// Writes bodies to the outbox. Returns what was queued.
pub fn enqueue(state: &State, bodies: &[String], now: Timestamp) -> Result<Batched, StateError> {
    let created_at = Stamp::from_timestamp(now);
    let mut batched = Batched::default();
    for body in bodies {
        let hash = Sha256Hex::digest(body.as_bytes());
        if state.enqueue_outbox(hash.as_str(), body, created_at.as_str())? {
            batched.envelopes += 1;
            batched.bytes += body.len() as u64;
            if let Ok(envelope) = serde_json::from_str::<Envelope>(body) {
                batched.buckets += envelope.buckets.len();
                batched.records += envelope.records.len();
            }
        }
    }
    Ok(batched)
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct Publication {
    pub uploaded: usize,
    pub upload_bytes: u64,
    pub accepted_buckets: u64,
    pub accepted_records: u64,
    pub duplicates: u64,
    pub rejected: u64,
    pub retained: u64,
    /// Bodies the Observatory refused outright and the companion dropped after
    /// isolating them to one record, one bucket, or coverage alone.
    pub rejected_bodies: u64,
    /// Records marked `http_<status>` locally; never retried.
    pub isolated_records: u64,
    /// Buckets recorded as published at their refused digest, so they stay
    /// local until their totals change.
    pub isolated_buckets: u64,
    /// Bisections spent isolating refused bodies this run.
    pub splits: u64,
    /// The last code the Observatory refused a body with, when the run met one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection: Option<String>,
    /// The failure that stopped the run and retained the queue, when one did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Why a queued body could not be published.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Failure {
    /// The Observatory or the network was unavailable; retry the queue next run.
    Transient(String),
    /// The install key is not accepted; no other body would fare better.
    Auth(String),
    /// The Observatory refused this body's content; resending it unchanged cannot succeed.
    Terminal(String),
}

fn classify(error: &HttpError) -> Failure {
    let code = error_code(error);
    match error {
        HttpError::Status(401 | 403) | HttpError::NoKey => Failure::Auth(code),
        HttpError::Status(408 | 429) => Failure::Transient(code),
        HttpError::Status(status) if (400..500).contains(status) => Failure::Terminal(code),
        // A 2xx the client cannot read says nothing about the body; the server or the path
        // is misbehaving, so the queue waits rather than marking records rejected.
        HttpError::Decode => Failure::Transient(code),
        HttpError::Status(_)
        | HttpError::Transport
        | HttpError::Timeout
        | HttpError::InvalidUrl
        | HttpError::Redirect => Failure::Transient(code),
    }
}

/// A queued body with the outbox row it came from.
struct Queued {
    row: OutboxRow,
    /// Index of the outbox row this body descends from, for the split budget.
    origin: usize,
}

fn queued(payload: String, created_at: &str, origin: usize) -> Queued {
    let hash = Sha256Hex::digest(payload.as_bytes()).as_str().to_owned();
    Queued { row: OutboxRow { hash, payload, created_at: created_at.to_owned() }, origin }
}

/// Uploads every outbox body in order, storing receipts and marking what the
/// server acknowledged. A transient or authorization failure stops the run and
/// retains the rest; a body refused on its content is bisected until the
/// refused item stands alone, marked locally, and dropped, and the queue continues.
pub fn upload(state: &State, client: &Client, now: Timestamp) -> Result<Publication, StateError> {
    let mut publication = Publication::default();
    let received_at = Stamp::from_timestamp(now);
    let mut queue: VecDeque<Queued> =
        state.outbox()?.into_iter().enumerate().map(|(origin, row)| Queued { row, origin }).collect();
    let mut budgets = vec![MAX_SPLITS_PER_BODY; queue.len()];
    while let Some(Queued { row, origin }) = queue.pop_front() {
        let failure = match client.post_usage(row.payload.as_bytes()) {
            Ok(response) if response.ok => {
                state.begin()?;
                match acknowledge(state, &row.payload, &response, &received_at) {
                    Ok(()) => state.commit()?,
                    Err(error) => {
                        state.rollback()?;
                        return Err(error);
                    }
                }
                publication.uploaded += 1;
                publication.upload_bytes += row.payload.len() as u64;
                publication.accepted_buckets += response.accepted.buckets.get();
                publication.accepted_records += response.accepted.records.get();
                publication.duplicates += response.duplicates.get();
                publication.rejected += response.rejected.len() as u64;
                state.delete_outbox(&row.hash)?;
                continue;
            }
            Ok(_) => Failure::Transient("invalid_receipt".into()),
            Err(error) => classify(&error),
        };
        let code = match failure {
            Failure::Transient(code) | Failure::Auth(code) => {
                publication.error = Some(code);
                break;
            }
            Failure::Terminal(code) => code,
        };
        publication.rejection = Some(code.clone());
        let Ok(envelope) = serde_json::from_str::<Envelope>(&row.payload) else {
            // A body this build cannot read back cannot be isolated either.
            tracing::warn!(code = "outbox_body_unreadable", reason = code, "a refused body was dropped");
            state.delete_outbox(&row.hash)?;
            publication.rejected_bodies += 1;
            continue;
        };
        let items = envelope.buckets.len() + envelope.records.len();
        if let Some((left, right)) = split_envelope(&envelope).filter(|_| budgets[origin] > 0) {
            budgets[origin] -= 1;
            publication.splits += 1;
            state.begin()?;
            let requeued = (|| {
                state.delete_outbox(&row.hash)?;
                for body in [&left, &right] {
                    let hash = Sha256Hex::digest(body.as_bytes());
                    state.enqueue_outbox(hash.as_str(), body, &row.created_at)?;
                }
                Ok::<(), StateError>(())
            })();
            match requeued {
                Ok(()) => state.commit()?,
                Err(error) => {
                    state.rollback()?;
                    return Err(error);
                }
            }
            // Depth first, left half first, so a refused item is reached within the budget.
            queue.push_front(queued(right, &row.created_at, origin));
            queue.push_front(queued(left, &row.created_at, origin));
        } else if items > 1 {
            tracing::warn!(
                code = "outbox_isolation_deferred",
                reason = code,
                items,
                "a refused body keeps its remaining items for the next run"
            );
        } else {
            state.begin()?;
            match isolate(state, &envelope, &code) {
                Ok((buckets, records)) => {
                    state.delete_outbox(&row.hash)?;
                    state.commit()?;
                    publication.isolated_buckets += buckets;
                    publication.isolated_records += records;
                    publication.rejected_bodies += 1;
                }
                Err(error) => {
                    state.rollback()?;
                    return Err(error);
                }
            }
        }
    }
    publication.retained = state.outbox_len()?;
    Ok(publication)
}

/// Bisects a refused body: coverage first, since a coverage-only envelope is
/// always valid on its own, then the larger of the record and bucket sides as
/// `split_until_fits` does for size. `None` when there is at most one item.
fn split_envelope(envelope: &Envelope) -> Option<(String, String)> {
    let part = |buckets: &[BucketEntry], records: &[Record], coverage: &[AdapterCoverage]| Envelope {
        schema_version: Lit,
        run: envelope.run.clone(),
        buckets: buckets.to_vec(),
        records: records.to_vec(),
        coverage: coverage.to_vec(),
    };
    let items = envelope.buckets.len() + envelope.records.len();
    let (left, right) = if !envelope.coverage.is_empty() && items > 0 {
        (part(&[], &[], &envelope.coverage), part(&envelope.buckets, &envelope.records, &[]))
    } else if items <= 1 {
        return None;
    } else if envelope.records.len() >= envelope.buckets.len() {
        let (head, tail) = envelope.records.split_at(envelope.records.len() / 2);
        (part(&envelope.buckets, head, &[]), part(&[], tail, &[]))
    } else {
        let (head, tail) = envelope.buckets.split_at(envelope.buckets.len() / 2);
        (part(head, &envelope.records, &[]), part(tail, &[], &[]))
    };
    Some((left.to_json().ok()?, right.to_json().ok()?))
}

/// Marks the one item of a refused body so the rebuild never queues it again:
/// a record carries the code as its rejection, a bucket is recorded as published
/// at its refused digest. Returns the buckets and records marked.
fn isolate(state: &State, envelope: &Envelope, code: &str) -> Result<(u64, u64), StateError> {
    for entry in &envelope.buckets {
        let row = bucket_row(&entry.bucket);
        state.set_published(&bucket_key(&entry.binding_id, &row), bucket_digest(&row).as_str())?;
        tracing::warn!(
            code = "bucket_refused",
            reason = code,
            "an hourly bucket the Observatory refused stays local until its totals change"
        );
    }
    for record in &envelope.records {
        state.mark_record_rejected(record.record_id().as_str(), code)?;
    }
    Ok((envelope.buckets.len() as u64, envelope.records.len() as u64))
}

fn bucket_row(bucket: &Bucket) -> BucketRow {
    BucketRow {
        session_hash: bucket.session_hash.as_str().to_owned(),
        hour: bucket.hour.as_str().to_owned(),
        model: bucket.model.as_str().to_owned(),
        input_tokens: bucket.input_tokens.get() as i64,
        cached_tokens: bucket.cached_tokens.get() as i64,
        cache_write_tokens: bucket.cache_write_tokens.get() as i64,
        output_tokens: bucket.output_tokens.get() as i64,
        calls: bucket.calls.get() as i64,
        total_tokens: bucket.total_tokens.get() as i64,
    }
}

fn acknowledge(
    state: &State,
    payload: &str,
    response: &observatory_contract::UsageResponse,
    received_at: &Stamp,
) -> Result<(), StateError> {
    let envelope: Envelope = serde_json::from_str(payload).map_err(|_| StateError::Corrupt)?;
    let hash = Sha256Hex::digest(payload.as_bytes());
    let receipt = serde_json::to_string(response).map_err(|_| StateError::Corrupt)?;
    state.save_receipt(hash.as_str(), received_at.as_str(), &receipt)?;
    for entry in &envelope.buckets {
        let row = bucket_row(&entry.bucket);
        state.set_published(&bucket_key(&entry.binding_id, &row), bucket_digest(&row).as_str())?;
    }
    for record in &envelope.records {
        let record_id = record.record_id().as_str();
        match response.rejected.iter().find(|rejection| rejection.record_id.as_str() == record_id) {
            Some(rejection) => state.mark_record_rejected(record_id, rejection.reason.as_str())?,
            None => {
                let content_hash = observatory_contract::stable_json::content_hash(record)
                    .map_err(|_| StateError::Corrupt)?;
                state.mark_record_published(record_id, content_hash.as_str())?;
            }
        }
    }
    Ok(())
}

/// A bounded code for an upload failure; never the response text.
pub fn error_code(error: &HttpError) -> String {
    match error {
        HttpError::InvalidUrl => "invalid_url".into(),
        HttpError::Redirect => "redirect".into(),
        HttpError::Status(code) => format!("http_{code}"),
        HttpError::Transport => "transport".into(),
        HttpError::Timeout => "timeout".into(),
        HttpError::Decode => "invalid_receipt".into(),
        HttpError::NoKey => "no_key".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use observatory_contract::{Arch, Platform};

    fn run() -> Run {
        Run {
            run_id: Uuid::v4(),
            started_at: Stamp::parse("2026-09-02T01:00:00Z").unwrap(),
            finished_at: Stamp::parse("2026-09-02T01:00:01Z").unwrap(),
            companion_version: Text::try_from("2.0.0".to_owned()).unwrap(),
            platform: Platform::Linux,
            arch: Arch::Amd64,
            settings_version: Counter::ZERO,
        }
    }

    fn entry(index: u64) -> BucketEntry {
        let row = BucketRow {
            session_hash: "a".repeat(64),
            hour: "2026-09-02T01:00:00.000Z".into(),
            model: format!("m{index}"),
            input_tokens: 1,
            cached_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: 1,
            calls: 1,
            total_tokens: 2,
        };
        BucketEntry { binding_id: Uuid::v4(), bucket: bucket_from_row(&row).unwrap() }
    }

    #[test]
    fn always_one_body_and_batches_by_400() {
        let bodies = build_bodies(&run(), vec![], vec![], vec![]).unwrap();
        assert_eq!(bodies.len(), 1);
        let buckets: Vec<BucketEntry> = (0..401).map(entry).collect();
        let bodies = build_bodies(&run(), buckets, vec![], vec![]).unwrap();
        assert_eq!(bodies.len(), 2);
        let second: Envelope = serde_json::from_str(&bodies[1]).unwrap();
        assert_eq!(second.buckets.len(), 1);
        assert!(second.coverage.is_empty());
    }

    #[test]
    fn digests_match_v1_shapes() {
        let row = BucketRow {
            session_hash: "s".into(),
            hour: "h".into(),
            model: "m".into(),
            input_tokens: 1,
            cached_tokens: 2,
            cache_write_tokens: 3,
            output_tokens: 4,
            calls: 1,
            total_tokens: 10,
        };
        assert_eq!(
            bucket_digest(&row),
            Sha256Hex::digest(
                br#"{"cache_write_tokens":3,"cached_tokens":2,"calls":1,"hour":"h","input_tokens":1,"model":"m","output_tokens":4,"session_hash":"s","total_tokens":10}"#
            )
        );
    }

    // --- uploads against a loopback Observatory -----------------------------

    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    use serde_json::Value;

    use crate::config::Secret;
    use crate::state::RecordRow;

    /// A one-thread Observatory on the loopback interface: answers each usage
    /// post with the status `decide` returns for the envelope (a receipt
    /// accepting everything on 200) and keeps every envelope it saw.
    struct Observatory {
        client: Client,
        seen: Arc<Mutex<Vec<Envelope>>>,
    }

    fn serve(decide: impl Fn(&Envelope) -> u16 + Send + 'static) -> Observatory {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let Some(body) = read_request(&mut stream) else { continue };
                let envelope: Envelope = serde_json::from_str(&body).unwrap();
                let status = decide(&envelope);
                let payload = if status == 200 {
                    json!({
                        "ok": true, "schema_version": 2, "run_id": envelope.run.run_id.as_str(),
                        "accepted": { "buckets": envelope.buckets.len(), "records": envelope.records.len() },
                        "duplicates": 0, "rejected": [],
                    })
                    .to_string()
                } else {
                    json!({ "error": status }).to_string()
                };
                record.lock().unwrap().push(envelope);
                let response = format!(
                    "HTTP/1.1 {status} Status\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        Observatory { client: Client::new(&url, Some(Secret::new("k".repeat(43)))).unwrap(), seen }
    }

    fn read_request(stream: &mut std::net::TcpStream) -> Option<String> {
        let mut raw = Vec::new();
        let mut chunk = [0u8; 4096];
        let head_end = loop {
            let read = stream.read(&mut chunk).ok()?;
            if read == 0 {
                return None;
            }
            raw.extend_from_slice(&chunk[..read]);
            if let Some(position) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
                break position + 4;
            }
        };
        let head = String::from_utf8_lossy(&raw[..head_end]).to_ascii_lowercase();
        let length: usize = head
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(0);
        while raw.len() < head_end + length {
            let read = stream.read(&mut chunk).ok()?;
            if read == 0 {
                return None;
            }
            raw.extend_from_slice(&chunk[..read]);
        }
        Some(String::from_utf8_lossy(&raw[head_end..head_end + length]).into_owned())
    }

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/wire/valid/detail-contract-events.json"
        ))
        .unwrap()
    }

    /// The first `count` fixture records, stored as pending rows the way a run does.
    fn saved_records(state: &State, count: usize) -> Vec<Record> {
        let records: Vec<Record> = fixture()["records"]
            .as_array()
            .unwrap()
            .iter()
            .take(count)
            .map(|value| serde_json::from_value(value.clone()).unwrap())
            .collect();
        for record in &records {
            state
                .upsert_record(&RecordRow {
                    record_id: record.record_id().as_str().to_owned(),
                    binding_id: record.binding_id().as_str().to_owned(),
                    adapter: "claude_execution".into(),
                    record_type: record.record_type().as_str().into(),
                    semantic_key: record.semantic_key(),
                    content_hash: observatory_contract::stable_json::content_hash(record)
                        .unwrap()
                        .as_str()
                        .into(),
                    published_hash: None,
                    rejected_reason: None,
                    record: serde_json::to_string(record).unwrap(),
                    updated_at: "2026-09-02T01:00:00.000Z".into(),
                })
                .unwrap();
        }
        records
    }

    fn contains(envelope: &Envelope, record: &Record) -> bool {
        envelope.records.iter().any(|candidate| candidate.record_id() == record.record_id())
    }

    fn queue_one_body_each(state: &State, records: &[Record]) {
        for record in records {
            let bodies = build_bodies(&run(), vec![], vec![record.clone()], vec![]).unwrap();
            enqueue(state, &bodies, now()).unwrap();
        }
    }

    fn now() -> Timestamp {
        "2026-09-02T01:00:05Z".parse().unwrap()
    }

    fn rejected_reason(state: &State, record: &Record) -> Option<String> {
        state.record(record.record_id().as_str()).unwrap().unwrap().rejected_reason
    }

    fn published(state: &State, record: &Record) -> bool {
        let row = state.record(record.record_id().as_str()).unwrap().unwrap();
        row.published_hash.as_deref() == Some(row.content_hash.as_str())
    }

    #[test]
    fn a_refused_single_record_body_is_marked_and_the_later_bodies_still_upload() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let records = saved_records(&state, 3);
        queue_one_body_each(&state, &records);
        let refused = records[0].clone();
        let observatory = serve(move |envelope| if contains(envelope, &refused) { 422 } else { 200 });

        let publication = upload(&state, &observatory.client, now()).unwrap();

        assert_eq!(publication.error, None);
        assert_eq!(publication.rejection.as_deref(), Some("http_422"));
        assert_eq!((publication.uploaded, publication.accepted_records), (2, 2));
        assert_eq!(
            (publication.rejected_bodies, publication.isolated_records, publication.splits),
            (1, 1, 0)
        );
        assert_eq!(publication.retained, 0);
        assert_eq!(rejected_reason(&state, &records[0]).as_deref(), Some("http_422"));
        assert!(published(&state, &records[1]) && published(&state, &records[2]));
        // The rebuild reads pending rows; the marked record is no longer one.
        let pending: Vec<String> =
            state.pending_records(10).unwrap().into_iter().map(|row| row.record_id).collect();
        assert!(pending.is_empty(), "{pending:?}");
        assert_eq!(state.outbox_len().unwrap(), 0);
    }

    #[test]
    fn a_refused_record_inside_a_full_body_is_bisected_out_with_coverage_kept() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let records = saved_records(&state, 4);
        let coverage: Vec<AdapterCoverage> = serde_json::from_value(fixture()["coverage"].clone()).unwrap();
        assert!(!coverage.is_empty(), "the fixture carries coverage");
        let bodies = build_bodies(&run(), vec![], records.clone(), coverage).unwrap();
        assert_eq!(bodies.len(), 1);
        enqueue(&state, &bodies, now()).unwrap();
        let refused = records[2].clone();
        let observatory = serve(move |envelope| if contains(envelope, &refused) { 422 } else { 200 });

        let publication = upload(&state, &observatory.client, now()).unwrap();

        // whole (422), coverage (200), four (422), first pair (200), second pair (422),
        // the refused one alone (422), its sibling (200).
        let seen = observatory.seen.lock().unwrap();
        assert_eq!(seen.len(), 7);
        assert_eq!(seen[1].coverage.len(), 1);
        assert!(seen[1].records.is_empty() && seen[1].buckets.is_empty());
        assert!(seen[2].coverage.is_empty());
        assert_eq!((publication.uploaded, publication.splits, publication.rejected_bodies), (3, 3, 1));
        assert_eq!((publication.accepted_records, publication.isolated_records), (3, 1));
        assert_eq!(publication.retained, 0);
        assert_eq!(rejected_reason(&state, &records[2]).as_deref(), Some("http_422"));
        for index in [0, 1, 3] {
            assert!(published(&state, &records[index]), "record {index}");
        }
        assert!(state.pending_records(10).unwrap().is_empty());
    }

    #[test]
    fn a_refused_bucket_is_recorded_at_its_refused_digest_and_its_sibling_uploads() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let entries: Vec<BucketEntry> = (0..2).map(entry).collect();
        let bodies = build_bodies(&run(), entries.clone(), vec![], vec![]).unwrap();
        enqueue(&state, &bodies, now()).unwrap();
        let observatory = serve(|envelope| {
            if envelope.buckets.iter().any(|entry| entry.bucket.model.as_str() == "m1") { 422 } else { 200 }
        });

        let publication = upload(&state, &observatory.client, now()).unwrap();

        assert_eq!((publication.uploaded, publication.accepted_buckets), (1, 1));
        assert_eq!(
            (publication.isolated_buckets, publication.rejected_bodies, publication.splits),
            (1, 1, 1)
        );
        assert_eq!(publication.retained, 0);
        for entry in &entries {
            let row = bucket_row(&entry.bucket);
            assert_eq!(
                state.published_hash(&bucket_key(&entry.binding_id, &row)).unwrap().as_deref(),
                Some(bucket_digest(&row).as_str()),
                "{}",
                row.model
            );
        }
    }

    #[test]
    fn a_503_stops_the_run_and_retains_every_body() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let records = saved_records(&state, 2);
        queue_one_body_each(&state, &records);
        let observatory = serve(|_| 503);

        let publication = upload(&state, &observatory.client, now()).unwrap();

        assert_eq!(publication.error.as_deref(), Some("http_503"));
        assert_eq!(publication.rejection, None);
        assert_eq!((publication.uploaded, publication.rejected_bodies, publication.splits), (0, 0, 0));
        assert_eq!(publication.retained, 2);
        assert_eq!(observatory.seen.lock().unwrap().len(), 1);
        assert!(records.iter().all(|record| rejected_reason(&state, record).is_none()));
    }

    #[test]
    fn a_401_stops_the_run_and_retains_every_body() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let records = saved_records(&state, 2);
        queue_one_body_each(&state, &records);
        let observatory = serve(|_| 401);

        let publication = upload(&state, &observatory.client, now()).unwrap();

        assert_eq!(publication.error.as_deref(), Some("http_401"));
        assert_eq!((publication.uploaded, publication.rejected_bodies), (0, 0));
        assert_eq!(publication.retained, 2);
        assert_eq!(observatory.seen.lock().unwrap().len(), 1);
        assert!(records.iter().all(|record| rejected_reason(&state, record).is_none()));
        assert!(state.pending_records(10).unwrap().len() == 2);
    }

    #[test]
    fn failures_are_classified_by_what_a_retry_could_change() {
        assert_eq!(classify(&HttpError::Status(401)), Failure::Auth("http_401".into()));
        assert_eq!(classify(&HttpError::Status(403)), Failure::Auth("http_403".into()));
        assert_eq!(classify(&HttpError::NoKey), Failure::Auth("no_key".into()));
        for status in [408, 429, 500, 502, 503] {
            assert_eq!(classify(&HttpError::Status(status)), Failure::Transient(format!("http_{status}")));
        }
        assert_eq!(classify(&HttpError::Transport), Failure::Transient("transport".into()));
        assert_eq!(classify(&HttpError::Timeout), Failure::Transient("timeout".into()));
        for status in [400, 404, 409, 413, 415, 422] {
            assert_eq!(classify(&HttpError::Status(status)), Failure::Terminal(format!("http_{status}")));
        }
        assert_eq!(classify(&HttpError::Decode), Failure::Transient("invalid_receipt".into()));
    }
}
