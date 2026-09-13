//! `activity.request` records from saved events, emitted when `detail_level`
//! is `requests` or `requests_with_tools`. Tool detail arrives in phase 4; until
//! then `tool_calls` is `null` and `tools` is absent. `project_hash` is filled
//! only when `project_attribution` is `hashed`; the hash is of the working
//! directory alone (`jsonl::project_hash`) and the path stays on this machine.

use observatory_contract::settings::ProjectAttribution;
use observatory_contract::{
    ActivityRequest, Adapter, Basis, Channel, Code, Counter, ExecutionHost, Nullable, Record, RequestOutcome,
    SessionIdentity, Sha256Hex, Stamp, Surface, Text, Tokens, Uuid,
};
use observatory_core::adapter::record_id;
use observatory_core::state::EventRow;

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
        model_requested: Nullable::NULL,
        model_actual: Text::try_from(event.model.clone()).ok()?,
        started_at: Nullable::NULL,
        ended_at: Nullable(ended_at),
        tokens: Tokens {
            input_fresh: Nullable::some(counter(event.input_tokens)?),
            input_cached: Nullable::some(counter(event.cached_tokens)?),
            input_cache_write: Nullable::some(counter(event.cache_write_tokens)?),
            output: Nullable::some(counter(event.output_tokens)?),
            reasoning: Nullable::NULL,
        },
        tool_calls: Nullable::NULL,
        tools: None,
        project_hash: Nullable(project_hash),
        client_version: Nullable(event.client_version.clone().and_then(|v| Text::truncated(&v).ok())),
        latency_ms: Nullable::NULL,
        outcome: RequestOutcome::Completed,
    }))
}
