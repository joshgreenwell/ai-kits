//! The four record types and the union over `record_type`.
//!
//! Every counter that is unknown is `null`, never `0`. Observation identity
//! (`record_id`, which collector saw it) is separate from semantic identity
//! (`semantic_key`, which provider request it was).

use jiff::Timestamp;
use serde::{Deserialize, Serialize};

use crate::enums::{
    Adapter, AllowanceKind, AllowanceUnit, Basis, Channel, EntryKind, ExecutionHost, MoneyUnit, Reader,
    RecordType, ReferenceKind, RequestOutcome, SessionIdentity, Surface,
};
use crate::envelope::Violation;
use crate::newtypes::{
    Amount, Code, Counter, MeterKey, Nullable, Real, Sha256Hex, Stamp, Text, ToolName, Uuid, ValueError,
};
use crate::{FUTURE_TOLERANCE_SECONDS, MAX_TOOLS_PER_REQUEST};

/// The four exclusive input and output classes plus reasoning, which is a
/// subset of output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tokens {
    pub input_fresh: Nullable<Counter>,
    pub input_cached: Nullable<Counter>,
    pub input_cache_write: Nullable<Counter>,
    pub output: Nullable<Counter>,
    pub reasoning: Nullable<Counter>,
}

impl Tokens {
    pub const UNKNOWN: Tokens = Tokens {
        input_fresh: Nullable::NULL,
        input_cached: Nullable::NULL,
        input_cache_write: Nullable::NULL,
        output: Nullable::NULL,
        reasoning: Nullable::NULL,
    };
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCount {
    pub name: ToolName,
    pub calls: Counter,
}

/// Ledger 1: one provider request as one collector observed it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityRequest {
    pub record_id: Uuid,
    pub binding_id: Uuid,
    pub adapter: Adapter,
    pub channel: Channel,
    /// Measurement time, not upload time.
    pub observed_at: Stamp,
    pub basis: Basis,
    pub parser_version: Text<0, 30>,
    /// `sha256(provider, account, provider request/message/turn id)`.
    pub semantic_key: Sha256Hex,
    pub product: Code,
    pub surface: Surface,
    pub execution_host: ExecutionHost,
    pub session_hash: Sha256Hex,
    pub session_identity: SessionIdentity,
    pub parent_session_hash: Nullable<Sha256Hex>,
    pub model_requested: Nullable<Text<0, 100>>,
    pub model_actual: Text<1, 100>,
    pub started_at: Nullable<Stamp>,
    pub ended_at: Nullable<Stamp>,
    pub tokens: Tokens,
    pub tool_calls: Nullable<Counter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolCount>>,
    pub project_hash: Nullable<Sha256Hex>,
    pub client_version: Nullable<Text<0, 40>>,
    pub latency_ms: Nullable<Counter>,
    pub outcome: RequestOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dimensions {
    pub model: Nullable<Text<0, 100>>,
    pub product: Nullable<Code>,
    pub client: Nullable<Code>,
    pub user_ref: Nullable<Sha256Hex>,
    pub workspace_ref: Nullable<Sha256Hex>,
    pub api_key_ref: Nullable<Sha256Hex>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Measures {
    pub requests: Nullable<Counter>,
    pub input_tokens: Nullable<Counter>,
    pub cached_tokens: Nullable<Counter>,
    pub cache_write_tokens: Nullable<Counter>,
    pub output_tokens: Nullable<Counter>,
    pub reasoning_tokens: Nullable<Counter>,
    pub total_tokens: Nullable<Counter>,
}

/// Ledger 2: provider-reported account usage for one bucket and dimension set.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountUsageBucket {
    pub record_id: Uuid,
    pub binding_id: Uuid,
    pub adapter: Adapter,
    pub channel: Channel,
    pub observed_at: Stamp,
    pub basis: Basis,
    pub parser_version: Text<0, 30>,
    /// `cursor_usage_events`, `anthropic_usage_report`, `openai_usage_completions`, ...
    pub report_source: Code,
    pub bucket_start: Stamp,
    pub bucket_end: Stamp,
    pub provider_timezone: Nullable<Text<0, 40>>,
    pub dimensions: Dimensions,
    pub measures: Measures,
    pub provider_event_id: Nullable<Text<0, 120>>,
    pub provider_refreshed_at: Nullable<Stamp>,
}

/// `window_minutes`: a positive integer up to one year.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct WindowMinutes(u64);

impl WindowMinutes {
    pub fn new(minutes: u64) -> Result<Self, ValueError> {
        if (1..=525_600).contains(&minutes) {
            Ok(WindowMinutes(minutes))
        } else {
            Err(ValueError::Literal(minutes))
        }
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl TryFrom<u64> for WindowMinutes {
    type Error = ValueError;
    fn try_from(minutes: u64) -> Result<Self, ValueError> {
        WindowMinutes::new(minutes)
    }
}

impl From<WindowMinutes> for u64 {
    fn from(value: WindowMinutes) -> u64 {
        value.0
    }
}

/// Ledger 3: one typed allowance reading from one reader.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AllowanceReading {
    pub record_id: Uuid,
    pub binding_id: Uuid,
    pub adapter: Adapter,
    pub channel: Channel,
    pub observed_at: Stamp,
    pub basis: Basis,
    pub parser_version: Text<0, 30>,
    /// Equal to the v1 `window_key` where one exists.
    pub meter_key: MeterKey,
    pub label: Text<1, 120>,
    pub kind: AllowanceKind,
    pub value: Nullable<Real>,
    pub unit: Nullable<AllowanceUnit>,
    pub capacity: Nullable<Real>,
    pub window_minutes: Nullable<WindowMinutes>,
    pub window_started_at: Nullable<Stamp>,
    pub resets_at: Nullable<Stamp>,
    pub reader: Reader,
    pub raw_window_id: Nullable<Text<0, 120>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub kind: ReferenceKind,
    pub key: Nullable<Text<0, 160>>,
}

/// Ledger 4: money. Estimates and provider charges are different entry kinds
/// and are never summed together.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoneyEntry {
    pub record_id: Uuid,
    pub binding_id: Uuid,
    pub adapter: Adapter,
    pub channel: Channel,
    pub observed_at: Stamp,
    pub basis: Basis,
    pub parser_version: Text<0, 30>,
    pub entry_kind: EntryKind,
    /// A decimal string; negative adjustments are valid money data.
    pub amount: Amount,
    pub unit: MoneyUnit,
    pub source_unit: Nullable<Code>,
    pub price_basis: Code,
    pub period_start: Nullable<Stamp>,
    pub period_end: Nullable<Stamp>,
    pub reference: Reference,
    pub sku: Nullable<Code>,
    pub model: Nullable<Text<0, 100>>,
}

/// A record of any type, tagged by `record_type`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "record_type")]
pub enum Record {
    #[serde(rename = "activity.request")]
    ActivityRequest(ActivityRequest),
    #[serde(rename = "account.usage_bucket")]
    AccountUsageBucket(AccountUsageBucket),
    #[serde(rename = "allowance.reading")]
    AllowanceReading(AllowanceReading),
    #[serde(rename = "money.entry")]
    MoneyEntry(MoneyEntry),
}

fn future(stamp: &Stamp, now: Timestamp, path: &str, field: &str, out: &mut Vec<Violation>) {
    if stamp.is_future(now, FUTURE_TOLERANCE_SECONDS) {
        out.push(Violation {
            path: format!("{path}.{field}"),
            rule: "timestamp is more than five minutes in the future",
        });
    }
}

impl Record {
    pub fn record_type(&self) -> RecordType {
        match self {
            Record::ActivityRequest(_) => RecordType::ActivityRequest,
            Record::AccountUsageBucket(_) => RecordType::AccountUsageBucket,
            Record::AllowanceReading(_) => RecordType::AllowanceReading,
            Record::MoneyEntry(_) => RecordType::MoneyEntry,
        }
    }

