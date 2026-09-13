//! Wire types for the Personal Observatory usage contract, envelope v2.
//!
//! `kit-board/lib/usage-contract.ts` is the single authority for the contract. The
//! types here are hand-written to match it field for field: every object denies
//! unknown fields, every enum is closed, every counter is a non-negative safe
//! integer, and every timestamp is RFC 3339 with an offset. Cross-field
//! refinements that JSON Schema cannot express (reasoning within output, reset
//! after observation, non-empty buckets, exclusive token sums, timestamps at most
//! five minutes in the future) live in the `validate` methods and are exercised by
//! the same fixture corpus the server feeds to zod.
//!
//! `schema/usage-v2.schema.json` is the JSON Schema generated from the zod
//! definition and vendored byte-identically; `cargo test` proves the types and
//! the schema agree on `kit-board/tests/fixtures/usage-v2/wire/`.
#![forbid(unsafe_code)]
#![deny(unused_must_use)]

pub mod api;
pub mod config;
pub mod coverage;
pub mod enums;
pub mod envelope;
pub mod newtypes;
pub mod records;
pub mod settings;
pub mod stable_json;

pub use api::{
    Accepted, BindingRequest, BindingResponse, IdentityRequest, IdentityResponse, PairRequest, PairResponse,
    Rejection, SettingsResponse, UsageResponse,
};
pub use config::{BindingInfo, CompanionInfo, ConfigDocument, InstallInfo};
pub use coverage::AdapterCoverage;
pub use enums::{
    Adapter, AllowanceKind, AllowanceUnit, Arch, Basis, Channel, CoverageState, CursorState, DetailCode,
    EntryKind, ExecutionHost, InstallKind, MoneyUnit, Platform, Provider, Reader, RecordType, ReferenceKind,
    RejectionReason, RequestOutcome, SessionIdentity, Surface, UnknownVariant,
};
pub use envelope::{Bucket, BucketEntry, Envelope, Run, Violation};
pub use newtypes::{
    AccountId, Amount, Code, Counter, Lit, MAX_SAFE_INTEGER, MeterKey, Nullable, Real, Sha256Hex, Stamp,
    Text, ToolName, Uuid, ValueError,
};
pub use records::{
    AccountUsageBucket, ActivityRequest, AllowanceReading, Dimensions, Measures, MoneyEntry, Record,
    Reference, Tokens, ToolCount,
};
pub use settings::{CollectionSettings, Gate, InstallOverride};

/// The vendored JSON Schema, byte-identical to `kit-board/lib/generated/usage-v2.schema.json`.
pub const SCHEMA_JSON: &str = include_str!("../schema/usage-v2.schema.json");

/// Envelope body limit in bytes, measured on the serialized JSON exactly as the server measures it.
pub const MAX_BODY_BYTES: usize = 2_000_000;
/// Array limits from the envelope schema.
pub const MAX_BUCKETS_PER_ENVELOPE: usize = 500;
pub const MAX_RECORDS_PER_ENVELOPE: usize = 2000;
pub const MAX_COVERAGE_PER_ENVELOPE: usize = 32;
pub const MAX_TOOLS_PER_REQUEST: usize = 50;
/// A `stamp` may be at most this far in the future relative to the validating clock.
pub const FUTURE_TOLERANCE_SECONDS: i64 = 300;
