//! `cursor_account`: Cursor hosted allowance (`/api/usage-summary`) and billed usage events.

use observatory_contract::settings::CursorReader;
use observatory_contract::{
    Adapter as AdapterId, Channel, CoverageState, CursorState, DetailCode, EntryKind, Provider, Reader,
    Record, Stamp,
};
use observatory_core::adapter::{
    Adapter, AdapterError, BindingContext, Cursor, Outcome, Preflight, RunContext, Sink,
};
use observatory_core::cursor_store::{self, CursorStoreError};
use observatory_core::discovery::cursor_identity;
use observatory_core::provider_http::Auth;
use serde_json::{Value, json};

use crate::provider::{
    PageCursor, ParsedPage, add_seconds, apply_provider_error, confirmed_binding, count_reading, dimensions,
    emit_page, event_reference, exclusive_fresh, json_f64, json_str, json_u64, lookback_start, measures,
    money_entry, observed_now, percent_reading, pricing_opt, provider_client, stamp_any, token_accounting,
    unlimited_reading, usage_bucket, usd_from_cents, utilization_percent,
};

const PARSER_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+cursor-hosted1");
const USAGE_URL: &str = "https://cursor.com/api/usage-summary";
const EVENTS_URL: &str = "https://cursor.com/api/dashboard/get-filtered-usage-events";

#[derive(Debug, Default)]
pub struct CursorAccount;

impl Adapter for CursorAccount {
    fn id(&self) -> AdapterId {
        AdapterId::CursorAccount
    }
    fn parser_version(&self) -> &'static str {
        PARSER_VERSION
    }
    fn preflight(&self, ctx: &RunContext) -> Preflight {
        let present = ctx
            .bindings_for(Provider::Cursor)
            .filter(|binding| binding.runnable())
            .any(|binding| binding.cursor_state_db.as_ref().is_some_and(|path| path.is_file()));
        if present {
            Preflight::Ready
        } else {
            Preflight::Blocked {
                state: CoverageState::CredentialUnavailable,
                detail: DetailCode::CredentialMissing,
            }
        }
    }
    fn collect(
        &self,
        ctx: &RunContext,
        cursor: Option<Cursor>,
        sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError> {
        let Some(binding) = confirmed_cursor_binding(ctx) else {
            return Ok(Outcome {
                state: CoverageState::IdentityChanged,
                detail: Some(DetailCode::IdentityChanged),
                ..Outcome::ok()
            });
        };
        let path = binding
            .cursor_state_db
            .as_ref()
            .ok_or(AdapterError::Credential(DetailCode::CredentialMissing))?;
        let identity = cursor_store::cursor_auth_identity(path).map_err(store_error)?;
        let token = cursor_store::cursor_access_token(path)
            .map_err(store_error)?
            .ok_or(AdapterError::Credential(DetailCode::CredentialMissing))?;
        let auth = Auth::CursorSession { token: &token, user_id: identity.user_id.as_deref() };
        let client = provider_client(ctx);
        let now = ctx.now.as_second();
        let lookback = lookback_start(now, ctx.settings.account_history.lookback_days.get());
        let mut page_cursor = PageCursor::parse(cursor.as_ref());
        if page_cursor.usage_through.is_none() {
            page_cursor.usage_through = Some(lookback);
        }
        let mut outcome = Outcome::ok();
        outcome.stores_discovered = 1;
        let mut emitted = 0usize;
        let observed = observed_now(ctx);
        let summary = ctx.settings.allowance.cursor_reader == CursorReader::UsageSummary;
        let events = ctx.settings.allowance.cursor_reader == CursorReader::DashboardRpc
            || ctx.settings.account_history.cursor_usage_events;

        if summary {
            match client.get_json(USAGE_URL, auth, &[]) {
                Ok(body) => {
                    outcome.probe_requests += 1;
                    let parsed = parse_usage_summary(&body, &binding.binding_id, &observed);
                    outcome.malformed += parsed.malformed;
                    emit_page(sink, parsed.records, &mut emitted, usize::MAX);
                }
                Err(error) => {
                    outcome.probe_requests += 1;
                    outcome.records_emitted = emitted as u64;
                    return apply_provider_error(error, outcome, emitted);
                }
            }
        }

        if events {
            loop {
                if ctx.should_stop() {
                    outcome.state = CoverageState::Partial;
                    outcome.detail = Some(DetailCode::Timeout);
                    outcome.cursor_state = CursorState::More;
                    outcome.next_cursor = page_cursor.encode();
                    break;
                }
                let page = page_cursor
                    .usage_page
                    .as_deref()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(1);
                let start_ms = page_cursor.usage_through.unwrap_or(lookback).saturating_mul(1000);
                let body = json!({
                    "teamId": 0,
                    "startDate": start_ms,
                    "endDate": now.saturating_mul(1000),
                    "page": page,
                    "pageSize": 50
                });
                match client.post_json(EVENTS_URL, auth, &[], body.to_string().as_bytes()) {
                    Ok(response) => {
                        outcome.probe_requests += 1;
                        let parsed = parse_events_page(&response, &binding.binding_id, &observed);
                        outcome.malformed += parsed.malformed;
                        let empty = parsed.records.is_empty();
                        emit_page(sink, parsed.records, &mut emitted, usize::MAX);
                        if empty || parsed.next_page.is_none() {
                            page_cursor.usage_page = None;
                            page_cursor.usage_through = Some(now);
                            break;
                        }
                        page_cursor.usage_page = parsed.next_page;
                    }
                    Err(error) => {
                        outcome.probe_requests += 1;
                        outcome.records_emitted = emitted as u64;
                        return apply_provider_error(error, outcome, emitted);
                    }
                }
            }
        }

        outcome.records_emitted = emitted as u64;
        if page_cursor.usage_page.is_some() {
            outcome.cursor_state = CursorState::More;
            outcome.next_cursor = page_cursor.encode();
        }
        Ok(outcome)
    }
}

