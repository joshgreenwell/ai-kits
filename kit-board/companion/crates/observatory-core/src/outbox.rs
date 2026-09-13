//! Envelope batching, the outbox, uploads, and receipts (run loop step 7).
//!
//! Buckets (400 per envelope), records, and coverage are batched into
//! envelopes, written to the outbox as exact bodies, uploaded in order, and
//! deleted once acknowledged. Per-record rejections are marked locally with the
//! server's reason and never retried.

use jiff::Timestamp;
use observatory_contract::{
    AdapterCoverage, Bucket, BucketEntry, Counter, Envelope, Lit, MAX_BODY_BYTES, Record, Run, Sha256Hex,
    Stamp, Text, Uuid,
};
use serde::Serialize;
use serde_json::json;

use crate::http::{Client, HttpError};
use crate::pyjson::digest;
use crate::state::{BucketRow, State, StateError};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Uploads every outbox body in order, storing receipts and marking what the
/// server acknowledged. Stops at the first failure and retains the rest.
pub fn upload(state: &State, client: &Client, now: Timestamp) -> Result<Publication, StateError> {
    let mut publication = Publication::default();
    let received_at = Stamp::from_timestamp(now);
    for row in state.outbox()? {
        let response = match client.post_usage(row.payload.as_bytes()) {
            Ok(response) if response.ok => response,
            Ok(_) => {
                publication.error = Some("invalid_receipt".into());
                break;
            }
            Err(error) => {
                publication.error = Some(error_code(&error));
                break;
            }
        };
        state.begin()?;
        let outcome = acknowledge(state, &row.payload, &response, &received_at);
        match outcome {
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
    }
    publication.retained = state.outbox_len()?;
    Ok(publication)
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
        let row = BucketRow {
            session_hash: entry.bucket.session_hash.as_str().to_owned(),
            hour: entry.bucket.hour.as_str().to_owned(),
            model: entry.bucket.model.as_str().to_owned(),
            input_tokens: entry.bucket.input_tokens.get() as i64,
            cached_tokens: entry.bucket.cached_tokens.get() as i64,
            cache_write_tokens: entry.bucket.cache_write_tokens.get() as i64,
            output_tokens: entry.bucket.output_tokens.get() as i64,
            calls: entry.bucket.calls.get() as i64,
            total_tokens: entry.bucket.total_tokens.get() as i64,
        };
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
}
