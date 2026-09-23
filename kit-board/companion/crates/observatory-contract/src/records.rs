//! Usage records and the union over `record_type`.
//!
//! Every counter that is unknown is `null`, never `0`. Observation identity
//! (`record_id`, which collector saw it) is separate from semantic identity
//! (`semantic_key`, which provider request it was).

use jiff::Timestamp;
use serde::{Deserialize, Serialize};

use crate::enums::{
    AccessEvidenceBasis, AccessKind, Adapter, AgentClass, AgentEventKind, AgentRole, AllowanceKind,
    AllowanceUnit, Basis, Channel, CompositionState, EntryKind, EventOutcome, ExecutionHost, IdentityBasis,
    LabelKind, MembershipKind, MembershipResolution, MoneyUnit, ParentIdentityBasis, ProjectApp,
    ProjectBasis, ProjectState, Reader, RecordType, ReferenceKind, RequestOutcome, SessionIdentity, Surface,
    ToolClass, ToolEventKind,
};
use crate::envelope::Violation;
use crate::newtypes::{
    Amount, Code, Counter, LabelKey, LabelText, MeterKey, Nullable, ProjectName, Real, Sha256Hex, Stamp,
    Text, ToolName, Uuid, ValueError,
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

/// Provider pricing dimensions that materially affect the cost of a request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PricingEvidence {
    pub reasoning_effort: Nullable<Code>,
    pub service_tier: Nullable<Code>,
    pub speed: Nullable<Code>,
    pub context_window_tokens: Nullable<Counter>,
    pub cache_write_ttl: Nullable<Code>,
}

impl PricingEvidence {
    /// True when the block carries evidence beyond its presence on the wire.
    pub fn has_evidence(&self) -> bool {
        self.reasoning_effort.as_ref().is_some()
            || self.service_tier.as_ref().is_some()
            || self.speed.as_ref().is_some()
            || self.context_window_tokens.as_ref().is_some()
            || self.cache_write_ttl.as_ref().is_some()
    }
}

/// Reconciliation between a reported token total and the known exclusive classes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenAccounting {
    pub reported_total: Nullable<Counter>,
    pub unclassified: Nullable<Counter>,
    pub composition_state: CompositionState,
}

/// Stable, privacy-preserving attribution for an agent participating in a request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentAttribution {
    pub key: Nullable<Sha256Hex>,
    pub identity_basis: IdentityBasis,
    pub parent_key: Nullable<Sha256Hex>,
    pub parent_identity_basis: ParentIdentityBasis,
    pub class: AgentClass,
    pub name: Nullable<ToolName>,
    pub depth: Nullable<Counter>,
}

/// Stable project attribution. The basis says whether the provider supplied the
/// identity or the collector derived it from the working directory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectAttribution {
    pub key: Nullable<Sha256Hex>,
    pub basis: ProjectBasis,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolIdentity {
    pub name: Nullable<ToolName>,
    pub namespace: Nullable<Code>,
    pub class: ToolClass,
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
    pub model_actual: Nullable<Text<1, 100>>,
    pub started_at: Nullable<Stamp>,
    pub ended_at: Nullable<Stamp>,
    pub tokens: Tokens,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::newtypes::deserialize_optional_non_null"
    )]
    pub token_accounting: Option<TokenAccounting>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::newtypes::deserialize_optional_non_null"
    )]
    pub pricing: Option<PricingEvidence>,
    pub tool_calls: Nullable<Counter>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::newtypes::deserialize_optional_non_null"
    )]
    pub tools: Option<Vec<ToolCount>>,
    pub project_hash: Nullable<Sha256Hex>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::newtypes::deserialize_optional_non_null"
    )]
    pub project: Option<ProjectAttribution>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::newtypes::deserialize_optional_non_null"
    )]
    pub agent: Option<AgentAttribution>,
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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::newtypes::deserialize_optional_non_null"
    )]
    pub pricing: Option<PricingEvidence>,
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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::newtypes::deserialize_optional_non_null"
    )]
    pub token_accounting: Option<TokenAccounting>,
    pub provider_event_id: Nullable<Text<0, 120>>,
    pub provider_refreshed_at: Nullable<Stamp>,
}

