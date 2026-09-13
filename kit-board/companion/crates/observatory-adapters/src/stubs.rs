//! Adapters whose provider fixtures do not exist yet (section 0, feasibility
//! checks). Each reports its prerequisites honestly in `preflight` and, when
//! asked to collect, reports coverage `failed` with `unrecognized_payload` at
//! parser version `0`. None of them makes a network request, spawns a process,
//! or reads a credential.

use observatory_contract::{Adapter as AdapterId, CoverageState, DetailCode, Provider};
use observatory_core::adapter::{Adapter, AdapterError, Cursor, Outcome, Preflight, RunContext, Sink};
use observatory_core::config::Secrets;
use observatory_core::credentials::{CredentialPresence, claude_credential_presence};
use observatory_core::discovery::find_executable;

const STUB_PARSER_VERSION: &str = "0";

// Prerequisites are checked first so `doctor` names what is missing; when everything is
// present the stub reports `not_implemented` rather than running and failing.
fn blocked(state: CoverageState, detail: DetailCode) -> Preflight {
    Preflight::Blocked { state, detail }
}

fn not_recognized() -> Result<Outcome, AdapterError> {
    Err(AdapterError::Unrecognized)
}

/// `claude_account`: Claude's private OAuth usage interface. Phase 2.
#[derive(Debug, Default)]
pub struct ClaudeAccount;

impl Adapter for ClaudeAccount {
    fn id(&self) -> AdapterId {
        AdapterId::ClaudeAccount
    }
    fn parser_version(&self) -> &'static str {
        STUB_PARSER_VERSION
    }
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        if !ctx.bindings_for(Provider::Claude).any(|binding| binding.runnable()) {
            return blocked(CoverageState::PrerequisiteMissing, DetailCode::NoBinding);
        }
        match claude_credential_presence() {
            CredentialPresence::Present { .. } => {
                blocked(CoverageState::PrerequisiteMissing, DetailCode::NotImplemented)
            }
            CredentialPresence::Expired => {
                blocked(CoverageState::CredentialUnavailable, DetailCode::CredentialExpired)
            }
            CredentialPresence::Missing => {
                blocked(CoverageState::CredentialUnavailable, DetailCode::CredentialMissing)
            }
            CredentialPresence::Unknown => {
                blocked(CoverageState::CredentialUnavailable, DetailCode::CredentialMissing)
            }
        }
    }
    fn collect(
        &self,
        _ctx: &RunContext,
        _cursor: Option<Cursor>,
        _sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError> {
        not_recognized()
    }
}

/// `codex_account`: the Codex app-server protocol client. Phase 2.
#[derive(Debug, Default)]
pub struct CodexAccount;

impl Adapter for CodexAccount {
    fn id(&self) -> AdapterId {
        AdapterId::CodexAccount
    }
    fn parser_version(&self) -> &'static str {
        STUB_PARSER_VERSION
    }
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        if !ctx.bindings_for(Provider::Codex).any(|binding| binding.runnable()) {
            return blocked(CoverageState::PrerequisiteMissing, DetailCode::NoBinding);
        }
        if find_executable("codex").is_none() {
            return blocked(CoverageState::PrerequisiteMissing, DetailCode::ExecutableMissing);
        }
        blocked(CoverageState::PrerequisiteMissing, DetailCode::NotImplemented)
    }
    fn collect(
        &self,
        _ctx: &RunContext,
        _cursor: Option<Cursor>,
        _sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError> {
        not_recognized()
    }
}

/// `cursor_execution`: Cursor's local conversation state. Phase 3.
#[derive(Debug, Default)]
pub struct CursorExecution;

impl Adapter for CursorExecution {
    fn id(&self) -> AdapterId {
        AdapterId::CursorExecution
    }
    fn parser_version(&self) -> &'static str {
        STUB_PARSER_VERSION
    }
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        let present = ctx
            .bindings_for(Provider::Cursor)
            .filter(|binding| binding.runnable())
            .any(|binding| binding.cursor_state_db.as_ref().is_some_and(|path| path.is_file()));
        if present {
            blocked(CoverageState::PrerequisiteMissing, DetailCode::NotImplemented)
        } else {
            blocked(CoverageState::PrerequisiteMissing, DetailCode::StoreMissing)
        }
    }
    fn collect(
        &self,
        _ctx: &RunContext,
        _cursor: Option<Cursor>,
        _sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError> {
        not_recognized()
    }
}

/// `cursor_account`: Cursor's private usage summary and events. Phase 3.
#[derive(Debug, Default)]
pub struct CursorAccount;

impl Adapter for CursorAccount {
    fn id(&self) -> AdapterId {
        AdapterId::CursorAccount
    }
    fn parser_version(&self) -> &'static str {
        STUB_PARSER_VERSION
    }
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        let present = ctx
            .bindings_for(Provider::Cursor)
            .filter(|binding| binding.runnable())
            .any(|binding| binding.cursor_state_db.as_ref().is_some_and(|path| path.is_file()));
        if present {
            blocked(CoverageState::PrerequisiteMissing, DetailCode::NotImplemented)
        } else {
            blocked(CoverageState::CredentialUnavailable, DetailCode::CredentialMissing)
        }
    }
    fn collect(
        &self,
        _ctx: &RunContext,
        _cursor: Option<Cursor>,
        _sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError> {
        not_recognized()
    }
}

fn secrets_present(ctx: &RunContext, anthropic: bool) -> Preflight {
    match Secrets::load(ctx.secrets_dir()) {
        Ok(Some(secrets)) => {
            let key = if anthropic {
                secrets.anthropic_admin_key.as_ref()
            } else {
                secrets.openai_admin_key.as_ref()
            };
            if key.is_some_and(|k| !k.is_empty()) {
                blocked(CoverageState::PrerequisiteMissing, DetailCode::NotImplemented)
            } else {
                blocked(CoverageState::CredentialUnavailable, DetailCode::CredentialMissing)
            }
        }
        Ok(None) => blocked(CoverageState::CredentialUnavailable, DetailCode::CredentialMissing),
        Err(_) => blocked(CoverageState::Failed, DetailCode::IoError),
    }
}

/// `anthropic_api`: the Anthropic Admin usage and cost reports. Phase 5.
#[derive(Debug, Default)]
pub struct AnthropicApi;

impl Adapter for AnthropicApi {
    fn id(&self) -> AdapterId {
        AdapterId::AnthropicApi
    }
    fn parser_version(&self) -> &'static str {
        STUB_PARSER_VERSION
    }
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        if !ctx.bindings_for(Provider::AnthropicApi).any(|binding| binding.runnable()) {
            return blocked(CoverageState::PrerequisiteMissing, DetailCode::NoBinding);
        }
        secrets_present(ctx, true)
    }
    fn collect(
        &self,
        _ctx: &RunContext,
        _cursor: Option<Cursor>,
        _sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError> {
        not_recognized()
    }
}

/// `openai_api`: the OpenAI Admin usage and cost reports. Phase 5.
#[derive(Debug, Default)]
pub struct OpenaiApi;

impl Adapter for OpenaiApi {
    fn id(&self) -> AdapterId {
        AdapterId::OpenaiApi
    }
    fn parser_version(&self) -> &'static str {
        STUB_PARSER_VERSION
    }
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        if !ctx.bindings_for(Provider::OpenaiApi).any(|binding| binding.runnable()) {
            return blocked(CoverageState::PrerequisiteMissing, DetailCode::NoBinding);
        }
        secrets_present(ctx, false)
    }
    fn collect(
        &self,
        _ctx: &RunContext,
        _cursor: Option<Cursor>,
        _sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError> {
        not_recognized()
    }
}
