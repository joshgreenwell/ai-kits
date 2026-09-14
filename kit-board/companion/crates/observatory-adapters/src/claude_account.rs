//! `claude_account`: the Claude allowance meter. In mode `statusline` (the
//! default) it ingests the Claude Code statusline inbox, binds each sample to
//! the binding whose confirmed identity the hook stamped on it, quarantines what
//! cannot be bound safely, releases what a later run can bind, and emits
//! `allowance.reading` records with reader `statusline` (meter keys `five_hour`,
//! `seven_day`, and every model-scoped `seven_day_<model>`). The `allowance`
//! capability row reports the reader's health. Mode `oauth_usage` (the private
//! OAuth usage interface) is not implemented; the adapter then does the same
//! statusline work as the documented fallback and reports `not_implemented`,
//! unless the local deny list names the statusline reader, which keeps the
//! fallback off too. The inbox itself is pruned by the run, not here.

use observatory_contract::settings::ClaudeReader;
use observatory_contract::{
    Adapter as AdapterId, Channel, CoverageState, CursorState, DetailCode, Provider, Reader,
};
use observatory_core::adapter::{
    Adapter, AdapterError, BindingContext, Cursor, Outcome, Preflight, RunContext, Sink,
};
use observatory_core::inbox::{read_statusline_status, statusline_reader_denied};
use observatory_core::pyjson::epoch_text;

use crate::readings::{
    ClaudeAllowanceEvidence, claude_allowance_capability, denied_allowance_capability, emit_dirty_slots,
    hook_status, ingest_statusline_inbox, prune_quarantine, release_quarantined,
};

/// The statusline reader's parser version: the companion version plus the
/// inbox format generation (part files with an identity stamp).
pub const PARSER_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+statusline1");

#[derive(Debug, Default)]
pub struct ClaudeAccount;

impl Adapter for ClaudeAccount {
    fn id(&self) -> AdapterId {
        AdapterId::ClaudeAccount
    }

    fn parser_version(&self) -> &'static str {
        PARSER_VERSION
    }

    /// Identity is decided per sample, so any enabled Claude binding is enough.
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        if ctx.bindings_for(Provider::Claude).any(|binding| binding.enabled) {
            Preflight::Ready
        } else {
            Preflight::Blocked { state: CoverageState::PrerequisiteMissing, detail: DetailCode::NoBinding }
        }
    }

    fn collect(
        &self,
        ctx: &RunContext,
        _cursor: Option<Cursor>,
        sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError> {
        // Under `oauth_usage` the effective gate names the OAuth reader, so a local deny of
        // the statusline reader reaches only this far: the fallback then reads nothing.
        if ctx.settings.allowance.claude_reader == ClaudeReader::OauthUsage
            && statusline_reader_denied(&ctx.deny)
        {
            let mut outcome = Outcome::ok();
            outcome.state = CoverageState::DeniedLocally;
            outcome.detail = Some(DetailCode::Denied);
            outcome.stores_discovered = u64::from(ctx.statusline_inbox.is_dir());
            outcome.cursor_state = CursorState::Complete;
            outcome.capabilities = Some(vec![denied_allowance_capability()]);
            return Ok(outcome);
        }
        let state = ctx.open_state()?;
        let bindings: Vec<&BindingContext> = ctx.bindings_for(Provider::Claude).collect();
        let ingest = ingest_statusline_inbox(&state, ctx, &bindings)?;
        let released = release_quarantined(&state, &bindings)?;
        prune_quarantine(&state, ctx, &bindings)?;
        let held = state.quarantine_counts()?;

        let mut outcome = Outcome::ok();
        outcome.stores_discovered = u64::from(ctx.statusline_inbox.is_dir());
        outcome.files = ingest.files;
        outcome.bytes_read = ingest.bytes_read;
        outcome.malformed = ingest.malformed;
        outcome.cursor_state = CursorState::Complete;
        // A binding in conflict keeps its slots dirty until the conflict clears;
        // one merely `Changed` by a switched account still publishes its own readings.
        let mut newest_bound: Option<String> = None;
        for binding in bindings.iter().filter(|binding| binding.enabled && !binding.identity_conflict) {
            outcome.records_emitted += emit_dirty_slots(
                &state,
                binding,
                AdapterId::ClaudeAccount,
                Channel::HookSnapshot,
                Reader::Statusline,
                self.parser_version(),
                sink,
            )?;
            if let Some(observed) = state.newest_allowance_observed_at(binding.binding_id.as_str())?
                && newest_bound.as_deref().is_none_or(|newest| {
                    epoch_text(newest).unwrap_or(f64::MIN) < epoch_text(&observed).unwrap_or(f64::MIN)
                })
            {
                newest_bound = Some(observed);
            }
        }
        let sidecar = read_statusline_status(&ctx.statusline_inbox);
        let hook = hook_status(&ctx.claude_settings_path, &ctx.config_dir);
        outcome.capabilities = Some(vec![claude_allowance_capability(&ClaudeAllowanceEvidence {
            reader: ctx.settings.allowance.claude_reader,
            ingest: &ingest,
            released,
            held: &held,
            newest_bound: newest_bound.as_deref(),
            sidecar: sidecar.as_ref(),
            hook: &hook,
            now_seconds: ctx.now_seconds,
            cadence_minutes: ctx.settings.cadence_minutes.get(),
        })]);
        if ctx.settings.allowance.claude_reader == ClaudeReader::OauthUsage {
            outcome.state = CoverageState::Partial;
            outcome.detail = Some(DetailCode::NotImplemented);
        }
        Ok(outcome)
    }
}