/// One lifecycle event for a provider or collector-visible agent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentEvent {
    pub record_id: Uuid,
    pub binding_id: Uuid,
    pub adapter: Adapter,
    pub channel: Channel,
    pub observed_at: Stamp,
    pub basis: Basis,
    pub parser_version: Text<0, 30>,
    pub semantic_key: Sha256Hex,
    pub event_kind: AgentEventKind,
    pub session_hash: Nullable<Sha256Hex>,
    pub agent: AgentAttribution,
    pub tool_invocation_key: Nullable<Sha256Hex>,
    pub outcome: EventOutcome,
}

/// One invocation or result event for a tool call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolEvent {
    pub record_id: Uuid,
    pub binding_id: Uuid,
    pub adapter: Adapter,
    pub channel: Channel,
    pub observed_at: Stamp,
    pub basis: Basis,
    pub parser_version: Text<0, 30>,
    pub semantic_key: Sha256Hex,
    pub invocation_key: Sha256Hex,
    pub event_kind: ToolEventKind,
    pub session_hash: Nullable<Sha256Hex>,
    pub caller_request_key: Nullable<Sha256Hex>,
    pub caller_agent_key: Nullable<Sha256Hex>,
    pub parent_invocation_key: Nullable<Sha256Hex>,
    pub tool: ToolIdentity,
    pub outcome: EventOutcome,
}

/// One resource access attributed to a tool invocation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceAccess {
    pub record_id: Uuid,
    pub binding_id: Uuid,
    pub adapter: Adapter,
    pub channel: Channel,
    pub observed_at: Stamp,
    pub basis: Basis,
    pub parser_version: Text<0, 30>,
    pub semantic_key: Sha256Hex,
    pub invocation_key: Sha256Hex,
    pub resource_key: Code,
    pub configuration_version: Nullable<Code>,
    pub access_kind: AccessKind,
    pub evidence_basis: AccessEvidenceBasis,
    pub outcome: EventOutcome,
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

/// `project.catalog` `position`: a non-negative integer that fits the database's `integer`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct Position(u32);

impl Position {
    pub const MAX: u64 = 2_147_483_647;

    pub fn new(position: u64) -> Result<Self, ValueError> {
        match u32::try_from(position) {
            Ok(value) if position <= Position::MAX => Ok(Position(value)),
            _ => Err(ValueError::Literal(Position::MAX)),
        }
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

impl TryFrom<u64> for Position {
    type Error = ValueError;
    fn try_from(position: u64) -> Result<Self, ValueError> {
        Position::new(position)
    }
}

impl From<Position> for u64 {
    fn from(value: Position) -> u64 {
        u64::from(value.0)
    }
}

/// Side record: a readable name for a hashed key the ledger already holds. Names never
/// enter ledger records; they travel only here. There is no `channel` and no `basis`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NameLabel {
    pub record_id: Uuid,
    /// The install's carrier binding.
    pub binding_id: Uuid,
    /// The carrier binding's adapter.
    pub adapter: Adapter,
    pub observed_at: Stamp,
    pub parser_version: Text<0, 30>,
    pub kind: LabelKind,
    /// `h:<16 hex>` for `tool`, `tool_namespace` and `agent_name`; 64 hex for `agent` and
    /// `session_agent`. The exact ledger value.
    pub key: LabelKey,
    pub label: LabelText,
    /// Only on `agent` and `session_agent`.
    pub role: Nullable<AgentRole>,
    /// Only on `session_agent`: the parent composer's session hash.
    pub parent_key: Nullable<Sha256Hex>,
}

/// Side record: one project the owner created in an app.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectCatalog {
    pub record_id: Uuid,
    pub binding_id: Uuid,
    pub adapter: Adapter,
    pub observed_at: Stamp,
    pub parser_version: Text<0, 30>,
    pub app: ProjectApp,
    /// `sha256(stable_json(["app-project", app, account_id, app_project_id]))`, unkeyed.
    pub project_key: Sha256Hex,
    pub name: ProjectName,
    pub position: Nullable<Position>,
    pub state: ProjectState,
}

