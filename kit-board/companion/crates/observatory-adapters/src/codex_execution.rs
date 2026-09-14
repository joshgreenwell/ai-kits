//! `codex_execution`: Codex CLI rollouts under `~/.codex/sessions` and
//! `~/.codex/archived_sessions` (or a configured home) as hourly buckets and, at
//! `requests` detail, request records; plus the embedded `rate_limits` of each
//! `token_count` as `allowance.reading` with reader `embedded` and meter key
//! `<limit_id>:<minutes>`.

use observatory_contract::settings::{CodexReader, DetailLevel};
use observatory_contract::{
    Adapter as AdapterId, Channel, CoverageState, CursorState, DetailCode, Provider, Reader,
};
use observatory_core::adapter::{Adapter, AdapterError, Cursor, Outcome, Preflight, RunContext, Sink};

use crate::agents::record_from_event as agent_record_from_event;
use crate::jsonl::{expand_user, scan};
use crate::readings::emit_dirty_slots;
use crate::requests::{
    EvidenceSummary, ToolEvidenceSummary, execution_capabilities, request_from_event,
    request_matches_agent_setting,
};
use crate::tools::{
    matches_agent_setting as tool_matches_agent_setting, record_from_event as tool_record_from_event,
};

#[derive(Debug, Default)]
pub struct CodexExecution;

impl Adapter for CodexExecution {
    fn id(&self) -> AdapterId {
        AdapterId::CodexExecution
    }

    fn parser_version(&self) -> &'static str {
        crate::EXECUTION_PARSER_VERSION
    }

    fn preflight(&self, ctx: &RunContext) -> Preflight {
        let any_root = ctx
            .bindings_for(Provider::Codex)
            .filter(|binding| binding.runnable())
            .flat_map(|binding| binding.roots.iter())
            .any(|root| expand_user(root).is_dir());
        if any_root {
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
        let state = ctx.open_state()?;
        let mut outcome = Outcome::ok();
        let include_subagents = ctx.settings.execution.include_subagents;
        let project_attribution = ctx.effective_project_attribution();
        let emit_embedded = ctx.settings.allowance.codex_reader != CodexReader::Off;
        let mut evidence = EvidenceSummary::default();
        let mut tool_evidence = ToolEvidenceSummary::default();
        let mut history_has_parse_gaps = false;
        for binding in ctx.bindings_for(Provider::Codex).filter(|binding| binding.runnable()) {
            let metrics = scan(&state, ctx, binding, Provider::Codex, "codex_cli", include_subagents)?;
            outcome.files += metrics.files;
            outcome.bytes_read += metrics.bytes_read;
            outcome.malformed += metrics.malformed_lines;
            history_has_parse_gaps |= metrics.history_gap_files > 0;
            outcome.stores_discovered += metrics.stores_discovered;
            if metrics.unavailable_roots > 0 {
                outcome.state = CoverageState::Partial;
                outcome.detail = Some(DetailCode::UnavailableRoots);
            }
            if metrics.interrupted {
                outcome.state = CoverageState::Partial;
                outcome.detail = Some(DetailCode::PartialRead);
                outcome.cursor_state = CursorState::More;
            }
            if emit_embedded {
                outcome.records_emitted += emit_dirty_slots(
                    &state,
                    binding,
                    AdapterId::CodexExecution,
                    Channel::LocalFile,
                    Reader::Embedded,
                    self.parser_version(),
                    sink,
                )?;
            }
            if ctx.settings.execution.detail_level != DetailLevel::BucketsOnly {
                let tool_events = state.tool_events(binding.binding_id.as_str())?;
                tool_evidence.observe(&tool_events, state.tool_coverage(binding.binding_id.as_str())?);
                for event in state.request_events(binding.binding_id.as_str())? {
                    if !request_matches_agent_setting(&event, include_subagents) {
                        continue;
                    }
                    evidence.observe(&event);
                    if let Some(record) = request_from_event(
                        &binding.binding_id,
                        AdapterId::CodexExecution,
                        self.parser_version(),
                        ctx.settings.execution.detail_level,
                        project_attribution,
                        ctx.settings.execution.tool_detail,
                        include_subagents,
                        &tool_events,
                        &event,
                    ) {
                        sink.emit(record, None);
                        outcome.records_emitted += 1;
                    }
                }
                if include_subagents {
                    for event in state.agent_events(binding.binding_id.as_str())? {
                        if let Some(record) = agent_record_from_event(
                            &binding.binding_id,
                            AdapterId::CodexExecution,
                            self.parser_version(),
                            ctx.settings.execution.tool_detail,
                            &event,
                        ) {
                            sink.emit(record, None);
                            outcome.records_emitted += 1;
                        }
                    }
                }
                if ctx.settings.execution.detail_level == DetailLevel::RequestsWithTools {
                    for event in &tool_events {
                        if !tool_matches_agent_setting(event, include_subagents) {
                            continue;
                        }
                        if let Some(record) = tool_record_from_event(
                            &binding.binding_id,
                            AdapterId::CodexExecution,
                            self.parser_version(),
                            ctx.settings.execution.tool_detail,
                            event,
                        ) {
                            sink.emit(record, None);
                            outcome.records_emitted += 1;
                        }
                    }
                }
            }
        }
        if history_has_parse_gaps && outcome.state == CoverageState::Ok {
            outcome.state = CoverageState::Partial;
            outcome.detail = Some(DetailCode::ParseError);
        }
        let scan_partial =
            outcome.state != CoverageState::Ok || outcome.malformed > 0 || history_has_parse_gaps;
        outcome.capabilities = Some(execution_capabilities(
            ctx.settings.execution.detail_level,
            project_attribution,
            include_subagents,
            scan_partial,
            evidence,
            tool_evidence,
        ));
        Ok(outcome)
    }
}
