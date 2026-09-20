//! `activity.request` records from saved events, emitted when `detail_level`
//! is `requests` or `requests_with_tools`. The latter adds a stable invocation
//! total and privacy-filtered tool names. `project_hash` is filled only when
//! `project_attribution` is `hashed`; the hash is of the working directory
//! alone (`jsonl::project_hash`) and the path stays on this machine.

use observatory_contract::settings::{
    DetailLevel, ProjectAttribution as ProjectAttributionSetting, ToolDetail,
};
use observatory_contract::{
    ActivityRequest, Adapter, Basis, CapabilityCoverage, CapabilityDimension, CapabilityState, Channel, Code,
    CompositionState, Counter, ExecutionHost, Nullable, PricingEvidence, ProjectAttribution, ProjectBasis,
    Record, RequestOutcome, SessionIdentity, Sha256Hex, Stamp, Surface, Text, TokenAccounting, Tokens, Uuid,
};
use observatory_core::adapter::record_id;
use observatory_core::state::EventRow;
use observatory_core::state::{ToolCoverageRow, ToolEventRow};

use crate::agents::{attribution as agent_attribution, is_known_child_fields};
use crate::resources::ResourceEvidenceSummary;
use crate::tools::ToolIndex;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EvidenceSummary {
    pub requests: u64,
    pub incomplete_tokens: u64,
    pub unbackfilled_requests: u64,
    pub with_pricing: u64,
    pub with_agent: u64,
    pub unknown_agent: u64,
    pub with_project_identity: u64,
    pub no_project: u64,
    pub unknown_project: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ToolEvidenceSummary {
    pub invocations: u64,
    pub unmapped_forms: bool,
    pub truncated_names: bool,
}

impl ToolEvidenceSummary {
    pub fn observe(&mut self, rows: &[ToolEventRow], coverage: ToolCoverageRow) {
        self.invocations += rows.iter().filter(|row| row.event_kind == "invocation").count() as u64;
        self.unmapped_forms |= coverage.unmapped_forms;
        self.truncated_names |= coverage.truncated_names;
    }
}

impl EvidenceSummary {
    pub fn observe(&mut self, event: &EventRow) {
        self.requests += 1;
        if !event.detail_observed {
            self.unbackfilled_requests += 1;
            self.incomplete_tokens += 1;
        } else if [
            event.detail_input_fresh,
            event.detail_input_cached,
            event.detail_input_cache_write,
            event.detail_output,
        ]
        .iter()
        .any(Option::is_none)
        {
            self.incomplete_tokens += 1;
        }
        if event.reasoning_effort.is_some()
            || event.service_tier.is_some()
            || event.speed.is_some()
            || event.context_window_tokens.is_some()
            || event.cache_write_ttl.is_some()
        {
            self.with_pricing += 1;
        }
        if event.agent_observed {
            self.with_agent += 1;
            if event.agent_key.is_none() || event.agent_class == "unknown" {
                self.unknown_agent += 1;
            }
        }
        match event.project_basis.as_str() {
            "native" | "working_directory" if event.project_key.is_some() => {
                self.with_project_identity += 1;
            }
            "none" if event.project_key.is_none() => self.no_project += 1,
            _ => self.unknown_project += 1,
        }
    }
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

/// Capability coverage for local execution histories. Pricing remains partial
/// because neither transcript format records every catalog dimension.
/// `unmatched` and `no_evidence` inspections are expected outcomes for the
/// resource dimension, never gaps; only forms the classifier cannot read make
/// it partial. An adapter that also reads an allowance meter appends its
/// `allowance` row (the eighth and last); the detail level does not gate it.
#[allow(clippy::too_many_arguments)]
pub fn execution_capabilities(
    detail_level: DetailLevel,
    project_attribution: ProjectAttributionSetting,
    include_subagents: bool,
    scan_partial: bool,
    summary: EvidenceSummary,
    tools: ToolEvidenceSummary,
    resources: ResourceEvidenceSummary,
    allowance: Option<CapabilityCoverage>,
) -> Vec<CapabilityCoverage> {
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
        .chain(allowance)
        .collect();
    }
    let request_partial = scan_partial || summary.unbackfilled_requests > 0;
    let request_state = if request_partial { CapabilityState::Partial } else { CapabilityState::Complete };
    let request_detail = if summary.unbackfilled_requests > 0 {
        Some("detail_backfill_unavailable")
    } else {
        scan_partial.then_some("source_history_partial")
    };
    let (token_state, token_detail) = if summary.requests == 0 {
        (CapabilityState::Unknown, Some("no_request_evidence"))
    } else if summary.unbackfilled_requests > 0 {
        (CapabilityState::Partial, Some("detail_backfill_unavailable"))
    } else if scan_partial || summary.incomplete_tokens > 0 {
        (CapabilityState::Partial, Some("token_fields_partial"))
    } else {
        (CapabilityState::Complete, None)
    };
    let pricing_detail = if summary.requests == 0 {
        "no_request_evidence"
    } else if summary.with_pricing == 0 {
        "pricing_not_recorded"
    } else {
        "pricing_fields_partial"
    };
    let (agent_state, agent_detail) = if !include_subagents {
        (CapabilityState::DisabledBySetting, Some("subagents_disabled"))
    } else if summary.requests == 0 {
        (CapabilityState::Unknown, Some("no_request_evidence"))
    } else if scan_partial || summary.with_agent < summary.requests || summary.unknown_agent > 0 {
        (CapabilityState::Partial, Some("agent_attribution_partial"))
    } else {
        (CapabilityState::Complete, None)
    };
    let (project_state, project_detail) = if project_attribution == ProjectAttributionSetting::Off {
        (CapabilityState::DisabledBySetting, Some("project_attribution_off"))
    } else if summary.requests == 0 {
        (CapabilityState::Unknown, Some("no_request_evidence"))
    } else if summary.unbackfilled_requests > 0 {
        (CapabilityState::Partial, Some("detail_backfill_unavailable"))
    } else if scan_partial || summary.unknown_project > 0 {
        (CapabilityState::Partial, Some("project_attribution_partial"))
    } else {
        (CapabilityState::Complete, None)
    };
    let (tool_state, tool_detail) = if detail_level != DetailLevel::RequestsWithTools {
        (CapabilityState::DisabledBySetting, Some("detail_level_without_tools"))
    } else if tools.unmapped_forms {
        (CapabilityState::Partial, Some("unmapped_tool_forms"))
    } else if tools.truncated_names {
        (CapabilityState::Partial, Some("tool_names_truncated"))
    } else if scan_partial {
        (CapabilityState::Partial, Some("source_history_partial"))
    } else {
        (CapabilityState::Complete, None)
    };
    let (resource_state, resource_detail) = if detail_level != DetailLevel::RequestsWithTools {
        (CapabilityState::DisabledBySetting, Some("detail_level"))
    } else if resources.denied {
        (CapabilityState::DisabledBySetting, Some("denied_locally"))
    } else if !resources.configured {
        (CapabilityState::DisabledBySetting, Some("no_resources_configured"))
    } else if resources.inspections.unsupported > 0 {
        (CapabilityState::Partial, Some("unsupported_forms"))
    } else if resources.inspections.unresolved > 0 {
        (CapabilityState::Partial, Some("unresolved_paths"))
    } else if resources.inspections.ambiguous > 0 {
        (CapabilityState::Partial, Some("ambiguous_connectors"))
    } else if scan_partial {
        (CapabilityState::Partial, Some("scan_partial"))
    } else {
        (CapabilityState::Complete, None)
    };
    let mut rows = vec![
        capability(CapabilityDimension::Requests, request_state, request_detail),
        capability(CapabilityDimension::TokenComposition, token_state, token_detail),
        capability(
            CapabilityDimension::Pricing,
            if summary.requests == 0 { CapabilityState::Unknown } else { CapabilityState::Partial },
            Some(pricing_detail),
        ),
        capability(CapabilityDimension::Project, project_state, project_detail),
        capability(CapabilityDimension::Agent, agent_state, agent_detail),
        capability(CapabilityDimension::Tool, tool_state, tool_detail),
        capability(CapabilityDimension::Resource, resource_state, resource_detail),
    ];
    rows.extend(allowance);
    rows
}

/// Retained state can contain child requests collected while subagents were
/// enabled. Turning the setting off suppresses identities that are known to be
/// children while preserving requests whose agent identity is genuinely
/// unknown.
pub fn request_matches_agent_setting(event: &EventRow, include_subagents: bool) -> bool {
    include_subagents
        || (event.parent_session.is_none()
            && (!event.agent_observed
                || !is_known_child_fields(
                    &event.agent_class,
                    event.agent_key.as_deref(),
                    event.parent_agent_key.as_deref(),
                    event.agent_depth,
                )))
}

/// Builds the request record for one saved event; `None` when a stored value is
/// outside the contract.
#[allow(clippy::too_many_arguments)]
pub fn request_from_event(
    binding: &Uuid,
    adapter: Adapter,
    parser_version: &str,
    detail_level: DetailLevel,
    project_attribution: ProjectAttributionSetting,
    tool_detail: ToolDetail,
    include_subagents: bool,
    tools: &ToolIndex<'_>,
    event: &EventRow,
) -> Option<Record> {
    let counter = |value: i64| Counter::new(u64::try_from(value).ok()?).ok();
    let counter_option = |value: Option<i64>| value.and_then(counter);
    let ended_at = Stamp::parse(&event.timestamp).ok();
    let observed_at = ended_at.clone().or_else(|| Stamp::parse(&event.hour).ok())?;
    let session_identity = match event.session_identity.as_str() {
        "provider" => SessionIdentity::Provider,
        "derived" => SessionIdentity::Derived,
        _ => SessionIdentity::Synthetic,
    };
    // An event saved before the surface was recorded is a CLI event, as v1 assumed.
    let surface =
        event.surface.as_deref().and_then(|text| text.parse::<Surface>().ok()).unwrap_or(Surface::Cli);
    let project = match project_attribution {
        ProjectAttributionSetting::Hashed => {
            let parsed_basis = event.project_basis.parse::<ProjectBasis>().unwrap_or(ProjectBasis::Unknown);
            let key = event.project_key.clone().and_then(|value| Sha256Hex::try_from(value).ok());
            let basis = match (parsed_basis, key.is_some()) {
                (ProjectBasis::Native, true) => ProjectBasis::Native,
                (ProjectBasis::WorkingDirectory, true) => ProjectBasis::WorkingDirectory,
                (ProjectBasis::None, false) => ProjectBasis::None,
                _ => ProjectBasis::Unknown,
            };
            let key = if matches!(basis, ProjectBasis::Native | ProjectBasis::WorkingDirectory) {
                key
            } else {
                None
            };
            Some(ProjectAttribution { key: Nullable(key), basis })
        }
        ProjectAttributionSetting::Off => None,
    };
    let project_hash = project.as_ref().and_then(|value| {
        (value.basis == ProjectBasis::WorkingDirectory).then(|| value.key.as_ref().cloned()).flatten()
    });
    let detail = if event.detail_observed {
        [
            event.detail_input_fresh,
            event.detail_input_cached,
            event.detail_input_cache_write,
            event.detail_output,
        ]
    } else {
        // A migrated row whose retained source is no longer eligible for replay
        // keeps the v2 interpretation instead of losing previously published detail.
        [
            Some(event.input_tokens),
            Some(event.cached_tokens),
            Some(event.cache_write_tokens),
            Some(event.output_tokens),
        ]
    };
    let counters = detail.map(counter_option);
    let reasoning = counter_option(event.detail_reasoning);
    let reported_total = counter_option(event.reported_total);
    let known_values: Vec<u64> =
        counters.iter().filter_map(|value| value.as_ref().map(|value| value.get())).collect();
    let known_sum = known_values.iter().copied().sum::<u64>();
    let all_known = known_values.len() == 4;
    let minimum_total =
        known_sum + if counters[3].is_none() { reasoning.as_ref().map_or(0, |value| value.get()) } else { 0 };
    let token_accounting = event.detail_observed.then(|| {
        let reported = reported_total.as_ref().map(|value| value.get());
        let composition_state = if reported.is_some_and(|total| minimum_total > total) {
            CompositionState::Inconsistent
        } else if all_known {
            CompositionState::Complete
        } else if known_values.is_empty() && reasoning.is_none() && reported.is_none() {
            CompositionState::Unknown
        } else {
            CompositionState::Partial
        };
        let unclassified = reported
            .filter(|_| composition_state != CompositionState::Inconsistent)
            .and_then(|total| Counter::new(total - known_sum).ok());
        TokenAccounting {
            reported_total: Nullable(reported_total),
            unclassified: Nullable(unclassified),
            composition_state,
        }
    });
    let pricing = PricingEvidence {
        reasoning_effort: Nullable(
            event.reasoning_effort.clone().and_then(|value| Code::try_from(value).ok()),
        ),
        service_tier: Nullable(event.service_tier.clone().and_then(|value| Code::try_from(value).ok())),
        speed: Nullable(event.speed.clone().and_then(|value| Code::try_from(value).ok())),
        context_window_tokens: Nullable(counter_option(event.context_window_tokens)),
        cache_write_ttl: Nullable(event.cache_write_ttl.clone().and_then(|value| Code::try_from(value).ok())),
    };
    let pricing = pricing.has_evidence().then_some(pricing);
    let model_actual = if event.model.trim().is_empty() || event.model == "unknown" {
        None
    } else {
        Text::try_from(event.model.clone()).ok()
    };
    let outcome = event
        .outcome
        .as_deref()
        .and_then(|value| value.parse::<RequestOutcome>().ok())
        .unwrap_or(RequestOutcome::Unknown);
    let agent = if event.agent_observed {
        agent_attribution(
            event.agent_key.as_deref(),
            &event.agent_identity_basis,
            event.parent_agent_key.as_deref(),
            &event.parent_agent_identity_basis,
            &event.agent_class,
            event.agent_name.as_deref(),
            event.agent_depth,
            tool_detail,
        )
    } else {
        None
    };
    let (tool_calls, tools) = if detail_level == DetailLevel::RequestsWithTools {
        tools.request_summary(&event.id, include_subagents, tool_detail)
    } else {
        (Nullable::NULL, None)
    };
    Some(Record::ActivityRequest(ActivityRequest {
        record_id: record_id(binding, Channel::LocalFile, &format!("{}:{}", event.product, event.id)),
        binding_id: binding.clone(),
        adapter,
        channel: Channel::LocalFile,
        observed_at,
        basis: Basis::Exact,
        parser_version: Text::truncated(parser_version).ok()?,
        semantic_key: Sha256Hex::try_from(event.id.clone()).ok()?,
        product: Code::try_from(event.product.clone()).ok()?,
        surface,
        execution_host: ExecutionHost::Local,
        session_hash: Sha256Hex::try_from(event.session.clone()).ok()?,
        session_identity,
        parent_session_hash: Nullable(event.parent_session.clone().and_then(|p| Sha256Hex::try_from(p).ok())),
        model_requested: Nullable(event.model_requested.clone().and_then(|value| Text::try_from(value).ok())),
        model_actual: Nullable(model_actual),
        started_at: Nullable::NULL,
        ended_at: Nullable(ended_at),
        tokens: Tokens {
            input_fresh: Nullable(counters[0]),
            input_cached: Nullable(counters[1]),
            input_cache_write: Nullable(counters[2]),
            output: Nullable(counters[3]),
            reasoning: Nullable(reasoning),
        },
        token_accounting,
        pricing,
        tool_calls,
        tools,
        project_hash: Nullable(project_hash),
        project,
        agent,
        client_version: Nullable(event.client_version.clone().and_then(|v| Text::truncated(&v).ok())),
        latency_ms: Nullable::NULL,
        outcome,
    }))
}
