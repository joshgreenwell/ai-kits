//! `anthropic_api`: Anthropic Admin message usage and organization cost reports.

use observatory_contract::{
    Adapter as AdapterId, Channel, CoverageState, CursorState, DetailCode, EntryKind, Provider, Record, Stamp,
};
use observatory_core::adapter::{Adapter, AdapterError, Cursor, Outcome, Preflight, RunContext, Sink};
use observatory_core::config::Secrets;
use observatory_core::provider_http::{Auth, query_string};
use serde_json::Value;

use crate::provider::{
    PageCursor, ParsedPage, add_seconds, admin_key, apply_provider_error, bucket_reference, dimensions,
    emit_page, json_str, json_u64, lookback_start, measures, money_entry, next_page_token, overlap_seconds,
    pricing_opt, provider_client, stamp_any, stamp_unix, token_accounting, usage_bucket, usd_from_cents,
    usd_from_cents_text,
};

const PARSER_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+admin-usage1");
const USAGE_URL: &str = "https://api.anthropic.com/v1/organizations/usage_report/messages";
const COST_URL: &str = "https://api.anthropic.com/v1/organizations/cost_report";
const HOUR: i64 = 3600;
const DAY: i64 = 86_400;
const VERSION: (&str, &str) = ("anthropic-version", "2023-06-01");

#[derive(Debug, Default)]
pub struct AnthropicApi;

impl Adapter for AnthropicApi {
    fn id(&self) -> AdapterId {
        AdapterId::AnthropicApi
    }
    fn parser_version(&self) -> &'static str {
        PARSER_VERSION
    }
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        if !ctx.bindings_for(Provider::AnthropicApi).any(|binding| binding.runnable()) {
            return Preflight::Blocked {
                state: CoverageState::PrerequisiteMissing,
                detail: DetailCode::NoBinding,
            };
        }
        match Secrets::load(ctx.secrets_dir()) {
            Ok(Some(secrets)) if secrets.anthropic_admin_key.as_ref().is_some_and(|key| !key.is_empty()) => {
                Preflight::Ready
            }
            Ok(_) => Preflight::Blocked {
                state: CoverageState::CredentialUnavailable,
                detail: DetailCode::CredentialMissing,
            },
            Err(_) => Preflight::Blocked { state: CoverageState::Failed, detail: DetailCode::IoError },
        }
    }
    fn collect(
        &self,
        ctx: &RunContext,
        cursor: Option<Cursor>,
        sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError> {
        let bindings: Vec<_> =
            ctx.bindings_for(Provider::AnthropicApi).filter(|binding| binding.runnable()).collect();
        if bindings.is_empty() {
            return Ok(Outcome {
                state: CoverageState::PrerequisiteMissing,
                detail: Some(DetailCode::NoBinding),
                ..Outcome::ok()
            });
        }
        let key = admin_key(ctx, true)?;
        let client = provider_client(ctx);
        let now = ctx.now.as_second();
        let lookback = lookback_start(now, ctx.settings.account_history.lookback_days.get());
        let mut page_cursor = PageCursor::parse(cursor.as_ref());
        if page_cursor.usage_through.is_none() {
            page_cursor.usage_through = Some(lookback);
        }
        if page_cursor.cost_through.is_none() {
            page_cursor.cost_through = Some(lookback);
        }
        let mut outcome = Outcome::ok();
        outcome.stores_discovered = 1;
        let mut emitted = 0usize;
        let auth = Auth::ApiKey(&key);

        loop {
            if ctx.should_stop() {
                outcome.state = CoverageState::Partial;
                outcome.detail = Some(DetailCode::Timeout);
                outcome.cursor_state = CursorState::More;
                outcome.next_cursor = page_cursor.encode();
                break;
            }
            let start =
                page_cursor.usage_through.unwrap_or(lookback).saturating_sub(overlap_seconds(HOUR)).max(0);
            let start_text =
                stamp_unix(start).map(|stamp| stamp.as_str().to_owned()).unwrap_or_else(|| start.to_string());
            let end_text =
                stamp_unix(now).map(|stamp| stamp.as_str().to_owned()).unwrap_or_else(|| now.to_string());
            let mut pairs = vec![
                ("bucket_width", "1h".to_owned()),
                ("starting_at", start_text),
                ("ending_at", end_text),
                ("limit", "31".to_owned()),
                ("group_by[]", "model".to_owned()),
                ("group_by[]", "workspace_id".to_owned()),
                ("group_by[]", "api_key_id".to_owned()),
                ("group_by[]", "service_tier".to_owned()),
                ("group_by[]", "context_window".to_owned()),
                ("group_by[]", "speed".to_owned()),
            ];
            if let Some(page) = &page_cursor.usage_page {
                pairs.push(("page", page.clone()));
            }
            let refs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
            let url = format!("{USAGE_URL}?{}", query_string(&refs));
            match client.get_json(&url, auth, &[VERSION]) {
                Ok(body) => {
                    outcome.probe_requests += 1;
                    let mut malformed = 0;
                    for binding in &bindings {
                        let parsed = parse_usage_page(&body, &binding.binding_id);
                        malformed = malformed.max(parsed.malformed);
                        page_cursor.usage_page = parsed.next_page.clone();
                        if emit_page(sink, parsed.records, &mut emitted, usize::MAX) {
                            break;
                        }
                    }
                    outcome.malformed += malformed;
                    if page_cursor.usage_page.is_none() {
                        page_cursor.usage_through = Some(now);
                        break;
                    }
                }
                Err(error) => {
                    outcome.probe_requests += 1;
                    outcome.records_emitted = emitted as u64;
                    return apply_provider_error(error, outcome, emitted);
                }
            }
        }

        loop {
            if ctx.should_stop() {
                outcome.state = CoverageState::Partial;
                outcome.detail = Some(DetailCode::Timeout);
                outcome.cursor_state = CursorState::More;
                outcome.next_cursor = page_cursor.encode();
                break;
            }
            let start =
                page_cursor.cost_through.unwrap_or(lookback).saturating_sub(overlap_seconds(DAY)).max(0);
            let start_text =
                stamp_unix(start).map(|stamp| stamp.as_str().to_owned()).unwrap_or_else(|| start.to_string());
            let end_text =
                stamp_unix(now).map(|stamp| stamp.as_str().to_owned()).unwrap_or_else(|| now.to_string());
            let mut pairs = vec![
                ("bucket_width", "1d".to_owned()),
                ("starting_at", start_text),
                ("ending_at", end_text),
                ("limit", "31".to_owned()),
                ("group_by[]", "workspace_id".to_owned()),
                ("group_by[]", "description".to_owned()),
            ];
            if let Some(page) = &page_cursor.cost_page {
                pairs.push(("page", page.clone()));
            }
            let refs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
            let url = format!("{COST_URL}?{}", query_string(&refs));
            match client.get_json(&url, auth, &[VERSION]) {
                Ok(body) => {
                    outcome.probe_requests += 1;
                    let mut malformed = 0;
                    for binding in &bindings {
                        let parsed = parse_cost_page(&body, &binding.binding_id);
                        malformed = malformed.max(parsed.malformed);
                        page_cursor.cost_page = parsed.next_page.clone();
                        if emit_page(sink, parsed.records, &mut emitted, usize::MAX) {
                            break;
                        }
                    }
                    outcome.malformed += malformed;
                    if page_cursor.cost_page.is_none() {
                        page_cursor.cost_through = Some(now);
                        break;
                    }
                }
                Err(error) => {
                    outcome.probe_requests += 1;
                    outcome.records_emitted = emitted as u64;
                    return apply_provider_error(error, outcome, emitted);
                }
            }
        }

        outcome.records_emitted = emitted as u64;
        if page_cursor.usage_page.is_some() || page_cursor.cost_page.is_some() {
            outcome.cursor_state = CursorState::More;
            outcome.next_cursor = page_cursor.encode();
        }
        Ok(outcome)
    }
}

