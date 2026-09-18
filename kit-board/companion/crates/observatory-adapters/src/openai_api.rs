//! `openai_api`: OpenAI Admin usage completions and organization costs.

use observatory_contract::{
    Adapter as AdapterId, Channel, CoverageState, CursorState, DetailCode, EntryKind, Provider, Record, Stamp,
};
use observatory_core::adapter::{Adapter, AdapterError, Cursor, Outcome, Preflight, RunContext, Sink};
use observatory_core::config::Secrets;
use observatory_core::provider_http::{Auth, query_string};
use serde_json::Value;

use crate::provider::{
    PageCursor, ParsedPage, add_seconds, admin_key, apply_provider_error, bucket_reference, dimensions,
    emit_page, exclusive_fresh, hour_stamp, json_f64, json_i64, json_str, json_u64, lookback_start, measures,
    money_entry, next_page_token, overlap_seconds, pricing_opt, provider_client, stamp_unix,
    token_accounting, usage_bucket, usd_from_f64,
};

const PARSER_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+admin-usage1");
const USAGE_URL: &str = "https://api.openai.com/v1/organization/usage/completions";
const COST_URL: &str = "https://api.openai.com/v1/organization/costs";
const HOUR: i64 = 3600;
const DAY: i64 = 86_400;

#[derive(Debug, Default)]
pub struct OpenaiApi;

