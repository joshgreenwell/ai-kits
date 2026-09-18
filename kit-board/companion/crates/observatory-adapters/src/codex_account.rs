//! `codex_account`: Codex app-server allowance windows. `web_backend` stays unimplemented.

use std::process::Command;
use std::time::Duration;

use observatory_contract::settings::CodexReader;
use observatory_contract::{
    Adapter as AdapterId, Channel, CoverageState, CursorState, DetailCode, Provider, Reader, Record, Stamp,
};
use observatory_core::adapter::{Adapter, AdapterError, Cursor, Outcome, Preflight, RunContext, Sink};
use observatory_core::discovery::{codex_identity, find_executable};
use observatory_core::process::{JsonRpcProcess, RpcError};
use serde_json::{Value, json};

use crate::provider::{
    ParsedPage, confirmed_binding, json_f64, json_i64, json_str, json_u64, observed_now, percent_reading,
    stamp_unix, utilization_percent,
};

const PARSER_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+appserver1");

#[derive(Debug, Default)]
pub struct CodexAccount;

impl Adapter for CodexAccount {
    fn id(&self) -> AdapterId {
        AdapterId::CodexAccount
    }
    fn parser_version(&self) -> &'static str {
        PARSER_VERSION
    }
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        if !ctx.bindings_for(Provider::Codex).any(|binding| binding.runnable()) {
            return Preflight::Blocked {
                state: CoverageState::PrerequisiteMissing,
                detail: DetailCode::NoBinding,
            };
        }
        if ctx.settings.allowance.codex_reader == CodexReader::WebBackend {
            return Preflight::Blocked {
                state: CoverageState::PrerequisiteMissing,
                detail: DetailCode::NotImplemented,
            };
        }
        if find_executable("codex").is_none() {
            return Preflight::Blocked {
                state: CoverageState::PrerequisiteMissing,
                detail: DetailCode::ExecutableMissing,
            };
        }
        Preflight::Ready
    }
    fn collect(
        &self,
        ctx: &RunContext,
        _cursor: Option<Cursor>,
        sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError> {
        if ctx.settings.allowance.codex_reader == CodexReader::WebBackend {
            return Ok(Outcome {
                state: CoverageState::PrerequisiteMissing,
                detail: Some(DetailCode::NotImplemented),
                ..Outcome::ok()
            });
        }
        let Some(binding) = confirmed_codex_binding(ctx) else {
            return Ok(Outcome {
                state: CoverageState::IdentityChanged,
                detail: Some(DetailCode::IdentityChanged),
                ..Outcome::ok()
            });
        };
        let exe = find_executable("codex").ok_or(AdapterError::Subprocess)?;
        let mut command = Command::new(exe);
        command.arg("app-server");
        if let Some(home) = &binding.codex_home {
            command.env("CODEX_HOME", home);
        }
        let mut process = JsonRpcProcess::spawn(&mut command).map_err(|_| AdapterError::Subprocess)?;
        let timeout = ctx.remaining().clamp(Duration::from_secs(1), Duration::from_secs(15));
        process
            .request(
                1,
                "initialize",
                json!({"clientInfo": {"name": "observatory", "version": env!("CARGO_PKG_VERSION")}}),
                timeout,
            )
            .map_err(rpc_error)?;
        process.notify("initialized", json!({})).map_err(rpc_error)?;
        let result = process.request(2, "account/rateLimits/read", json!({}), timeout).map_err(rpc_error)?;
        let observed = observed_now(ctx);
        let parsed = parse_rate_limits(&result, &binding.binding_id, &observed);
        let mut outcome = Outcome::ok();
        outcome.stores_discovered = 1;
        outcome.probe_requests = 1;
        outcome.malformed = parsed.malformed;
        outcome.cursor_state = CursorState::Complete;
        let mut emitted = 0usize;
        crate::provider::emit_page(sink, parsed.records, &mut emitted, usize::MAX);
        outcome.records_emitted = emitted as u64;
        Ok(outcome)
    }
}

fn confirmed_codex_binding(ctx: &RunContext) -> Option<&observatory_core::adapter::BindingContext> {
    let home = ctx.bindings_for(Provider::Codex).find_map(|binding| binding.codex_home.clone())?;
    let hash = codex_identity(&home).map(|identity| identity.evidence_hash);
    confirmed_binding(ctx.bindings_for(Provider::Codex), hash.as_ref())
}

fn rpc_error(error: RpcError) -> AdapterError {
    match error {
        RpcError::Timeout => AdapterError::Timeout,
        RpcError::Protocol => AdapterError::Unrecognized,
        RpcError::Application | RpcError::Io => AdapterError::Subprocess,
    }
}

pub fn parse_rate_limits(
    body: &Value,
    binding: &observatory_contract::Uuid,
    observed_at: &Stamp,
) -> ParsedPage {
    let mut page = ParsedPage::default();
    if let Some(by_id) = body.get("rateLimitsByLimitId").and_then(Value::as_object) {
        for (limit_id, windows) in by_id {
            parse_window_group(&mut page, binding, observed_at, limit_id, windows);
        }
        return page;
    }
    let windows = body.get("rateLimits").unwrap_or(body);
    parse_window_group(&mut page, binding, observed_at, "codex", windows);
    page
}

