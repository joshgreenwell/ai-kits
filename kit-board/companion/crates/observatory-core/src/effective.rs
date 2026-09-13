//! The effective mode of every adapter, computed on every run (section 1.4):
//!
//! ```text
//! effective(adapter, mode) =
//!       server value (install override, else global default)
//!   AND adapter mode not in the local deny list
//!   AND binding enabled and identity unchanged
//!   AND prerequisite present (store, executable, credential, open tab)
//! ```
//!
//! The first three are decided here; the fourth is the adapter's `preflight`.
//! Every adapter reports its effective state in coverage, so "off" is always
//! distinguishable from "broken".

use observatory_contract::{Adapter, CollectionSettings, CoverageState, DetailCode};

use crate::adapter::{BindingContext, IdentityState};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Effective {
    pub adapter: Adapter,
    /// True when the adapter proceeds to `preflight` and `collect`.
    pub runs: bool,
    /// The coverage state to report when it does not run.
    pub state: CoverageState,
    pub detail: Option<DetailCode>,
    /// The dotted setting path a deny-list entry would match.
    pub mode_path: String,
}

impl Effective {
    fn blocked(adapter: Adapter, state: CoverageState, detail: DetailCode, mode_path: String) -> Self {
        Effective { adapter, runs: false, state, detail: Some(detail), mode_path }
    }

    /// A short human label for `status` and `doctor`.
    pub fn describe(&self) -> String {
        match (&self.state, &self.detail) {
            (state, Some(detail)) => format!("{state} ({detail})"),
            (state, None) => state.to_string(),
        }
    }
}

/// Decides whether an adapter runs before its prerequisites are checked.
pub fn effective(
    adapter: Adapter,
    settings: &CollectionSettings,
    deny: &[String],
    bindings: &[BindingContext],
) -> Effective {
    let gate = settings.gate(adapter);
    let mode_path = gate.mode_path.clone();
    if settings.paused {
        return Effective::blocked(adapter, CoverageState::DisabledBySetting, DetailCode::Paused, mode_path);
    }
    if !gate.provider_enabled {
        return Effective::blocked(
            adapter,
            CoverageState::DisabledBySetting,
            DetailCode::ProviderDisabled,
            mode_path,
        );
    }
    if !gate.enabled {
        return Effective::blocked(adapter, CoverageState::DisabledBySetting, DetailCode::ModeOff, mode_path);
    }
    if deny.iter().any(|entry| observatory_contract::settings::denied(entry, adapter, &gate)) {
        return Effective::blocked(adapter, CoverageState::DeniedLocally, DetailCode::Denied, mode_path);
    }
    let provider = adapter.provider();
    let mut for_provider = bindings.iter().filter(|binding| binding.provider == provider).peekable();
    if for_provider.peek().is_none() {
        return Effective::blocked(
            adapter,
            CoverageState::PrerequisiteMissing,
            DetailCode::NoBinding,
            mode_path,
        );
    }
    let bindings: Vec<&BindingContext> = for_provider.collect();
    if bindings.iter().all(|binding| !binding.enabled) {
        return Effective::blocked(
            adapter,
            CoverageState::DisabledBySetting,
            DetailCode::BindingDisabled,
            mode_path,
        );
    }
    if bindings
        .iter()
        .filter(|binding| binding.enabled)
        .all(|binding| binding.identity == IdentityState::Changed)
    {
        return Effective::blocked(
            adapter,
            CoverageState::IdentityChanged,
            DetailCode::IdentityChanged,
            mode_path,
        );
    }
    Effective { adapter, runs: true, state: CoverageState::Ok, detail: None, mode_path }
}

#[cfg(test)]
mod tests {
    use super::*;
    use observatory_contract::{AccountId, Provider, Uuid};
    use std::str::FromStr;

    fn binding(provider: Provider, enabled: bool, identity: IdentityState) -> BindingContext {
        BindingContext {
            binding_id: Uuid::v4(),
            account_id: AccountId::from_str("acct-1").unwrap(),
            provider,
            enabled,
            identity_hash: None,
            identity,
            roots: vec![],
            codex_home: None,
            cursor_state_db: None,
        }
    }

    #[test]
    fn precedence() {
        let settings = CollectionSettings::defaults();
        let claude = binding(Provider::Claude, true, IdentityState::Confirmed);
        let e = effective(Adapter::ClaudeExecution, &settings, &[], std::slice::from_ref(&claude));
        assert!(e.runs);

        let e = effective(
            Adapter::ClaudeExecution,
            &settings,
            &["providers.claude".into()],
            std::slice::from_ref(&claude),
        );
        assert_eq!((e.state, e.detail), (CoverageState::DeniedLocally, Some(DetailCode::Denied)));

        let e = effective(Adapter::CodexExecution, &settings, &[], std::slice::from_ref(&claude));
        assert_eq!((e.state, e.detail), (CoverageState::PrerequisiteMissing, Some(DetailCode::NoBinding)));

        let e = effective(Adapter::ClaudeAccount, &settings, &[], std::slice::from_ref(&claude));
        assert_eq!((e.state, e.detail), (CoverageState::DisabledBySetting, Some(DetailCode::ModeOff)));

        let e = effective(
            Adapter::CursorExecution,
            &settings,
            &[],
            &[binding(Provider::Cursor, true, IdentityState::Confirmed)],
        );
        assert_eq!(
            (e.state, e.detail),
            (CoverageState::DisabledBySetting, Some(DetailCode::ProviderDisabled))
        );

        let disabled = binding(Provider::Claude, false, IdentityState::Confirmed);
        let e = effective(Adapter::ClaudeExecution, &settings, &[], std::slice::from_ref(&disabled));
        assert_eq!(
            (e.state, e.detail),
            (CoverageState::DisabledBySetting, Some(DetailCode::BindingDisabled))
        );

        let changed = binding(Provider::Claude, true, IdentityState::Changed);
        let e = effective(Adapter::ClaudeExecution, &settings, &[], std::slice::from_ref(&changed));
        assert_eq!((e.state, e.detail), (CoverageState::IdentityChanged, Some(DetailCode::IdentityChanged)));

        let mut paused = CollectionSettings::defaults();
        paused.paused = true;
        let e = effective(Adapter::ClaudeExecution, &paused, &[], std::slice::from_ref(&claude));
        assert_eq!((e.state, e.detail), (CoverageState::DisabledBySetting, Some(DetailCode::Paused)));
    }
}
