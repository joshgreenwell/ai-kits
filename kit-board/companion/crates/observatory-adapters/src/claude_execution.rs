//! `claude_execution`: Claude Code transcripts under `~/.claude/projects` (or
//! configured roots) as hourly buckets and, at `requests` detail, request
//! records; plus the statusline inbox as `allowance.reading` with reader
//! `statusline` and meter keys `five_hour` and `seven_day`.

use observatory_contract::settings::{ClaudeReader, DetailLevel};
use observatory_contract::{
    Adapter as AdapterId, Channel, CoverageState, CursorState, DetailCode, Provider, Reader,
};
use observatory_core::adapter::{Adapter, AdapterError, Cursor, Outcome, Preflight, RunContext, Sink};

use crate::agents::record_from_event as agent_record_from_event;
use crate::jsonl::{expand_user, scan};
use crate::readings::{emit_dirty_slots, ingest_statusline_inbox};
use crate::requests::{
    EvidenceSummary, ToolEvidenceSummary, execution_capabilities, request_from_event,
    request_matches_agent_setting,
};
use crate::resources::{ResourceEvidenceSummary, emit_records as emit_resource_records};
use crate::tools::{
    matches_agent_setting as tool_matches_agent_setting, record_from_event as tool_record_from_event,
};

#[derive(Debug, Default)]
pub struct ClaudeExecution;

impl Adapter for ClaudeExecution {
    fn id(&self) -> AdapterId {
        AdapterId::ClaudeExecution
    }

    fn parser_version(&self) -> &'static str {
        crate::EXECUTION_PARSER_VERSION
    }

    fn preflight(&self, ctx: &RunContext) -> Preflight {
        let any_root = ctx
            .bindings_for(Provider::Claude)
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
        let read_inbox = ctx.settings.allowance.claude_reader != ClaudeReader::Off;
        let mut inbox_bound = false;
        let mut evidence = EvidenceSummary::default();
        let mut tool_evidence = ToolEvidenceSummary::default();
        let mut resource_evidence = ResourceEvidenceSummary::for_run(ctx);
        let mut history_has_parse_gaps = false;
        for binding in ctx.bindings_for(Provider::Claude).filter(|binding| binding.runnable()) {
            let metrics = scan(&state, ctx, binding, Provider::Claude, "claude_code", include_subagents)?;
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
            // The statusline inbox is machine-wide; the first Claude binding owns it.
            if read_inbox && !inbox_bound {
                inbox_bound = true;
                outcome.malformed += ingest_statusline_inbox(&state, ctx, binding)?;
                outcome.records_emitted += emit_dirty_slots(
                    &state,
                    binding,
                    AdapterId::ClaudeExecution,
                    Channel::HookSnapshot,
                    Reader::Statusline,
                    self.parser_version(),
                    sink,
                )?;
            }
            if ctx.settings.execution.detail_level != DetailLevel::BucketsOnly {
                let tool_events = state.tool_events(binding.binding_id.as_str())?;
                tool_evidence.observe(&tool_events, state.tool_coverage(binding.binding_id.as_str())?);
                resource_evidence.observe(state.resource_inspection_counts(binding.binding_id.as_str())?);
                for event in state.request_events(binding.binding_id.as_str())? {
                    if !request_matches_agent_setting(&event, include_subagents) {
                        continue;
                    }
                    evidence.observe(&event);
                    if let Some(record) = request_from_event(
                        &binding.binding_id,
                        AdapterId::ClaudeExecution,
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
                            AdapterId::ClaudeExecution,
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
                            AdapterId::ClaudeExecution,
                            self.parser_version(),
                            ctx.settings.execution.tool_detail,
                            event,
                        ) {
                            sink.emit(record, None);
                            outcome.records_emitted += 1;
                        }
                    }
                    if ctx.effective_resource_attribution() {
                        outcome.records_emitted += emit_resource_records(
                            &state,
                            binding,
                            AdapterId::ClaudeExecution,
                            self.parser_version(),
                            include_subagents,
                            &tool_events,
                            sink,
                        )?;
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
            resource_evidence,
        ));
        Ok(outcome)
    }
}
