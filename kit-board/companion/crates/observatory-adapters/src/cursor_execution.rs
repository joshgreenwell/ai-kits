//! `cursor_execution`: local Cursor conversation token counters from `state.vscdb`.
//!
//! These are on-device counters, not billed usage. They become `activity.request`
//! rows on channel `local_db` when `detail_level` is not `buckets_only`. They
//! never produce hourly buckets and never invent a project from a timestamp.

use observatory_contract::settings::DetailLevel;
use observatory_contract::stable_json::stable_json;
use observatory_contract::{
    ActivityRequest, Adapter as AdapterId, Basis, CapabilityCoverage, CapabilityDimension, CapabilityState,
    Channel, Code, CoverageState, CursorState, DetailCode, ExecutionHost, Nullable, Provider, Record,
    RequestOutcome, SessionIdentity, Sha256Hex, Stamp, Surface, Text,
};
use observatory_core::adapter::{
    Adapter, AdapterError, Cursor, Outcome, Preflight, RunContext, Sink, record_id,
};
use observatory_core::cursor_store::{self, CursorComposerUsage};
use serde_json::json;

use crate::provider::{observed_now, parser_text, token_accounting, tokens_from_exclusive};

const PARSER_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+cursor-local1");

#[derive(Debug, Default)]
pub struct CursorExecution;

impl Adapter for CursorExecution {
    fn id(&self) -> AdapterId {
        AdapterId::CursorExecution
    }
    fn parser_version(&self) -> &'static str {
        PARSER_VERSION
    }
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        let present = ctx
            .bindings_for(Provider::Cursor)
            .filter(|binding| binding.runnable())
            .any(|binding| binding.cursor_state_db.as_ref().is_some_and(|path| path.is_file()));
        if present {
            Preflight::Ready
        } else {
            Preflight::Blocked { state: CoverageState::PrerequisiteMissing, detail: DetailCode::StoreMissing }
        }
    }
    fn collect(
        &self,
        ctx: &RunContext,
        _cursor: Option<Cursor>,
        sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError> {
        let mut outcome = Outcome::ok();
        outcome.cursor_state = CursorState::Complete;
        let emit_requests = ctx.settings.execution.detail_level != DetailLevel::BucketsOnly;
        let mut requests = 0u64;
        let mut incomplete = 0u64;
        for binding in ctx.bindings_for(Provider::Cursor).filter(|binding| binding.runnable()) {
            let Some(path) = binding.cursor_state_db.as_ref().filter(|path| path.is_file()) else { continue };
            outcome.stores_discovered += 1;
            let (bytes, rows) = cursor_store::cursor_local_usage(path).map_err(|_| AdapterError::Io)?;
            outcome.bytes_read += bytes;
            outcome.files += 1;
            for row in rows {
                if !eligible(&row, ctx.since) {
                    continue;
                }
                if !emit_requests {
                    continue;
                }
                match request_record(&binding.binding_id, &row, &observed_now(ctx)) {
                    Some(record) => {
                        if incomplete_tokens(&row) {
                            incomplete += 1;
                        }
                        sink.emit(record, None);
                        outcome.records_emitted += 1;
                        requests += 1;
                    }
                    None => outcome.malformed += 1,
                }
            }
        }
        outcome.capabilities =
            Some(cursor_capabilities(ctx.settings.execution.detail_level, requests, incomplete));
        if outcome.stores_discovered == 0 {
            outcome.state = CoverageState::PrerequisiteMissing;
            outcome.detail = Some(DetailCode::StoreMissing);
        }
        Ok(outcome)
    }
}

fn eligible(row: &CursorComposerUsage, since: f64) -> bool {
    match row.created_at_ms {
        Some(ms) => (ms as f64) / 1000.0 >= since,
        None => true,
    }
}

fn incomplete_tokens(row: &CursorComposerUsage) -> bool {
    row.input_tokens.is_none()
        || row.output_tokens.is_none()
        || (row.bubble_id.is_none() && row.cache_read_tokens.is_none() && row.cache_write_tokens.is_none())
}

fn as_u64(value: Option<i64>) -> Option<u64> {
    value.and_then(|n| u64::try_from(n).ok())
}

