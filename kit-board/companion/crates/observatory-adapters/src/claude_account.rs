//! `claude_account`: the Claude allowance meter. In mode `statusline` (the
//! default) it ingests the Claude Code statusline inbox, binds each sample to
//! the binding whose confirmed identity the hook stamped on it, quarantines what
//! cannot be bound safely, releases what a later run can bind, and emits
//! `allowance.reading` records with reader `statusline` (meter keys `five_hour`,
//! `seven_day`, and every model-scoped `seven_day_<model>`). Mode `oauth_usage`
//! also calls the private OAuth usage interface with the existing Claude Code
//! sign-in. Observatory never POSTs a refresh_token; when
//! `allowance.claude_oauth_keepalive` is on it may spawn Claude Code so *it*
//! refreshes its own store. Statusline stays the documented fallback. A deny of
//! `allowance.claude_reader.statusline` removes only the fallback; a deny of the
//! whole `allowance.claude_reader` group still stops the adapter. The inbox
//! itself is pruned by the run, not here.

use std::time::Duration;

use observatory_contract::settings::ClaudeReader;
use observatory_contract::{
    Adapter as AdapterId, Channel, CoverageState, CursorState, DetailCode, Provider, Reader, Record, Stamp,
};
use observatory_core::adapter::{
    Adapter, AdapterError, BindingContext, Cursor, Outcome, Preflight, RunContext, Sink,
};
use observatory_core::claude_keepalive;
use observatory_core::credentials::{claude_access_token_in, claude_credential_presence_in};
use observatory_core::discovery::claude_identity;
use observatory_core::inbox::{
    oauth_usage_reader_denied, read_statusline_status, statusline_reader_denied, window_label,
    window_minutes, window_slug,
};
use observatory_core::provider_http::Auth;
use observatory_core::pyjson::epoch_text;
use serde_json::{Map, Value};

use crate::provider::{
    ParsedPage, confirmed_binding, credential_error, json_f64, json_str, observed_now, percent_reading,
    provider_client, stamp_any, utilization_percent,
};
use crate::readings::{
    ClaudeAllowanceEvidence, InboxSummary, claude_allowance_capability, denied_allowance_capability,
    emit_dirty_slots, hook_status, ingest_statusline_inbox, prune_quarantine, release_quarantined,
};

/// The statusline reader's parser version: the companion version plus the
/// inbox format generation (part files with an identity stamp).
pub const PARSER_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+statusline1");
const OAUTH_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

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
        let oauth_mode = ctx.settings.allowance.claude_reader == ClaudeReader::OauthUsage;
        let statusline_denied = statusline_reader_denied(&ctx.deny);
        if statusline_denied && (!oauth_mode || oauth_usage_reader_denied(&ctx.deny)) {
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
        let ingest = if statusline_denied {
            InboxSummary::default()
        } else {
            ingest_statusline_inbox(&state, ctx, &bindings)?
        };
        let released = if statusline_denied { 0 } else { release_quarantined(&state, &bindings)? };
        if !statusline_denied {
            prune_quarantine(&state, ctx, &bindings)?;
        }
        let held = state.quarantine_counts()?;

        let mut outcome = Outcome::ok();
        outcome.stores_discovered = u64::from(ctx.statusline_inbox.is_dir());
        outcome.files = ingest.files;
        outcome.bytes_read = ingest.bytes_read;
        outcome.malformed = ingest.malformed;
        outcome.cursor_state = CursorState::Complete;
        let mut newest_bound: Option<String> = None;
        if !statusline_denied {
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
        }

        let mut oauth_emitted = 0u64;
        let mut oauth_detail = None;
        if oauth_mode {
            match collect_oauth_with_keepalive(ctx) {
                Ok(page) => {
                    outcome.probe_requests += 1;
                    outcome.malformed += page.malformed;
                    oauth_emitted = page.records.len() as u64;
                    for record in page.records {
                        sink.emit(record, None);
                    }
                    outcome.records_emitted += oauth_emitted;
                    if oauth_emitted == 0 && page.malformed > 0 {
                        outcome.state = CoverageState::Failed;
                        outcome.detail = Some(DetailCode::UnrecognizedPayload);
                    }
                }
                Err(AdapterError::Credential(code)) => {
                    oauth_detail = Some(code);
                    outcome.state = if outcome.records_emitted == 0 {
                        CoverageState::CredentialUnavailable
                    } else {
                        CoverageState::Partial
                    };
                    outcome.detail = Some(code);
                }
                Err(AdapterError::Http(code)) => {
                    outcome.probe_requests += 1;
                    oauth_detail = Some(code);
                    if outcome.records_emitted == 0
                        && matches!(code, DetailCode::HttpUnauthorized | DetailCode::HttpRateLimited)
                    {
                        return Err(AdapterError::Http(code));
                    }
                    outcome.state = CoverageState::Partial;
                    outcome.detail = Some(code);
                }
                Err(error) => return Err(error),
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
            oauth_emitted,
            oauth_detail,
        })]);
        Ok(outcome)
    }
}

