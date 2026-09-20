//! `claude_execution`: Claude Code transcripts under `~/.claude/projects` (or
//! configured roots) as hourly buckets and, at `requests` detail, request
//! records. The statusline inbox belongs to `claude_account`, which binds each
//! sample by the identity stamped on it.

use observatory_contract::{Adapter as AdapterId, CoverageState, CursorState, DetailCode, Provider};
use observatory_core::adapter::{Adapter, AdapterError, Cursor, Outcome, Preflight, RunContext, Sink};

use crate::emission::{Evidence, emit_detail};
use crate::jsonl::{expand_user, scan};
use crate::requests::{EvidenceSummary, ToolEvidenceSummary, execution_capabilities};
use crate::resources::ResourceEvidenceSummary;

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
            let emission = emit_detail(
                &state,
                ctx,
                binding,
                AdapterId::ClaudeExecution,
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
            None,
        ));
        Ok(outcome)
    }
}