/// Side record: which app project a folder or a session belongs to, and why.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectMembership {
    pub record_id: Uuid,
    pub binding_id: Uuid,
    pub adapter: Adapter,
    pub observed_at: Stamp,
    pub parser_version: Text<0, 30>,
    pub member_kind: MembershipKind,
    /// A folder key (`effective_project_key`) or a ledger `session_hash`.
    pub member_key: Sha256Hex,
    /// Non-null exactly when `resolution` names a project.
    pub project_key: Nullable<Sha256Hex>,
    pub resolution: MembershipResolution,
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
    #[serde(rename = "agent.event")]
    AgentEvent(AgentEvent),
    #[serde(rename = "tool.event")]
    ToolEvent(ToolEvent),
    #[serde(rename = "resource.access")]
    ResourceAccess(ResourceAccess),
    #[serde(rename = "name.label")]
    NameLabel(NameLabel),
    #[serde(rename = "project.catalog")]
    ProjectCatalog(ProjectCatalog),
    #[serde(rename = "project.membership")]
    ProjectMembership(ProjectMembership),
}

fn future(stamp: &Stamp, now: Timestamp, path: &str, field: &str, out: &mut Vec<Violation>) {
    if stamp.is_future(now, FUTURE_TOLERANCE_SECONDS) {
        out.push(Violation {
            path: format!("{path}.{field}"),
            rule: "timestamp is more than five minutes in the future",
        });
    }
}

fn counter_value(value: &Nullable<Counter>) -> Option<u64> {
    value.as_ref().map(|counter| counter.get())
}

impl AgentAttribution {
    fn validate(&self, path: &str, out: &mut Vec<Violation>) {
        let key_absent = self.key.as_ref().is_none();
        if (self.identity_basis == IdentityBasis::Unknown) != key_absent {
            out.push(Violation {
                path: format!("{path}.key"),
                rule: "agent key must match its identity basis",
            });
        }

        let parent_absent =
            matches!(self.parent_identity_basis, ParentIdentityBasis::None | ParentIdentityBasis::Unknown);
        if parent_absent != self.parent_key.as_ref().is_none() {
            out.push(Violation {
                path: format!("{path}.parent_key"),
                rule: "parent agent key must match its identity basis",
            });
        }
    }
}

impl ProjectAttribution {
    fn validate(&self, path: &str, out: &mut Vec<Violation>) {
        let requires_key = matches!(self.basis, ProjectBasis::Native | ProjectBasis::WorkingDirectory);
        if requires_key != self.key.as_ref().is_some() {
            out.push(Violation {
                path: format!("{path}.key"),
                rule: "project key must match its attribution basis",
            });
        }
    }
}