fn keepalive_retryable(error: &AdapterError) -> bool {
    matches!(
        error,
        AdapterError::Credential(DetailCode::CredentialExpired)
            | AdapterError::Http(DetailCode::HttpUnauthorized)
    )
}

/// Spawn Claude Code so it refreshes its own OAuth store. Unit tests never
/// spawn; production never POSTs a refresh_token and never captures stdout.
fn try_refresh_claude_store(ctx: &RunContext) {
    if cfg!(test) {
        return;
    }
    let timeout = ctx.remaining().min(claude_keepalive::TIMEOUT);
    if timeout < Duration::from_secs(2) {
        return;
    }
    let _ = claude_keepalive::refresh_store(timeout);
}

fn collect_oauth_with_keepalive(ctx: &RunContext) -> Result<ParsedPage, AdapterError> {
    let keepalive = ctx.settings.allowance.claude_oauth_keepalive;
    let mut refreshed = false;
    if keepalive {
        let presence = claude_credential_presence_in(ctx.claude_credentials_path.as_deref());
        if claude_keepalive::indicated(presence, ctx.now.as_millisecond()) {
            try_refresh_claude_store(ctx);
            refreshed = true;
        }
    }
    match collect_oauth(ctx) {
        Ok(page) => Ok(page),
        Err(error) if keepalive && !refreshed && keepalive_retryable(&error) => {
            try_refresh_claude_store(ctx);
            collect_oauth(ctx)
        }
        other => other,
    }
}

fn collect_oauth(ctx: &RunContext) -> Result<ParsedPage, AdapterError> {
    let token = claude_access_token_in(ctx.claude_credentials_path.as_deref()).map_err(credential_error)?;
    let hash = claude_identity().map(|identity| identity.evidence_hash);
    let Some(binding) = confirmed_binding(ctx.bindings_for(Provider::Claude), hash.as_ref()) else {
        return Err(AdapterError::Credential(DetailCode::IdentityChanged));
    };
    let client = provider_client(ctx);
    let body = client
        .get_json(
            OAUTH_USAGE_URL,
            Auth::Bearer(&token),
            &[("anthropic-beta", "oauth-2025-04-20"), ("anthropic-version", "2023-06-01")],
        )
        .map_err(|error| AdapterError::Http(error.detail()))?;
    Ok(parse_oauth_usage(&body, &binding.binding_id, &observed_now(ctx)))
}