fn store_error(error: CursorStoreError) -> AdapterError {
    match error {
        CursorStoreError::Open => AdapterError::Credential(DetailCode::CredentialMissing),
        CursorStoreError::Read => AdapterError::Io,
    }
}

fn confirmed_cursor_binding(ctx: &RunContext) -> Option<&BindingContext> {
    let path = ctx.bindings_for(Provider::Cursor).find_map(|binding| binding.cursor_state_db.clone())?;
    let hash = cursor_identity(&path).map(|identity| identity.evidence_hash);
    confirmed_binding(ctx.bindings_for(Provider::Cursor), hash.as_ref())
}

fn usage_plan(body: &Value) -> &Value {
    body.get("individualUsage")
        .and_then(|value| value.get("plan"))
        .or_else(|| body.get("premiumRequests"))
        .or_else(|| body.get("gpt-4"))
        .filter(|value| value.is_object())
        .unwrap_or(body)
}

pub fn parse_usage_summary(
    body: &Value,
    binding: &observatory_contract::Uuid,
    observed_at: &Stamp,
) -> ParsedPage {
    let mut page = ParsedPage::default();
    let plan = usage_plan(body);
    let used = json_u64(plan.get("used"))
        .or_else(|| json_u64(plan.get("numRequests")))
        .or_else(|| json_u64(plan.get("numRequestsUsed")));
    let capacity = json_u64(plan.get("limit"))
        .or_else(|| json_u64(plan.get("numRequestsTotal")))
        .or_else(|| json_u64(plan.get("maxRequestUsage")))
        .or_else(|| json_u64(body.get("maxRequestUsage")))
        .filter(|value| *value > 0);
    let total_percent = json_f64(plan.get("totalPercentUsed"))
        .or_else(|| json_f64(body.get("totalPercentUsed")))
        .or_else(|| json_f64(plan.get("percentUsed")))
        .or_else(|| match (used, capacity) {
            (Some(used), Some(capacity)) => Some((used as f64) * 100.0 / (capacity as f64)),
            _ => None,
        })
        .and_then(utilization_percent);
    let resets_at = stamp_any(body.get("billingCycleEnd"))
        .or_else(|| stamp_any(plan.get("resetsAt")))
        .or_else(|| stamp_any(body.get("startOfMonth")).and_then(|start| add_seconds(&start, 86_400 * 30)));
    let split = percent_used_groups(body, plan);
    let unlimited = body.get("isUnlimited").and_then(Value::as_bool).unwrap_or(false)
        || json_str(body.get("membershipType")).is_some_and(|value| value.eq_ignore_ascii_case("unlimited"))
        || (capacity.is_none() && total_percent.is_none() && used.is_none() && split.is_empty());
    if unlimited && total_percent.is_none() && split.is_empty() {
        if let Some(record) = unlimited_reading(
            binding,
            AdapterId::CursorAccount,
            Channel::ProviderApi,
            Reader::UsageSummary,
            PARSER_VERSION,
            "premium_requests",
            "Cursor · included",
            observed_at.clone(),
            Some("premium_requests"),
        ) {
            page.records.push(record);
        }
        return page;
    }
    if !split.is_empty() {
        let Some(resets_at) = resets_at else {
            page.malformed += 1;
            return page;
        };
        for group in split {
            if let Some(record) = percent_reading(
                binding,
                AdapterId::CursorAccount,
                Channel::ProviderApi,
                Reader::UsageSummary,
                PARSER_VERSION,
                &group.key,
                &group.label,
                group.percent,
                43_200,
                observed_at.clone(),
                resets_at.clone(),
                &group.key,
            ) {
                page.records.push(record);
            } else {
                page.malformed += 1;
            }
        }
        return page;
    }
    if let (Some(percent), Some(resets_at)) = (total_percent, resets_at.clone()) {
        if let Some(record) = percent_reading(
            binding,
            AdapterId::CursorAccount,
            Channel::ProviderApi,
            Reader::UsageSummary,
            PARSER_VERSION,
            "premium_requests",
            "Cursor · included",
            percent,
            43_200,
            observed_at.clone(),
            resets_at,
            "premium_requests",
        ) {
            page.records.push(record);
        }
    } else if let (Some(used), Some(capacity)) = (used, capacity) {
        let remaining = capacity.saturating_sub(used) as f64;
        if let Some(record) = count_reading(
            binding,
            AdapterId::CursorAccount,
            Channel::ProviderApi,
            Reader::UsageSummary,
            PARSER_VERSION,
            "premium_requests",
            "Cursor · included",
            remaining,
            Some(capacity as f64),
            Some(43_200),
            observed_at.clone(),
            resets_at,
            "premium_requests",
        ) {
            page.records.push(record);
        }
    } else {
        page.malformed += 1;
    }
    page
}