fn request_record(
    binding: &observatory_contract::Uuid,
    row: &CursorComposerUsage,
    fallback: &Stamp,
) -> Option<Record> {
    let observed_at =
        row.created_at_ms.and_then(|ms| Stamp::from_millis(ms).ok()).unwrap_or_else(|| fallback.clone());
    let bubble = row.bubble_id.as_deref().unwrap_or("");
    let semantic =
        Sha256Hex::digest(stable_json(&json!(["cursor", row.composer_id.as_str(), bubble])).as_bytes());
    let session =
        Sha256Hex::digest(stable_json(&json!(["cursor_session", row.composer_id.as_str()])).as_bytes());
    let input = as_u64(row.input_tokens);
    let cached = as_u64(row.cache_read_tokens);
    let cache_write = as_u64(row.cache_write_tokens);
    let output = as_u64(row.output_tokens);
    let accounting = token_accounting(input, cached, cache_write, output, None);
    let model = row.model.as_deref().and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed == "unknown" {
            None
        } else {
            Text::try_from(trimmed.to_owned()).ok()
        }
    });
    Some(Record::ActivityRequest(ActivityRequest {
        record_id: record_id(binding, Channel::LocalDb, &format!("cursor:{}:{}", row.composer_id, bubble)),
        binding_id: binding.clone(),
        adapter: AdapterId::CursorExecution,
        channel: Channel::LocalDb,
        observed_at: observed_at.clone(),
        basis: Basis::Reported,
        parser_version: parser_text(PARSER_VERSION)?,
        semantic_key: semantic,
        product: Code::try_from("cursor_ide".to_owned()).ok()?,
        surface: Surface::Ide,
        execution_host: ExecutionHost::Local,
        session_hash: session,
        session_identity: SessionIdentity::Derived,
        parent_session_hash: Nullable::NULL,
        model_requested: Nullable::NULL,
        model_actual: Nullable(model),
        started_at: Nullable::NULL,
        ended_at: Nullable::some(observed_at),
        tokens: tokens_from_exclusive(input, cached, cache_write, output),
        token_accounting: accounting,
        pricing: None,
        tool_calls: Nullable::NULL,
        tools: None,
        project_hash: Nullable::NULL,
        project: None,
        agent: None,
        client_version: Nullable::NULL,
        latency_ms: Nullable::NULL,
        outcome: RequestOutcome::Unknown,
    }))
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

fn cursor_capabilities(
    detail_level: DetailLevel,
    requests: u64,
    _incomplete: u64,
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
        .collect();
    }
    let request_state = if requests == 0 { CapabilityState::Unknown } else { CapabilityState::Complete };
    // Local counters are never billed totals, so composition is partial whenever any request exists,
    // whether or not some of them were incomplete.
    let token_state = if requests == 0 { CapabilityState::Unknown } else { CapabilityState::Partial };
    vec![
        capability(
            CapabilityDimension::Requests,
            request_state,
            (requests == 0).then_some("no_request_evidence"),
        ),
        capability(CapabilityDimension::TokenComposition, token_state, Some("local_counters_not_billed")),
        capability(CapabilityDimension::Pricing, CapabilityState::Unsupported, Some("not_in_local_state")),
        capability(
            CapabilityDimension::Project,
            CapabilityState::Unsupported,
            Some("timestamp_join_not_supported"),
        ),
        capability(CapabilityDimension::Agent, CapabilityState::Unsupported, Some("not_in_local_state")),
        capability(CapabilityDimension::Tool, CapabilityState::Unsupported, Some("not_in_local_state")),
        capability(CapabilityDimension::Resource, CapabilityState::Unsupported, Some("not_in_local_state")),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use observatory_core::cursor_store::CursorComposerUsage;

    #[test]
    fn local_counters_become_requests_never_buckets() {
        let row = CursorComposerUsage {
            composer_id: "comp-1".into(),
            bubble_id: Some("bubble-1".into()),
            input_tokens: Some(12),
            output_tokens: Some(4),
            cache_read_tokens: Some(3),
            cache_write_tokens: Some(1),
            created_at_ms: Some(1_725_000_000_000),
            model: Some("composer-1".into()),
        };
        let record = request_record(
            &crate::provider::zero_uuid(),
            &row,
            &Stamp::parse("2026-09-01T00:00:00.000Z").unwrap(),
        )
        .unwrap();
        let Record::ActivityRequest(request) = record else { panic!("request") };
        assert_eq!(request.channel, Channel::LocalDb);
        assert_eq!(request.product.as_str(), "cursor_ide");
        assert_eq!(request.tokens.input_fresh.as_ref().map(|v| v.get()), Some(12));
        assert_eq!(request.tokens.input_cached.as_ref().map(|v| v.get()), Some(3));
        assert!(request.project.is_none());
    }
}