pub fn parse_oauth_usage(
    body: &Value,
    binding: &observatory_contract::Uuid,
    observed_at: &Stamp,
) -> ParsedPage {
    let mut page = ParsedPage::default();
    let mut seen = std::collections::BTreeSet::new();
    if let Some(items) = body.get("limits").and_then(Value::as_array) {
        for row in items {
            match oauth_from_limit_row(binding, row, observed_at) {
                Some((key, record)) => {
                    if seen.insert(key) {
                        page.records.push(record);
                    }
                }
                None => {
                    if row.as_object().is_some_and(|obj| {
                        matches!(
                            obj.get("kind").and_then(Value::as_str),
                            Some("session" | "weekly_all" | "weekly_scoped")
                        )
                    }) {
                        page.malformed += 1;
                    }
                }
            }
        }
    }
    let windows = body.get("rate_limits").or_else(|| body.get("usage")).unwrap_or(body);
    if let Some(object) = windows.as_object() {
        for (key, window) in object {
            if window_minutes(key).is_none() || !seen.insert(key.clone()) {
                continue;
            }
            match oauth_reading(binding, key, window, observed_at) {
                Some(record) => page.records.push(record),
                None => page.malformed += 1,
            }
        }
    } else if page.records.is_empty() {
        page.malformed += 1;
        return page;
    }
    if page.records.is_empty() && page.malformed == 0 {
        page.malformed += 1;
    }
    page
}

fn oauth_from_limit_row(
    binding: &observatory_contract::Uuid,
    row: &Value,
    observed_at: &Stamp,
) -> Option<(String, Record)> {
    let obj = row.as_object()?;
    let key = match obj.get("kind").and_then(Value::as_str).unwrap_or("") {
        "session" => "five_hour".to_owned(),
        "weekly_all" => "seven_day".to_owned(),
        "weekly_scoped" => {
            let name = scoped_oauth_name(obj.get("scope"))?;
            let slug = window_slug(&name);
            if slug.is_empty() {
                return None;
            }
            format!("seven_day_{slug}")
        }
        _ => return None,
    };
    let mut window = Map::new();
    if let Some(percent) = obj.get("percent").cloned().or_else(|| obj.get("used_percentage").cloned()) {
        window.insert("used_percent".into(), percent);
    }
    if let Some(utilization) = obj.get("utilization").cloned() {
        window.insert("utilization".into(), utilization);
    }
    if let Some(reset) = obj.get("resets_at").cloned().or_else(|| obj.get("resetsAt").cloned()) {
        window.insert("resets_at".into(), reset);
    }
    let record = oauth_reading(binding, &key, &Value::Object(window), observed_at)?;
    Some((key, record))
}

fn scoped_oauth_name(scope: Option<&Value>) -> Option<String> {
    let scope = scope?.as_object()?;
    if let Some(model) = scope.get("model") {
        if let Some(name) = json_str(model.get("display_name")).or_else(|| json_str(model.get("id"))) {
            return Some(name.to_owned());
        }
    }
    match scope.get("surface") {
        Some(Value::String(name)) => Some(name.clone()),
        Some(other) => {
            json_str(other.get("display_name")).or_else(|| json_str(other.get("id"))).map(str::to_owned)
        }
        None => None,
    }
}