    pub fn record_id(&self) -> &Uuid {
        match self {
            Record::ActivityRequest(r) => &r.record_id,
            Record::AccountUsageBucket(r) => &r.record_id,
            Record::AllowanceReading(r) => &r.record_id,
            Record::MoneyEntry(r) => &r.record_id,
        }
    }

    pub fn binding_id(&self) -> &Uuid {
        match self {
            Record::ActivityRequest(r) => &r.binding_id,
            Record::AccountUsageBucket(r) => &r.binding_id,
            Record::AllowanceReading(r) => &r.binding_id,
            Record::MoneyEntry(r) => &r.binding_id,
        }
    }

    pub fn adapter(&self) -> Adapter {
        match self {
            Record::ActivityRequest(r) => r.adapter,
            Record::AccountUsageBucket(r) => r.adapter,
            Record::AllowanceReading(r) => r.adapter,
            Record::MoneyEntry(r) => r.adapter,
        }
    }

    pub fn channel(&self) -> Channel {
        match self {
            Record::ActivityRequest(r) => r.channel,
            Record::AccountUsageBucket(r) => r.channel,
            Record::AllowanceReading(r) => r.channel,
            Record::MoneyEntry(r) => r.channel,
        }
    }

    pub fn observed_at(&self) -> &Stamp {
        match self {
            Record::ActivityRequest(r) => &r.observed_at,
            Record::AccountUsageBucket(r) => &r.observed_at,
            Record::AllowanceReading(r) => &r.observed_at,
            Record::MoneyEntry(r) => &r.observed_at,
        }
    }