pub fn parse_usage_page(body: &Value, binding: &observatory_contract::Uuid) -> ParsedPage {
    let mut page = ParsedPage { next_page: next_page_token(body), ..ParsedPage::default() };
    let Some(data) = body.get("data").and_then(Value::as_array) else {
        page.malformed += 1;
        return page;
    };
    for bucket in data {
        let Some(bucket_start) =
            stamp_any(bucket.get("starting_at")).or_else(|| stamp_any(bucket.get("start_time")))
        else {
            page.malformed += 1;
            continue;
        };
        let bucket_end = stamp_any(bucket.get("ending_at"))
            .or_else(|| stamp_any(bucket.get("end_time")))
            .or_else(|| add_seconds(&bucket_start, HOUR));
        let Some(bucket_end) = bucket_end else {
            page.malformed += 1;
            continue;
        };
        let Some(results) = bucket.get("results").and_then(Value::as_array) else {
            page.malformed += 1;
            continue;
        };
        let observed_at = bucket_end.clone();
        for result in results {
            match usage_record(binding, result, &bucket_start, &bucket_end, &observed_at) {
                Some(record) => page.records.push(record),
                None => page.malformed += 1,
            }
        }
    }
    page
}

fn cache_write_tokens(result: &Value) -> Option<u64> {
    let creation = result.get("cache_creation");
    let five = json_u64(creation.and_then(|value| value.get("ephemeral_5m_input_tokens")));
    let hour = json_u64(creation.and_then(|value| value.get("ephemeral_1h_input_tokens")));
    match (five, hour) {
        (Some(five), Some(hour)) => Some(five.saturating_add(hour)),
        (Some(five), None) => Some(five),
        (None, Some(hour)) => Some(hour),
        (None, None) => json_u64(result.get("cache_creation_input_tokens")),
    }
}

fn context_window_tokens(result: &Value) -> Option<u64> {
    json_u64(result.get("context_window")).or_else(|| {
        json_str(result.get("context_window")).and_then(|text| {
            text.trim_end_matches(['k', 'K'])
                .parse::<u64>()
                .ok()
                .map(|value| if text.ends_with(['k', 'K']) { value.saturating_mul(1000) } else { value })
        })
    })
}