struct PercentGroup {
    key: String,
    label: String,
    percent: f64,
}

/// Each `*PercentUsed` field on the plan is its own meter. `totalPercentUsed` is skipped when
/// Auto/API (or any other named pool) is present so the split Cursor reports is what we store.
fn percent_used_groups(body: &Value, plan: &Value) -> Vec<PercentGroup> {
    let Some(object) = plan.as_object() else {
        return Vec::new();
    };
    let mut groups = Vec::new();
    for (name, value) in object {
        let Some(prefix) = name.strip_suffix("PercentUsed") else { continue };
        if prefix.eq_ignore_ascii_case("total") {
            continue;
        }
        let Some(percent) = json_f64(Some(value)).and_then(utilization_percent) else { continue };
        let key = meter_slug(prefix);
        if key.is_empty() {
            continue;
        }
        let label = pool_label(body, prefix, &key);
        groups.push(PercentGroup { key, label, percent });
    }
    groups
}

fn meter_slug(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    out.trim_matches('_').to_owned()
}

fn pool_label(body: &Value, prefix: &str, key: &str) -> String {
    let candidates = [
        format!("{prefix}ModelSelectedDisplayMessage"),
        format!("{key}ModelSelectedDisplayMessage"),
        "namedModelSelectedDisplayMessage".to_owned(),
        "autoModelSelectedDisplayMessage".to_owned(),
    ];
    for candidate in candidates {
        if prefix.eq_ignore_ascii_case("api") && candidate.starts_with("auto") {
            continue;
        }
        if prefix.eq_ignore_ascii_case("auto") && candidate.starts_with("named") {
            continue;
        }
        if let Some(label) = json_str(body.get(&candidate)).filter(|value| !value.is_empty()) {
            return label.to_owned();
        }
    }
    format!("Cursor · {}", title_case(key))
}

