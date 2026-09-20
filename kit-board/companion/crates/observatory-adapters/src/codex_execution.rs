//! `codex_execution`: Codex CLI rollouts under `~/.codex/sessions` and
//! `~/.codex/archived_sessions` (or a configured home) as hourly buckets and, at
//! `requests` detail, request records; plus the embedded `rate_limits` of each
//! `token_count` as `allowance.reading` with reader `embedded` and meter key
//! `<limit_id>:<minutes>`. The `allowance` capability row reports the embedded
//! reader (a fallback while `web_backend` is selected, which is still unimplemented).

use observatory_contract::settings::CodexReader;
use observatory_contract::{
    Adapter as AdapterId, Channel, CoverageState, CursorState, DetailCode, Provider, Reader,
};
use observatory_core::adapter::{Adapter, AdapterError, Cursor, Outcome, Preflight, RunContext, Sink};

use crate::emission::{Evidence, emit_detail};
use crate::jsonl::{expand_user, scan};
use crate::readings::{codex_allowance_capability, emit_dirty_slots};
use crate::requests::{EvidenceSummary, ToolEvidenceSummary, execution_capabilities};
use crate::resources::ResourceEvidenceSummary;

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
        let mut resource_evidence = ResourceEvidenceSummary::for_run(ctx);
        let mut history_has_parse_gaps = false;
        let mut newest_embedded: Option<String> = None;
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
                if let Some(observed) = state.newest_allowance_observed_at(binding.binding_id.as_str())?
                    && newest_embedded.as_deref().is_none_or(|newest| newest < observed.as_str())
                {
                    newest_embedded = Some(observed);
                }
            }
            let emission = emit_detail(
                &state,
                ctx,
                binding,
                AdapterId::CodexExecution,
                self.parser_version(),
                Evidence {
                    requests: &mut evidence,
                    tools: &mut tool_evidence,
                    resources: &mut resource_evidence,
                },
                sink,
            )?;
            outcome.records_emitted += emission.records_emitted;
            outcome.after_persist.extend(emission.after_persist);
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
            Some(codex_allowance_capability(
                ctx.settings.allowance.codex_reader,
                newest_embedded.as_deref(),
                ctx.now_seconds,
                ctx.settings.cadence_minutes.get(),
            )),
        ));
        Ok(outcome)
    }
}