fn oauth_reading(
    binding: &observatory_contract::Uuid,
    key: &str,
    window: &Value,
    observed_at: &Stamp,
) -> Option<Record> {
    let minutes = window_minutes(key)?;
    let used = json_f64(window.get("utilization"))
        .and_then(utilization_percent)
        .or_else(|| json_f64(window.get("used_percent")).filter(|value| (0.0..=100.0).contains(value)))
        .or_else(|| json_f64(window.get("used_percentage")).filter(|value| (0.0..=100.0).contains(value)))?;
    let resets_at = stamp_any(window.get("resets_at")).or_else(|| stamp_any(window.get("resetsAt")))?;
    percent_reading(
        binding,
        AdapterId::ClaudeAccount,
        Channel::ProviderApi,
        Reader::OauthUsage,
        PARSER_VERSION,
        key,
        &window_label(key),
        used,
        minutes,
        observed_at.clone(),
        resets_at,
        json_str(window.get("raw_window_id")).unwrap_or(key),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_fixture_accepts_fraction_or_percent_utilization() {
        let body: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/provider/claude-oauth-usage.json"
        ))
        .unwrap();
        let observed = Stamp::parse("2026-09-15T00:00:00.000Z").unwrap();
        let page = parse_oauth_usage(&body, &crate::provider::zero_uuid(), &observed);
        assert_eq!(page.malformed, 0);
        let keys: Vec<_> = page
            .records
            .iter()
            .filter_map(|record| match record {
                Record::AllowanceReading(reading) => Some(reading.meter_key.as_str().to_owned()),
                _ => None,
            })
            .collect();
        assert!(keys.contains(&"five_hour".to_owned()));
        assert!(keys.contains(&"seven_day".to_owned()));
        assert!(keys.contains(&"seven_day_claude_sonnet".to_owned()));
        let Record::AllowanceReading(five) = page
            .records
            .iter()
            .find(
                |record| matches!(record, Record::AllowanceReading(r) if r.meter_key.as_str() == "five_hour"),
            )
            .unwrap()
        else {
            unreachable!()
        };
        assert_eq!(five.reader, Reader::OauthUsage);
        assert!((five.value.as_ref().unwrap().as_f64() - 15.0).abs() < 0.001);
    }

    #[test]
    fn oauth_limits_array_emits_scoped_weekly_windows() {
        let body = serde_json::json!({
            "limits": [
                {"kind": "session", "percent": 20, "resets_at": "2026-09-15T05:00:00.000Z"},
                {"kind": "weekly_all", "percent": 40, "resets_at": "2026-09-20T00:00:00.000Z"},
                {"kind": "weekly_scoped", "percent": 51.5, "resets_at": "2026-09-20T00:00:00.000Z",
                    "scope": {"model": {"display_name": "Fable"}}}
            ]
        });
        let observed = Stamp::parse("2026-09-15T00:00:00.000Z").unwrap();
        let page = parse_oauth_usage(&body, &crate::provider::zero_uuid(), &observed);
        assert_eq!(page.malformed, 0);
        let keys: Vec<_> = page
            .records
            .iter()
            .filter_map(|record| match record {
                Record::AllowanceReading(reading) => Some(reading.meter_key.as_str().to_owned()),
                _ => None,
            })
            .collect();
        assert!(keys.contains(&"five_hour".to_owned()));
        assert!(keys.contains(&"seven_day".to_owned()));
        assert!(keys.contains(&"seven_day_fable".to_owned()));
    }

    #[test]
    fn live_claude_oauth_usage_when_requested() {
        if std::env::var("OBSERVATORY_LIVE_SOURCES").ok().as_deref() != Some("1") {
            return;
        }
        let path = observatory_core::paths::claude_credentials_file();
        let token = match observatory_core::credentials::claude_access_token_in(path.as_deref()) {
            Err(observatory_core::credentials::CredentialError::Expired) => {
                eprintln!(
                    "live_claude_oauth skipped: access token expired (keepalive spawns Claude Code; this live parse does not)"
                );
                return;
            }
            other => other.expect("claude access token"),
        };
        let client = observatory_core::provider_http::ProviderClient::new(std::time::Duration::from_secs(30));
        let body = client
            .get_json(
                OAUTH_USAGE_URL,
                Auth::Bearer(&token),
                &[("anthropic-beta", "oauth-2025-04-20"), ("anthropic-version", "2023-06-01")],
            )
            .expect("claude /api/oauth/usage");
        let keys: Vec<String> =
            body.as_object().map(|object| object.keys().cloned().collect()).unwrap_or_default();
        let observed = Stamp::parse("2026-09-17T00:00:00.000Z").unwrap();
        let parsed = parse_oauth_usage(&body, &crate::provider::zero_uuid(), &observed);
        eprintln!(
            "live_claude_oauth keys={keys:?} malformed={} records={}",
            parsed.malformed,
            parsed.records.len()
        );
        assert_eq!(parsed.malformed, 0, "oauth usage parse");
        assert!(!parsed.records.is_empty(), "oauth usage should emit allowance readings");
    }
}
