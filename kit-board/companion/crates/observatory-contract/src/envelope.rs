//! Envelope v2 (`POST /api/v1/usage`).

use std::fmt;

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::coverage::AdapterCoverage;
use crate::enums::{Arch, Platform};
use crate::newtypes::{Counter, Lit, Sha256Hex, Stamp, Text, Uuid};
use crate::records::Record;
use crate::{
    FUTURE_TOLERANCE_SECONDS, MAX_BUCKETS_PER_ENVELOPE, MAX_COVERAGE_PER_ENVELOPE, MAX_RECORDS_PER_ENVELOPE,
};

/// One refinement the value failed. `path` is a JSON pointer-like location.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Violation {
    pub path: String,
    pub rule: &'static str,
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.path, self.rule)
    }
}

#[derive(Debug, Error)]
pub enum EnvelopeError {
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("contract violations: {}", .0.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "))]
    Violations(Vec<Violation>),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Run {
    pub run_id: Uuid,
    pub started_at: Stamp,
    pub finished_at: Stamp,
    pub companion_version: Text<0, 30>,
    pub platform: Platform,
    pub arch: Arch,
    pub settings_version: Counter,
}

/// The v1 hourly bucket (`bucketSchema`), reused verbatim: exclusive token
/// classes that sum to `total_tokens`, keyed by session hash, UTC hour, and model.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bucket {
    pub session_hash: Sha256Hex,
    pub hour: Stamp,
    pub model: Text<1, 100>,
    pub input_tokens: Counter,
    pub cached_tokens: Counter,
    pub cache_write_tokens: Counter,
    pub output_tokens: Counter,
    pub total_tokens: Counter,
    pub calls: Counter,
}

impl Bucket {
    pub fn validate(&self, now: Timestamp, path: &str, out: &mut Vec<Violation>) {
        if self.hour.is_future(now, FUTURE_TOLERANCE_SECONDS) {
            out.push(Violation {
                path: format!("{path}.hour"),
                rule: "timestamp is more than five minutes in the future",
            });
        }
        if !self.hour.is_hour_boundary() {
            out.push(Violation { path: format!("{path}.hour"), rule: "expected a UTC hour boundary" });
        }
        let sum = self.input_tokens.get()
            + self.cached_tokens.get()
            + self.cache_write_tokens.get()
            + self.output_tokens.get();
        if sum != self.total_tokens.get() {
            out.push(Violation {
                path: format!("{path}.total_tokens"),
                rule: "token components must be exclusive and sum to total",
            });
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BucketEntry {
    pub binding_id: Uuid,
    pub bucket: Bucket,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub schema_version: Lit<2>,
    pub run: Run,
    #[serde(default)]
    pub buckets: Vec<BucketEntry>,
    #[serde(default)]
    pub records: Vec<Record>,
    pub coverage: Vec<AdapterCoverage>,
}

impl Envelope {
    /// Checks every refinement the schema cannot express, against `now`.
    pub fn validate(&self, now: Timestamp) -> Result<(), Vec<Violation>> {
        let mut out = Vec::new();
        if self.run.started_at.is_future(now, FUTURE_TOLERANCE_SECONDS) {
            out.push(Violation {
                path: "run.started_at".into(),
                rule: "timestamp is more than five minutes in the future",
            });
        }
        if self.run.finished_at.is_future(now, FUTURE_TOLERANCE_SECONDS) {
            out.push(Violation {
                path: "run.finished_at".into(),
                rule: "timestamp is more than five minutes in the future",
            });
        }
        if self.buckets.len() > MAX_BUCKETS_PER_ENVELOPE {
            out.push(Violation { path: "buckets".into(), rule: "at most 500 buckets" });
        }
        if self.records.len() > MAX_RECORDS_PER_ENVELOPE {
            out.push(Violation { path: "records".into(), rule: "at most 2000 records" });
        }
        if self.coverage.len() > MAX_COVERAGE_PER_ENVELOPE {
            out.push(Violation { path: "coverage".into(), rule: "at most 32 coverage entries" });
        }
        for (index, entry) in self.buckets.iter().enumerate() {
            entry.bucket.validate(now, &format!("buckets[{index}].bucket"), &mut out);
        }
        for (index, record) in self.records.iter().enumerate() {
            record.validate(now, &format!("records[{index}]"), &mut out);
        }
        if out.is_empty() { Ok(()) } else { Err(out) }
    }

    /// Parses JSON into the types and applies the refinements.
    pub fn parse(text: &str, now: Timestamp) -> Result<Envelope, EnvelopeError> {
        let envelope: Envelope = serde_json::from_str(text)?;
        envelope.validate(now).map_err(EnvelopeError::Violations)?;
        Ok(envelope)
    }

    pub fn to_json(&self) -> serde_json::Result<String> {
        serde_json::to_string(self)
    }
}
