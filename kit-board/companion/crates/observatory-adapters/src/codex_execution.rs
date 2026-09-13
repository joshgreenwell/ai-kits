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

use crate::jsonl::{expand_user, scan};
use crate::readings::emit_dirty_slots;
use crate::requests::request_from_event;

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
        let emit_embedded = ctx.settings.allowance.codex_reader != CodexReader::Off;
        for binding in ctx.bindings_for(Provider::Codex).filter(|binding| binding.runnable()) {
            let metrics = scan(&state, ctx, binding, Provider::Codex, "codex_cli", include_subagents)?;
            outcome.files += metrics.files;
            outcome.bytes_read += metrics.bytes_read;
            outcome.malformed += metrics.malformed_lines;
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
                for event in state.events(binding.binding_id.as_str())? {
                    if let Some(record) = request_from_event(
                        &binding.binding_id,
                        AdapterId::CodexExecution,
                        self.parser_version(),
                        ctx.settings.execution.project_attribution,
                        &event,
                    ) {
                        sink.emit(record, None);
                        outcome.records_emitted += 1;
                    }
                }
            }
        }
        Ok(outcome)
    }
}