fn usage_record(
    binding: &observatory_contract::Uuid,
    result: &Value,
    bucket_start: &Stamp,
    bucket_end: &Stamp,
    observed_at: &Stamp,
) -> Option<Record> {
    let fresh = json_u64(result.get("uncached_input_tokens"));
    let cached = json_u64(result.get("cache_read_input_tokens"));
    let cache_write = cache_write_tokens(result);
    let output = json_u64(result.get("output_tokens"));
    let requests = json_u64(result.get("request_count")).or_else(|| json_u64(result.get("requests")));
    let accounting = token_accounting(fresh, cached, cache_write, output, None);
    usage_bucket(
        binding,
        AdapterId::AnthropicApi,
        Channel::ProviderApi,
        PARSER_VERSION,
        observed_at.clone(),
        "anthropic_usage_report",
        bucket_start.clone(),
        bucket_end.clone(),
        dimensions(
            json_str(result.get("model")),
            None,
            json_str(result.get("user_id")),
            json_str(result.get("workspace_id")),
            json_str(result.get("api_key_id")),
            pricing_opt(
                None,
                json_str(result.get("service_tier")),
                json_str(result.get("speed")),
                context_window_tokens(result),
                None,
            ),
        ),
        measures(requests, fresh, cached, cache_write, output, None, None),
        accounting,
        None,
        None,
    )
}

pub fn parse_cost_page(body: &Value, binding: &observatory_contract::Uuid) -> ParsedPage {
    let mut page = ParsedPage { next_page: next_page_token(body), ..ParsedPage::default() };
    let Some(data) = body.get("data").and_then(Value::as_array) else {
        page.malformed += 1;
        return page;
    };
    for bucket in data {
        let Some(started) =
            stamp_any(bucket.get("starting_at")).or_else(|| stamp_any(bucket.get("start_time")))
        else {
            page.malformed += 1;
            continue;
        };
        let ended = stamp_any(bucket.get("ending_at"))
            .or_else(|| stamp_any(bucket.get("end_time")))
            .or_else(|| add_seconds(&started, DAY));
        let Some(ended) = ended else {
            page.malformed += 1;
            continue;
        };
        let Some(results) = bucket.get("results").and_then(Value::as_array) else {
            page.malformed += 1;
            continue;
        };
        for result in results {
            match cost_record(binding, result, &started, &ended) {
                Some(record) => page.records.push(record),
                None => page.malformed += 1,
            }
        }
    }
    page
}

fn cost_record(
    binding: &observatory_contract::Uuid,
    result: &Value,
    started: &Stamp,
    ended: &Stamp,
) -> Option<Record> {
    let amount = result.get("amount")?;
    let usd = match amount {
        Value::String(text) => usd_from_cents_text(text),
        Value::Number(_) => usd_from_cents(amount.as_f64()?),
        Value::Object(object) => {
            let currency = json_str(object.get("currency")).unwrap_or("usd");
            if !currency.eq_ignore_ascii_case("usd") {
                return None;
            }
            json_str(object.get("value"))
                .and_then(usd_from_cents_text)
                .or_else(|| object.get("value").and_then(Value::as_f64).and_then(usd_from_cents))
        }
        _ => None,
    }?;
    let sku = json_str(result.get("description")).or_else(|| json_str(result.get("sku")));
    money_entry(
        binding,
        AdapterId::AnthropicApi,
        Channel::ProviderApi,
        PARSER_VERSION,
        ended.clone(),
        EntryKind::MeteredCharge,
        usd,
        Some("usd_cents"),
        Some(started.clone()),
        Some(ended.clone()),
        bucket_reference(&format!("anthropic-cost:{}:{}", sku.unwrap_or("unknown"), started.as_str())),
        sku,
        json_str(result.get("model")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_fixture_sums_cache_write_windows_and_keeps_uncached_fresh() {
        let body: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/provider/anthropic-usage.json"
        ))
        .unwrap();
        let page = parse_usage_page(&body, &crate::provider::zero_uuid());
        assert_eq!(page.malformed, 0);
        let Record::AccountUsageBucket(bucket) = &page.records[0] else { panic!("bucket") };
        assert_eq!(bucket.measures.input_tokens.as_ref().map(|v| v.get()), Some(100));
        assert_eq!(bucket.measures.cached_tokens.as_ref().map(|v| v.get()), Some(20));
        assert_eq!(bucket.measures.cache_write_tokens.as_ref().map(|v| v.get()), Some(15));
        assert_eq!(bucket.measures.output_tokens.as_ref().map(|v| v.get()), Some(40));
        assert_eq!(bucket.dimensions.model.as_ref().map(|v| v.as_str()), Some("claude-sonnet-4-5"));
    }

    #[test]
    fn cost_fixture_converts_cents_strings_to_usd() {
        let body: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/provider/anthropic-costs.json"
        ))
        .unwrap();
        let page = parse_cost_page(&body, &crate::provider::zero_uuid());
        assert_eq!(page.malformed, 0);
        let Record::MoneyEntry(entry) = &page.records[0] else { panic!("money") };
        assert_eq!(entry.amount.as_str(), "0.04");
    }
}