impl TokenAccounting {
    fn validate(
        &self,
        components: [&Nullable<Counter>; 4],
        reasoning: &Nullable<Counter>,
        path: &str,
        out: &mut Vec<Violation>,
    ) {
        let output = counter_value(components[3]);
        let known: Vec<u64> = components.into_iter().filter_map(counter_value).collect();
        let known_sum: u64 = known.iter().sum();
        let all_known = known.len() == 4;
        let none_known = known.is_empty();
        let reasoning = counter_value(reasoning);
        let minimum_feasible_total = known_sum + if output.is_none() { reasoning.unwrap_or(0) } else { 0 };
        let no_token_evidence = none_known && reasoning.is_none();
        let reported = counter_value(&self.reported_total);
        let unclassified = counter_value(&self.unclassified);
        let exceeds_reported = reported.is_some_and(|total| minimum_feasible_total > total);

        match self.composition_state {
            CompositionState::Complete => {
                if !all_known {
                    out.push(Violation {
                        path: format!("{path}.composition_state"),
                        rule: "complete composition requires all exclusive token components",
                    });
                }
                if let Some(total) = reported {
                    if exceeds_reported {
                        out.push(Violation {
                            path: format!("{path}.composition_state"),
                            rule: "known token evidence exceeds the reported total",
                        });
                    }
                    if known_sum > total || unclassified != Some(total - known_sum) {
                        out.push(Violation {
                            path: format!("{path}.unclassified"),
                            rule: "unclassified tokens must equal the reported remainder",
                        });
                    }
                } else if unclassified.is_some() {
                    out.push(Violation {
                        path: format!("{path}.unclassified"),
                        rule: "unclassified tokens must equal the reported remainder",
                    });
                }
            }
            CompositionState::Partial => {
                if all_known || (no_token_evidence && reported.is_none()) {
                    out.push(Violation {
                        path: format!("{path}.composition_state"),
                        rule: "partial composition requires incomplete token evidence",
                    });
                }
                if let Some(total) = reported {
                    if exceeds_reported {
                        out.push(Violation {
                            path: format!("{path}.composition_state"),
                            rule: "known token evidence exceeds the reported total",
                        });
                    }
                    if known_sum > total || unclassified != Some(total - known_sum) {
                        out.push(Violation {
                            path: format!("{path}.unclassified"),
                            rule: "unclassified tokens must equal the reported remainder",
                        });
                    }
                } else if unclassified.is_some() {
                    out.push(Violation {
                        path: format!("{path}.unclassified"),
                        rule: "a partial composition without a reported total has no known remainder",
                    });
                }
            }
            CompositionState::Inconsistent => {
                if reported.is_none() || !exceeds_reported {
                    out.push(Violation {
                        path: format!("{path}.composition_state"),
                        rule: "inconsistent composition requires known token evidence above a reported total",
                    });
                }
                if unclassified.is_some() {
                    out.push(Violation {
                        path: format!("{path}.unclassified"),
                        rule: "inconsistent composition cannot have a remainder",
                    });
                }
            }
            CompositionState::Unknown => {
                if !no_token_evidence || reported.is_some() || unclassified.is_some() {
                    out.push(Violation {
                        path: format!("{path}.composition_state"),
                        rule: "unknown composition cannot contain token evidence",
                    });
                }
            }
        }
    }
}

impl Record {
    pub fn record_type(&self) -> RecordType {
        match self {
            Record::ActivityRequest(_) => RecordType::ActivityRequest,
            Record::AccountUsageBucket(_) => RecordType::AccountUsageBucket,
            Record::AllowanceReading(_) => RecordType::AllowanceReading,
            Record::MoneyEntry(_) => RecordType::MoneyEntry,
            Record::AgentEvent(_) => RecordType::AgentEvent,
            Record::ToolEvent(_) => RecordType::ToolEvent,
            Record::ResourceAccess(_) => RecordType::ResourceAccess,
            Record::NameLabel(_) => RecordType::NameLabel,
            Record::ProjectCatalog(_) => RecordType::ProjectCatalog,
            Record::ProjectMembership(_) => RecordType::ProjectMembership,
        }
    }

    pub fn record_id(&self) -> &Uuid {
        match self {
            Record::ActivityRequest(r) => &r.record_id,
            Record::AccountUsageBucket(r) => &r.record_id,
            Record::AllowanceReading(r) => &r.record_id,
            Record::MoneyEntry(r) => &r.record_id,
            Record::AgentEvent(r) => &r.record_id,
            Record::ToolEvent(r) => &r.record_id,
            Record::ResourceAccess(r) => &r.record_id,
            Record::NameLabel(r) => &r.record_id,
            Record::ProjectCatalog(r) => &r.record_id,
            Record::ProjectMembership(r) => &r.record_id,
        }
    }

    pub fn binding_id(&self) -> &Uuid {
        match self {
            Record::ActivityRequest(r) => &r.binding_id,
            Record::AccountUsageBucket(r) => &r.binding_id,
            Record::AllowanceReading(r) => &r.binding_id,
            Record::MoneyEntry(r) => &r.binding_id,
            Record::AgentEvent(r) => &r.binding_id,
            Record::ToolEvent(r) => &r.binding_id,
            Record::ResourceAccess(r) => &r.binding_id,
            Record::NameLabel(r) => &r.binding_id,
            Record::ProjectCatalog(r) => &r.binding_id,
            Record::ProjectMembership(r) => &r.binding_id,
        }
    }