fn parse_window_group(
    page: &mut ParsedPage,
    binding: &observatory_contract::Uuid,
    observed_at: &Stamp,
    limit_id: &str,
    windows: &Value,
) {
    let pairs = [("primary", windows.get("primary")), ("secondary", windows.get("secondary"))];
    for (raw_id, window) in pairs {
        let Some(window) = window.filter(|value| value.is_object()) else { continue };
        match reading_from_window(binding, observed_at, limit_id, raw_id, window) {
            Some(record) => page.records.push(record),
            None => page.malformed += 1,
        }
    }
}

fn reading_from_window(
    binding: &observatory_contract::Uuid,
    observed_at: &Stamp,
    limit_id: &str,
    raw_id: &str,
    window: &Value,
) -> Option<Record> {
    let used = json_f64(window.get("usedPercent"))
        .or_else(|| json_f64(window.get("used_percent")))
        .and_then(utilization_percent)?;
    let minutes = json_u64(window.get("windowDurationMins"))
        .or_else(|| json_u64(window.get("window_minutes")))
        .filter(|value| *value > 0)?;
    let resets = json_i64(window.get("resetsAt")).or_else(|| json_i64(window.get("resets_at")))?;
    if resets <= observed_at.epoch_seconds() {
        return None;
    }
    let resets_at = stamp_unix(resets)?;
    let id_text = json_str(window.get("limit_id")).unwrap_or(limit_id);
    let name = json_str(window.get("limit_name")).unwrap_or(if id_text.contains("spark") {
        "Codex Spark"
    } else {
        "Codex"
    });
    let meter = format!("{id_text}:{minutes}");
    let label = format!(
        "{name}{}",
        if minutes == 10_080 { " · weekly".to_owned() } else { format!(" · {}h", minutes / 60) }
    );
    percent_reading(
        binding,
        AdapterId::CodexAccount,
        Channel::AppServer,
        Reader::AppServer,
        PARSER_VERSION,
        &meter,
        &label,
        used,
        minutes,
        observed_at.clone(),
        resets_at,
        raw_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_server_fixture_uses_embedded_meter_keys() {
        let body: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/provider/codex-rate-limits.json"
        ))
        .unwrap();
        let observed = Stamp::parse("2026-09-15T00:00:00.000Z").unwrap();
        let page = parse_rate_limits(&body, &crate::provider::zero_uuid(), &observed);
        assert_eq!(page.malformed, 0);
        let keys: Vec<_> = page
            .records
            .iter()
            .filter_map(|record| match record {
                Record::AllowanceReading(reading) => Some(reading.meter_key.as_str().to_owned()),
                _ => None,
            })
            .collect();
        assert!(keys.contains(&"codex:300".to_owned()));
        assert!(keys.contains(&"codex_spark:10080".to_owned()));
        assert!(page.records.iter().all(|record| matches!(record, Record::AllowanceReading(reading) if reading.reader == Reader::AppServer)));
    }

    #[test]
    fn null_secondary_window_is_skipped_not_malformed() {
        let body = json!({
            "ordinaryUsageAllowed": true,
            "rateLimitsByLimitId": {
                "codex": {
                    "limitId": "codex",
                    "primary": { "usedPercent": 88, "windowDurationMins": 10080, "resetsAt": 1890000000i64 },
                    "secondary": null
                }
            }
        });
        let observed = Stamp::parse("2026-09-15T00:00:00.000Z").unwrap();
        let page = parse_rate_limits(&body, &crate::provider::zero_uuid(), &observed);
        assert_eq!(page.malformed, 0);
        let keys: Vec<_> = page
            .records
            .iter()
            .filter_map(|record| match record {
                Record::AllowanceReading(reading) => Some(reading.meter_key.as_str().to_owned()),
                _ => None,
            })
            .collect();
        assert_eq!(keys, ["codex:10080"]);
    }

    #[test]
    fn live_codex_app_server_when_requested() {
        if std::env::var("OBSERVATORY_LIVE_SOURCES").ok().as_deref() != Some("1") {
            return;
        }
        let exe = find_executable("codex").expect("codex install");
        let mut command = Command::new(&exe);
        command.arg("app-server");
        if let Some(home) = observatory_core::paths::home_dir() {
            command.env("CODEX_HOME", home.join(".codex"));
        }
        let mut process = JsonRpcProcess::spawn(&mut command).expect("spawn app-server");
        let timeout = Duration::from_secs(15);
        process
            .request(
                1,
                "initialize",
                json!({"clientInfo": {"name": "observatory", "version": env!("CARGO_PKG_VERSION")}}),
                timeout,
            )
            .expect("initialize");
        process.notify("initialized", json!({})).expect("initialized");
        let result = process
            .request(2, "account/rateLimits/read", json!({}), timeout)
            .expect("account/rateLimits/read");
        let keys: Vec<String> =
            result.as_object().map(|object| object.keys().cloned().collect()).unwrap_or_default();
        let observed = Stamp::parse("2026-09-17T00:00:00.000Z").unwrap();
        let parsed = parse_rate_limits(&result, &crate::provider::zero_uuid(), &observed);
        eprintln!(
            "live_codex_rpc exe_found=true keys={keys:?} malformed={} records={}",
            parsed.malformed,
            parsed.records.len()
        );
        assert_eq!(parsed.malformed, 0, "null secondary windows must be skipped");
        assert!(!parsed.records.is_empty(), "weekly primary window");
    }
}