    pub fn parser_version(&self) -> &str {
        match self {
            Record::ActivityRequest(r) => r.parser_version.as_str(),
            Record::AccountUsageBucket(r) => r.parser_version.as_str(),
            Record::AllowanceReading(r) => r.parser_version.as_str(),
            Record::MoneyEntry(r) => r.parser_version.as_str(),
        }
    }

    /// The semantic identity used for local deduplication: `semantic_key` for
    /// requests, the record id otherwise.
    pub fn semantic_key(&self) -> String {
        match self {
            Record::ActivityRequest(r) => r.semantic_key.as_str().to_owned(),
            Record::AccountUsageBucket(r) => r.record_id.as_str().to_owned(),
            Record::AllowanceReading(r) => r.record_id.as_str().to_owned(),
            Record::MoneyEntry(r) => r.record_id.as_str().to_owned(),
        }
    }

    /// Checks the refinements JSON Schema cannot express. `path` prefixes each
    /// violation, e.g. `records[3]`.
    pub fn validate(&self, now: Timestamp, path: &str, out: &mut Vec<Violation>) {
        future(self.observed_at(), now, path, "observed_at", out);
        match self {
            Record::ActivityRequest(r) => {
                if let Some(started) = r.started_at.as_ref() {
                    future(started, now, path, "started_at", out);
                }
                if let Some(ended) = r.ended_at.as_ref() {
                    future(ended, now, path, "ended_at", out);
                }
                if let (Some(reasoning), Some(output)) =
                    (r.tokens.reasoning.as_ref(), r.tokens.output.as_ref())
                    && reasoning > output
                {
                    out.push(Violation {
                        path: format!("{path}.tokens.reasoning"),
                        rule: "reasoning is a subset of output",
                    });
                }
                if r.tools.as_ref().is_some_and(|tools| tools.len() > MAX_TOOLS_PER_REQUEST) {
                    out.push(Violation { path: format!("{path}.tools"), rule: "at most 50 tools" });
                }
            }
            Record::AccountUsageBucket(r) => {
                future(&r.bucket_start, now, path, "bucket_start", out);
                future(&r.bucket_end, now, path, "bucket_end", out);
                if let Some(refreshed) = r.provider_refreshed_at.as_ref() {
                    future(refreshed, now, path, "provider_refreshed_at", out);
                }
                if r.bucket_end.timestamp() <= r.bucket_start.timestamp() {
                    out.push(Violation { path: format!("{path}.bucket_end"), rule: "empty bucket" });
                }
            }
            Record::AllowanceReading(r) => {
                if let Some(started) = r.window_started_at.as_ref() {
                    future(started, now, path, "window_started_at", out);
                }
                if r.kind == AllowanceKind::PercentUsed
                    && !r.value.as_ref().is_some_and(|v| (0.0..=100.0).contains(&v.as_f64()))
                {
                    out.push(Violation { path: format!("{path}.value"), rule: "percent out of range" });
                }
                if let Some(resets) = r.resets_at.as_ref()
                    && resets.timestamp() <= r.observed_at.timestamp()
                {
                    out.push(Violation { path: format!("{path}.resets_at"), rule: "expired reading" });
                }
            }
            Record::MoneyEntry(r) => {
                if let Some(start) = r.period_start.as_ref() {
                    future(start, now, path, "period_start", out);
                }
                if let Some(end) = r.period_end.as_ref() {
                    future(end, now, path, "period_end", out);
                }
            }
        }
    }
}