    pub fn adapter(&self) -> Adapter {
        match self {
            Record::ActivityRequest(r) => r.adapter,
            Record::AccountUsageBucket(r) => r.adapter,
            Record::AllowanceReading(r) => r.adapter,
            Record::MoneyEntry(r) => r.adapter,
            Record::AgentEvent(r) => r.adapter,
            Record::ToolEvent(r) => r.adapter,
            Record::ResourceAccess(r) => r.adapter,
            Record::NameLabel(r) => r.adapter,
            Record::ProjectCatalog(r) => r.adapter,
            Record::ProjectMembership(r) => r.adapter,
        }
    }

    /// The channel of a ledger record; `None` for a side record, which has none.
    pub fn channel(&self) -> Option<Channel> {
        match self {
            Record::ActivityRequest(r) => Some(r.channel),
            Record::AccountUsageBucket(r) => Some(r.channel),
            Record::AllowanceReading(r) => Some(r.channel),
            Record::MoneyEntry(r) => Some(r.channel),
            Record::AgentEvent(r) => Some(r.channel),
            Record::ToolEvent(r) => Some(r.channel),
            Record::ResourceAccess(r) => Some(r.channel),
            Record::NameLabel(_) | Record::ProjectCatalog(_) | Record::ProjectMembership(_) => None,
        }
    }

    /// True for `name.label`, `project.catalog` and `project.membership`.
    pub fn is_side(&self) -> bool {
        self.record_type().is_side()
    }

    pub fn observed_at(&self) -> &Stamp {
        match self {
            Record::ActivityRequest(r) => &r.observed_at,
            Record::AccountUsageBucket(r) => &r.observed_at,
            Record::AllowanceReading(r) => &r.observed_at,
            Record::MoneyEntry(r) => &r.observed_at,
            Record::AgentEvent(r) => &r.observed_at,
            Record::ToolEvent(r) => &r.observed_at,
            Record::ResourceAccess(r) => &r.observed_at,
            Record::NameLabel(r) => &r.observed_at,
            Record::ProjectCatalog(r) => &r.observed_at,
            Record::ProjectMembership(r) => &r.observed_at,
        }
    }

    pub fn parser_version(&self) -> &str {
        match self {
            Record::ActivityRequest(r) => r.parser_version.as_str(),
            Record::AccountUsageBucket(r) => r.parser_version.as_str(),
            Record::AllowanceReading(r) => r.parser_version.as_str(),
            Record::MoneyEntry(r) => r.parser_version.as_str(),
            Record::AgentEvent(r) => r.parser_version.as_str(),
            Record::ToolEvent(r) => r.parser_version.as_str(),
            Record::ResourceAccess(r) => r.parser_version.as_str(),
            Record::NameLabel(r) => r.parser_version.as_str(),
            Record::ProjectCatalog(r) => r.parser_version.as_str(),
            Record::ProjectMembership(r) => r.parser_version.as_str(),
        }
    }

