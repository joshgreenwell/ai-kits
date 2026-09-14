//! `activity.request` records from saved events, emitted when `detail_level`
//! is `requests` or `requests_with_tools`. Tool detail arrives in phase 4; until
//! then `tool_calls` is `null` and `tools` is absent. `project_hash` is filled
//! only when `project_attribution` is `hashed`; the hash is of the working
//! directory alone (`jsonl::project_hash`) and the path stays on this machine.

use observatory_contract::settings::{DetailLevel, ProjectAttribution};
use observatory_contract::{
    ActivityRequest, Adapter, Basis, CapabilityCoverage, CapabilityDimension, CapabilityState, Channel, Code,
    CompositionState, Counter, ExecutionHost, Nullable, PricingEvidence, Record, RequestOutcome,
    SessionIdentity, Sha256Hex, Stamp, Surface, Text, TokenAccounting, Tokens, Uuid,
};
use observatory_core::adapter::record_id;
use observatory_core::state::EventRow;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EvidenceSummary {
    pub requests: u64,
    pub incomplete_tokens: u64,
    pub unbackfilled_requests: u64,
    pub with_pricing: u64,
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
pub fn execution_capabilities(
    detail_level: DetailLevel,
    scan_partial: bool,
    summary: EvidenceSummary,
) -> Vec<CapabilityCoverage> {
    if detail_level == DetailLevel::BucketsOnly {
        return [
            CapabilityDimension::Requests,
            CapabilityDimension::TokenComposition,
            CapabilityDimension::Pricing,
        ]
        .into_iter()
        .map(|dimension| {
            capability(dimension, CapabilityState::DisabledBySetting, Some("detail_level_buckets_only"))
        })
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
    vec![
        capability(CapabilityDimension::Requests, request_state, request_detail),
        capability(CapabilityDimension::TokenComposition, token_state, token_detail),
        capability(
            CapabilityDimension::Pricing,
            if summary.requests == 0 { CapabilityState::Unknown } else { CapabilityState::Partial },
            Some(pricing_detail),
        ),
    ]
}

/// Builds the request record for one saved event; `None` when a stored value is
/// outside the contract.
pub fn request_from_event(
    binding: &Uuid,
    adapter: Adapter,
    parser_version: &str,
    project_attribution: ProjectAttribution,
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
    let project_hash = match project_attribution {
        ProjectAttribution::Hashed => {
            event.project_hash.clone().and_then(|hash| Sha256Hex::try_from(hash).ok())
        }
        ProjectAttribution::Off => None,
    };
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
        tool_calls: Nullable::NULL,
        tools: None,
        project_hash: Nullable(project_hash),
        project: None,
        agent: None,
        client_version: Nullable(event.client_version.clone().and_then(|v| Text::truncated(&v).ok())),
        latency_ms: Nullable::NULL,
        outcome,
    }))
}