impl Adapter for OpenaiApi {
    fn id(&self) -> AdapterId {
        AdapterId::OpenaiApi
    }
    fn parser_version(&self) -> &'static str {
        PARSER_VERSION
    }
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        if !ctx.bindings_for(Provider::OpenaiApi).any(|binding| binding.runnable()) {
            return Preflight::Blocked {
                state: CoverageState::PrerequisiteMissing,
                detail: DetailCode::NoBinding,
            };
        }
        match Secrets::load(ctx.secrets_dir()) {
            Ok(Some(secrets)) if secrets.openai_admin_key.as_ref().is_some_and(|key| !key.is_empty()) => {
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
            ctx.bindings_for(Provider::OpenaiApi).filter(|binding| binding.runnable()).collect();
        if bindings.is_empty() {
            return Ok(Outcome {
                state: CoverageState::PrerequisiteMissing,
                detail: Some(DetailCode::NoBinding),
                ..Outcome::ok()
            });
        }
        let key = admin_key(ctx, false)?;
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
        let auth = Auth::Bearer(&key);

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
            let mut pairs = vec![
                ("bucket_width", "1h".to_owned()),
                ("start_time", start.to_string()),
                ("end_time", now.to_string()),
                ("limit", "31".to_owned()),
                ("group_by", "model".to_owned()),
                ("group_by", "project_id".to_owned()),
                ("group_by", "user_id".to_owned()),
                ("group_by", "api_key_id".to_owned()),
                ("group_by", "service_tier".to_owned()),
            ];
            if let Some(page) = &page_cursor.usage_page {
                pairs.push(("page", page.clone()));
            }
            let refs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
            let url = format!("{USAGE_URL}?{}", query_string(&refs));
            match client.get_json(&url, auth, &[]) {
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
            let mut pairs = vec![
                ("bucket_width", "1d".to_owned()),
                ("start_time", start.to_string()),
                ("end_time", now.to_string()),
                ("limit", "31".to_owned()),
                ("group_by", "line_item".to_owned()),
                ("group_by", "project_id".to_owned()),
            ];
            if let Some(page) = &page_cursor.cost_page {
                pairs.push(("page", page.clone()));
            }
            let refs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
            let url = format!("{COST_URL}?{}", query_string(&refs));
            match client.get_json(&url, auth, &[]) {
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
        let Some(start) = json_i64(bucket.get("start_time")) else {
            page.malformed += 1;
            continue;
        };
        let Some(end) = json_i64(bucket.get("end_time")) else {
            page.malformed += 1;
            continue;
        };
        let Some(results) = bucket.get("results").and_then(Value::as_array) else {
            page.malformed += 1;
            continue;
        };
        let Some(bucket_start) = hour_stamp(start) else {
            page.malformed += 1;
            continue;
        };
        let Some(bucket_end) = stamp_unix(end).or_else(|| add_seconds(&bucket_start, HOUR)) else {
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

fn usage_record(
    binding: &observatory_contract::Uuid,
    result: &Value,
    bucket_start: &Stamp,
    bucket_end: &Stamp,
    observed_at: &Stamp,
) -> Option<Record> {
    let model = json_str(result.get("model"));
    let input = json_u64(result.get("input_tokens"));
    let cached = json_u64(result.get("input_cached_tokens"));
    let output = json_u64(result.get("output_tokens"));
    let requests = json_u64(result.get("num_model_requests"));
    let fresh = exclusive_fresh(input, cached);
    let accounting = token_accounting(fresh, cached, None, output, None);
    usage_bucket(
        binding,
        AdapterId::OpenaiApi,
        Channel::ProviderApi,
        PARSER_VERSION,
        observed_at.clone(),
        "openai_usage_completions",
        bucket_start.clone(),
        bucket_end.clone(),
        dimensions(
            model,
            None,
            json_str(result.get("user_id")),
            json_str(result.get("project_id")),
            json_str(result.get("api_key_id")),
            pricing_opt(None, json_str(result.get("service_tier")), None, None, None),
        ),
        measures(requests, fresh, cached, None, output, None, None),
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
        let Some(start) = json_i64(bucket.get("start_time")) else {
            page.malformed += 1;
            continue;
        };
        let end = json_i64(bucket.get("end_time")).unwrap_or(start.saturating_add(DAY));
        let Some(results) = bucket.get("results").and_then(Value::as_array) else {
            page.malformed += 1;
            continue;
        };
        let Some(started) = stamp_unix(start) else {
            page.malformed += 1;
            continue;
        };
        let Some(ended) = stamp_unix(end) else {
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
    let currency = json_str(amount.get("currency")).unwrap_or("usd");
    if !currency.eq_ignore_ascii_case("usd") {
        return None;
    }
    let value = json_f64(amount.get("value"))?;
    let line_item = json_str(result.get("line_item")).unwrap_or("unknown");
    money_entry(
        binding,
        AdapterId::OpenaiApi,
        Channel::ProviderApi,
        PARSER_VERSION,
        ended.clone(),
        EntryKind::MeteredCharge,
        usd_from_f64(value)?,
        Some("usd"),
        Some(started.clone()),
        Some(ended.clone()),
        bucket_reference(&format!("openai-cost:{line_item}:{}", started.as_str())),
        Some(line_item),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_fixture_keeps_cached_exclusive_of_fresh() {
        let body: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/provider/openai-usage.json"
        ))
        .unwrap();
        let page = parse_usage_page(&body, &crate::provider::zero_uuid());
        assert_eq!(page.malformed, 0);
        let Record::AccountUsageBucket(bucket) = &page.records[0] else { panic!("bucket") };
        assert_eq!(bucket.measures.input_tokens.as_ref().map(|v| v.get()), Some(80));
        assert_eq!(bucket.measures.cached_tokens.as_ref().map(|v| v.get()), Some(40));
        assert_eq!(bucket.measures.output_tokens.as_ref().map(|v| v.get()), Some(30));
        assert_eq!(bucket.dimensions.model.as_ref().map(|v| v.as_str()), Some("gpt-4.1"));
        assert!(page.next_page.is_none());
    }

    #[test]
    fn cost_fixture_keeps_usd_from_the_amount_value() {
        let body: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/provider/openai-costs.json"
        ))
        .unwrap();
        let page = parse_cost_page(&body, &crate::provider::zero_uuid());
        assert_eq!(page.malformed, 0);
        let Record::MoneyEntry(entry) = &page.records[0] else { panic!("money") };
        assert_eq!(entry.amount.as_str(), "1.23");
        assert_eq!(entry.sku.as_ref().map(|v| v.as_str()), Some("gpt-4.1"));
    }
}