    /// The semantic identity used for local deduplication: `semantic_key` for
    /// request and event records, the record id for the legacy ledgers, and the
    /// target key for side records (`<kind>:<key>`, the project key, or
    /// `<member_kind>:<member_key>`), which never depends on the carrier binding.
    pub fn semantic_key(&self) -> String {
        match self {
            Record::ActivityRequest(r) => r.semantic_key.as_str().to_owned(),
            Record::AccountUsageBucket(r) => r.record_id.as_str().to_owned(),
            Record::AllowanceReading(r) => r.record_id.as_str().to_owned(),
            Record::MoneyEntry(r) => r.record_id.as_str().to_owned(),
            Record::AgentEvent(r) => r.semantic_key.as_str().to_owned(),
            Record::ToolEvent(r) => r.semantic_key.as_str().to_owned(),
            Record::ResourceAccess(r) => r.semantic_key.as_str().to_owned(),
            Record::NameLabel(r) => format!("{}:{}", r.kind, r.key),
            Record::ProjectCatalog(r) => r.project_key.as_str().to_owned(),
            Record::ProjectMembership(r) => format!("{}:{}", r.member_kind, r.member_key),
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
                if let Some(accounting) = &r.token_accounting {
                    accounting.validate(
                        [
                            &r.tokens.input_fresh,
                            &r.tokens.input_cached,
                            &r.tokens.input_cache_write,
                            &r.tokens.output,
                        ],
                        &r.tokens.reasoning,
                        &format!("{path}.token_accounting"),
                        out,
                    );
                }
                if let Some(agent) = &r.agent {
                    agent.validate(&format!("{path}.agent"), out);
                }
                if let Some(project) = &r.project {
                    project.validate(&format!("{path}.project"), out);
                    let alias_matches = match project.basis {
                        ProjectBasis::WorkingDirectory => project.key == r.project_hash,
                        ProjectBasis::Native | ProjectBasis::None | ProjectBasis::Unknown => {
                            r.project_hash.as_ref().is_none()
                        }
                    };
                    if !alias_matches {
                        out.push(Violation {
                            path: format!("{path}.project_hash"),
                            rule: "legacy project hash must match project attribution",
                        });
                    }
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
                if let (Some(reasoning), Some(output)) =
                    (r.measures.reasoning_tokens.as_ref(), r.measures.output_tokens.as_ref())
                    && reasoning > output
                {
                    out.push(Violation {
                        path: format!("{path}.measures.reasoning_tokens"),
                        rule: "reasoning is a subset of output",
                    });
                }
                if let Some(accounting) = &r.token_accounting {
                    if accounting.reported_total != r.measures.total_tokens {
                        out.push(Violation {
                            path: format!("{path}.token_accounting.reported_total"),
                            rule: "accounting total must match the provider measure",
                        });
                    }
                    accounting.validate(
                        [
                            &r.measures.input_tokens,
                            &r.measures.cached_tokens,
                            &r.measures.cache_write_tokens,
                            &r.measures.output_tokens,
                        ],
                        &r.measures.reasoning_tokens,
                        &format!("{path}.token_accounting"),
                        out,
                    );
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
                if let Some(resets) = r.resets_at.as_ref() {
                    if resets.timestamp() <= r.observed_at.timestamp() {
                        out.push(Violation { path: format!("{path}.resets_at"), rule: "expired reading" });
                    }
                    // A window resets within its own length; a reset far beyond it is a bad
                    // clock or a hand-written sample and would pin the forecast for weeks.
                    let horizon =
                        r.window_minutes.as_ref().map_or(90 * 86_400, |m| m.get() as i64 * 60 + 86_400);
                    if resets.timestamp().as_second() > r.observed_at.timestamp().as_second() + horizon {
                        out.push(Violation {
                            path: format!("{path}.resets_at"),
                            rule: "reset beyond window",
                        });
                    }
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
            Record::AgentEvent(r) => {
                r.agent.validate(&format!("{path}.agent"), out);
                let child_must_exist =
                    r.event_kind != AgentEventKind::Spawn || r.outcome == EventOutcome::Succeeded;
                if child_must_exist && r.agent.key.as_ref().is_none() {
                    out.push(Violation {
                        path: format!("{path}.agent.key"),
                        rule: "observed agent lifecycle events require an agent key",
                    });
                }
            }
            Record::ToolEvent(r) => {
                let is_invocation_identity = r.semantic_key == r.invocation_key;
                if (r.event_kind == ToolEventKind::Invocation) != is_invocation_identity {
                    out.push(Violation {
                        path: format!("{path}.semantic_key"),
                        rule: "invocation and result event identities must remain distinct",
                    });
                }
            }
            Record::ResourceAccess(_) => {}
            Record::NameLabel(r) => {
                if r.kind.is_hashed_name() != r.key.is_hashed_name() {
                    out.push(Violation {
                        path: format!("{path}.key"),
                        rule: "label key must match its kind",
                    });
                }
                if !r.kind.allows_role() && r.role.as_ref().is_some() {
                    out.push(Violation {
                        path: format!("{path}.role"),
                        rule: "only agent and session agent labels carry a role",
                    });
                }
                if !r.kind.allows_parent_key() && r.parent_key.as_ref().is_some() {
                    out.push(Violation {
                        path: format!("{path}.parent_key"),
                        rule: "only session agent labels carry a parent key",
                    });
                }
            }
            Record::ProjectCatalog(_) => {}
            Record::ProjectMembership(r) => {
                if r.resolution.names_project() != r.project_key.as_ref().is_some() {
                    out.push(Violation {
                        path: format!("{path}.project_key"),
                        rule: "project key must match its resolution",
                    });
                }
            }
        }
    }
}