fn title_case(slug: &str) -> String {
    slug.split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn parse_events_page(
    body: &Value,
    binding: &observatory_contract::Uuid,
    observed_at: &Stamp,
) -> ParsedPage {
    let mut page = ParsedPage::default();
    let events = body.get("usageEventsDisplay").or_else(|| body.get("usageEvents")).and_then(Value::as_array);
    let Some(events) = events else {
        page.malformed += 1;
        return page;
    };
    for event in events {
        match event_records(binding, event, observed_at) {
            Some(mut records) => page.records.append(&mut records),
            None => page.malformed += 1,
        }
    }
    let page_number = json_u64(body.get("page")).or_else(|| json_u64(body.get("nextPage")));
    let has_more = body.get("hasMore").and_then(Value::as_bool).unwrap_or_else(|| {
        json_u64(body.get("totalUsageEventsCount"))
            .is_some_and(|total| (page_number.unwrap_or(1) * 50) < total)
            || events.len() >= 50
    });
    if has_more {
        page.next_page = Some((page_number.unwrap_or(1) + 1).to_string());
    }
    page
}

fn event_records(
    binding: &observatory_contract::Uuid,
    event: &Value,
    observed_at: &Stamp,
) -> Option<Vec<Record>> {
    let usage = event.get("tokenUsage").or_else(|| event.get("token_usage")).unwrap_or(event);
    let input = json_u64(usage.get("inputTokens")).or_else(|| json_u64(usage.get("input_tokens")));
    let cached = json_u64(usage.get("cacheReadTokens")).or_else(|| json_u64(usage.get("cache_read_tokens")));
    let cache_write =
        json_u64(usage.get("cacheWriteTokens")).or_else(|| json_u64(usage.get("cache_write_tokens")));
    let output = json_u64(usage.get("outputTokens")).or_else(|| json_u64(usage.get("output_tokens")));
    let cents = json_f64(event.get("chargedCents")).or_else(|| json_f64(event.get("charged_cents")));
    if input.is_none() && cached.is_none() && cache_write.is_none() && output.is_none() && cents.is_none() {
        return None;
    }
    let started = stamp_any(event.get("timestamp")).or_else(|| stamp_any(event.get("createdAt")))?;
    let ended = add_seconds(&started, 1).unwrap_or_else(|| started.clone());
    let event_id = json_str(event.get("id"))
        .or_else(|| json_str(event.get("usageEventId")))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!("{}:{}", started.as_str(), json_str(event.get("model")).unwrap_or("unknown"))
        });
    // Cursor reports cache-read beside input, not inside it. Subtract only when input is inclusive.
    let fresh = match (input, cached) {
        (Some(input), Some(cached)) if cached > input => Some(input),
        _ => exclusive_fresh(input, cached).or(input),
    };
    let total = [fresh, cached, cache_write, output].into_iter().flatten().sum::<u64>();
    let total =
        (fresh.is_some() || cached.is_some() || cache_write.is_some() || output.is_some()).then_some(total);
    let mut records = Vec::new();
    if let Some(bucket) = usage_bucket(
        binding,
        AdapterId::CursorAccount,
        Channel::ProviderApi,
        PARSER_VERSION,
        observed_at.clone(),
        "cursor_usage_events",
        started.clone(),
        ended.clone(),
        dimensions(
            json_str(event.get("model")),
            json_str(event.get("kind")).or(Some("cursor_ide")),
            None,
            None,
            None,
            pricing_opt(None, json_str(event.get("maxMode")).map(|_| "max"), None, None, None),
        ),
        measures(Some(1), fresh, cached, cache_write, output, None, total),
        token_accounting(fresh, cached, cache_write, output, total),
        Some(&event_id),
        None,
    ) {
        records.push(bucket);
    }
    if let Some(cents) = cents.filter(|value| *value > 0.0) {
        if let Some(entry) = money_entry(
            binding,
            AdapterId::CursorAccount,
            Channel::ProviderApi,
            PARSER_VERSION,
            observed_at.clone(),
            EntryKind::MeteredCharge,
            usd_from_cents(cents)?,
            Some("usd_cents"),
            Some(started),
            Some(ended),
            event_reference(&event_id),
            json_str(event.get("kind")),
            json_str(event.get("model")),
        ) {
            records.push(entry);
        }
    }
    Some(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use observatory_contract::AllowanceKind;

    #[test]
    fn usage_summary_fixture_emits_a_percent_reading() {
        let body: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/provider/cursor-usage.json"
        ))
        .unwrap();
        let observed = Stamp::parse("2026-09-15T00:00:00.000Z").unwrap();
        let page = parse_usage_summary(&body, &crate::provider::zero_uuid(), &observed);
        assert_eq!(page.malformed, 0);
        let Record::AllowanceReading(reading) = &page.records[0] else { panic!("reading") };
        assert_eq!(reading.reader, Reader::UsageSummary);
        assert_eq!(reading.kind, AllowanceKind::PercentUsed);
        assert_eq!(reading.meter_key.as_str(), "premium_requests");
    }

    #[test]
    fn usage_summary_uses_plan_total_percent_not_used_over_limit() {
        let body = json!({
            "billingCycleStart": "2026-08-18T17:45:12.000Z",
            "billingCycleEnd": "2026-09-18T17:45:12.000Z",
            "membershipType": "pro",
            "isUnlimited": false,
            "individualUsage": {
                "plan": {
                    "used": 2000,
                    "limit": 2000,
                    "remaining": 0,
                    "totalPercentUsed": 42.18181818181818
                }
            }
        });
        let observed = Stamp::parse("2026-09-15T00:00:00.000Z").unwrap();
        let page = parse_usage_summary(&body, &crate::provider::zero_uuid(), &observed);
        assert_eq!(page.malformed, 0);
        let Record::AllowanceReading(reading) = &page.records[0] else { panic!("reading") };
        assert_eq!(reading.kind, AllowanceKind::PercentUsed);
        assert!((reading.value.as_ref().unwrap().as_f64() - 42.18181818181818).abs() < 0.001);
    }

    #[test]
    fn events_fixture_keeps_local_counters_off_the_billed_ledger() {
        let body: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/provider/cursor-events.json"
        ))
        .unwrap();
        let observed = Stamp::parse("2026-09-15T00:00:00.000Z").unwrap();
        let page = parse_events_page(&body, &crate::provider::zero_uuid(), &observed);
        assert_eq!(page.malformed, 0);
        assert!(page.records.iter().any(|record| matches!(record, Record::AccountUsageBucket(_))));
        assert!(page.records.iter().any(|record| matches!(record, Record::MoneyEntry(_))));
        let Record::AccountUsageBucket(bucket) =
            page.records.iter().find(|record| matches!(record, Record::AccountUsageBucket(_))).unwrap()
        else {
            unreachable!()
        };
        assert_eq!(bucket.report_source.as_str(), "cursor_usage_events");
        assert_eq!(bucket.measures.input_tokens.as_ref().map(|v| v.get()), Some(80));
        assert_eq!(bucket.measures.cached_tokens.as_ref().map(|v| v.get()), Some(20));
        assert_eq!(bucket.measures.total_tokens.as_ref().map(|v| v.get()), Some(110));
        assert_eq!(bucket.dimensions.model.as_ref().map(|v| v.as_str()), Some("composer-1"));
    }

    #[test]
    fn usage_summary_emits_each_named_percent_used_pool() {
        let body = json!({
            "billingCycleStart": "2026-08-18T17:45:12.000Z",
            "billingCycleEnd": "2026-09-18T17:45:12.000Z",
            "membershipType": "pro",
            "isUnlimited": false,
            "autoModelSelectedDisplayMessage": "Auto includes Grok",
            "namedModelSelectedDisplayMessage": "API models are separate",
            "individualUsage": {
                "plan": {
                    "used": 2000,
                    "limit": 2000,
                    "remaining": 0,
                    "autoPercentUsed": 40.48,
                    "apiPercentUsed": 100,
                    "totalPercentUsed": 46.13
                }
            }
        });
        let observed = Stamp::parse("2026-09-15T00:00:00.000Z").unwrap();
        let page = parse_usage_summary(&body, &crate::provider::zero_uuid(), &observed);
        assert_eq!(page.malformed, 0);
        let keys: Vec<_> = page
            .records
            .iter()
            .filter_map(|record| match record {
                Record::AllowanceReading(reading) => Some(reading.meter_key.as_str().to_owned()),
                _ => None,
            })
            .collect();
        assert!(keys.contains(&"auto".to_owned()));
        assert!(keys.contains(&"api".to_owned()));
        assert!(!keys.contains(&"premium_requests".to_owned()));
        let auto = page
            .records
            .iter()
            .find_map(|record| match record {
                Record::AllowanceReading(reading) if reading.meter_key.as_str() == "auto" => Some(reading),
                _ => None,
            })
            .unwrap();
        let api = page
            .records
            .iter()
            .find_map(|record| match record {
                Record::AllowanceReading(reading) if reading.meter_key.as_str() == "api" => Some(reading),
                _ => None,
            })
            .unwrap();
        assert_eq!(auto.label.as_str(), "Auto includes Grok");
        assert_eq!(api.label.as_str(), "API models are separate");
        assert!((auto.value.as_ref().unwrap().as_f64() - 40.48).abs() < 0.001);
        assert!((api.value.as_ref().unwrap().as_f64() - 100.0).abs() < 0.001);
    }

    #[test]
    fn events_keep_reported_input_when_cache_read_is_beside_it() {
        let body = json!({
            "usageEventsDisplay": [{
                "timestamp": "1725000000000",
                "model": "composer-1",
                "kind": "USAGE_EVENT_KIND_USAGE_BASED",
                "tokenUsage": {
                    "inputTokens": 100,
                    "cacheReadTokens": 5000,
                    "outputTokens": 10
                },
                "chargedCents": 4
            }],
            "totalUsageEventsCount": 1,
            "page": 1
        });
        let observed = Stamp::parse("2026-09-15T00:00:00.000Z").unwrap();
        let page = parse_events_page(&body, &crate::provider::zero_uuid(), &observed);
        assert_eq!(page.malformed, 0);
        let Record::AccountUsageBucket(bucket) =
            page.records.iter().find(|record| matches!(record, Record::AccountUsageBucket(_))).unwrap()
        else {
            unreachable!()
        };
        assert_eq!(bucket.measures.input_tokens.as_ref().map(|v| v.get()), Some(100));
        assert_eq!(bucket.measures.cached_tokens.as_ref().map(|v| v.get()), Some(5000));
        assert_eq!(bucket.measures.total_tokens.as_ref().map(|v| v.get()), Some(5110));
    }

    #[test]
    fn live_cursor_hosted_session_when_requested() {
        if std::env::var("OBSERVATORY_LIVE_SOURCES").ok().as_deref() != Some("1") {
            return;
        }
        let path = observatory_core::paths::cursor_state_db().expect("cursor state path");
        let identity = cursor_store::cursor_auth_identity(&path).unwrap();
        let token = cursor_store::cursor_access_token(&path).unwrap().expect("access token");
        let client = observatory_core::provider_http::ProviderClient::new(std::time::Duration::from_secs(30));
        let auth = Auth::CursorSession { token: &token, user_id: identity.user_id.as_deref() };
        let body = client.get_json(USAGE_URL, auth, &[]).expect("cursor /api/usage-summary");
        let keys: Vec<String> =
            body.as_object().map(|object| object.keys().cloned().collect()).unwrap_or_default();
        let observed = Stamp::parse("2026-09-17T00:00:00.000Z").unwrap();
        let parsed = parse_usage_summary(&body, &crate::provider::zero_uuid(), &observed);
        eprintln!(
            "live_cursor_usage keys={keys:?} malformed={} records={}",
            parsed.malformed,
            parsed.records.len()
        );
        assert_eq!(parsed.malformed, 0, "usage summary parse");
        assert!(!parsed.records.is_empty(), "usage summary should emit an allowance reading");

        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("time").as_secs();
        let request = json!({
            "teamId": 0,
            "startDate": (now.saturating_sub(86_400 * 7)) * 1000,
            "endDate": now * 1000,
            "page": 1,
            "pageSize": 50
        });
        let events = client
            .post_json(EVENTS_URL, auth, &[], request.to_string().as_bytes())
            .expect("cursor usage events");
        let event_keys: Vec<String> =
            events.as_object().map(|object| object.keys().cloned().collect()).unwrap_or_default();
        let parsed_events = parse_events_page(&events, &crate::provider::zero_uuid(), &observed);
        eprintln!(
            "live_cursor_events keys={event_keys:?} malformed={} records={} next={:?}",
            parsed_events.malformed,
            parsed_events.records.len(),
            parsed_events.next_page
        );
        assert!(
            parsed_events.malformed == 0 || !parsed_events.records.is_empty(),
            "events page should parse or be an empty recognized list"
        );
    }
}
