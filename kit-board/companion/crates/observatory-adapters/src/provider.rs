//! Shared builders for provider-reported usage, money, and allowance records.

use std::str::FromStr;
use std::time::Duration;

use observatory_contract::records::WindowMinutes;
use observatory_contract::stable_json::stable_json;
use observatory_contract::{
    AccountUsageBucket, Adapter, AllowanceKind, AllowanceReading, AllowanceUnit, Amount, Basis,
    CapabilityCoverage, CapabilityDimension, CapabilityState, Channel, Code, CompositionState, Counter,
    CoverageState, CursorState, DetailCode, Dimensions, EntryKind, Measures, MeterKey, MoneyEntry, MoneyUnit,
    Nullable, PricingEvidence, Reader, Real, Record, Reference, ReferenceKind, Sha256Hex, Stamp, Text,
    TokenAccounting, Tokens, Uuid,
};
use observatory_core::adapter::{
    AdapterError, BindingContext, Cursor, IdentityState, Outcome, RunContext, Sink, record_id,
};
use observatory_core::config::{Secret, Secrets};
use observatory_core::credentials::CredentialError;
use observatory_core::provider_http::{ProviderClient, ProviderHttpError};
use observatory_core::pyjson::{epoch_text, hour_floor, iso};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Default)]
pub struct ParsedPage {
    pub records: Vec<Record>,
    pub malformed: u64,
    pub next_page: Option<String>,
}

pub fn apply_provider_error(
    error: ProviderHttpError,
    mut outcome: Outcome,
    emitted: usize,
) -> Result<Outcome, AdapterError> {
    let adapter_error = AdapterError::Http(error.detail());
    let (state, detail) = adapter_error.coverage();
    if emitted == 0
        && matches!(error, ProviderHttpError::Unauthorized | ProviderHttpError::RateLimited { .. })
    {
        return Err(adapter_error);
    }
    outcome.state = state;
    outcome.detail = Some(detail);
    outcome.records_emitted = emitted as u64;
    outcome.stores_discovered = outcome.stores_discovered.max(1);
    outcome.cursor_state = if emitted > 0 { CursorState::More } else { CursorState::Unknown };
    if matches!(error, ProviderHttpError::Unauthorized) {
        outcome.state = CoverageState::CredentialUnavailable;
    }
    Ok(outcome)
}

pub fn emit_page(sink: &mut dyn Sink, records: Vec<Record>, emitted: &mut usize, max: usize) -> bool {
    for record in records {
        if *emitted >= max {
            return true;
        }
        sink.emit(record, None);
        *emitted += 1;
    }
    false
}

pub fn hashed_ref(kind: &str, id: &str) -> Sha256Hex {
    Sha256Hex::digest(stable_json(&json!([kind, id])).as_bytes())
}

pub fn hashed_ref_opt(kind: &str, id: Option<&str>) -> Nullable<Sha256Hex> {
    Nullable(id.filter(|value| !value.is_empty()).map(|value| hashed_ref(kind, value)))
}

pub fn parser_text(version: &str) -> Option<Text<0, 30>> {
    Text::truncated(version).ok()
}

#[cfg(test)]
pub(crate) fn zero_uuid() -> Uuid {
    Uuid::from_str("00000000-0000-0000-0000-000000000000").expect("zero uuid")
}

pub fn code_opt(value: Option<&str>) -> Nullable<Code> {
    Nullable(value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Code::try_from(trimmed.to_ascii_lowercase().replace(' ', "_")).ok()
        }
    }))
}

pub fn model_opt(value: Option<&str>) -> Nullable<Text<0, 100>> {
    Nullable(value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() { None } else { Text::try_from(trimmed.to_owned()).ok() }
    }))
}

pub fn text120(value: Option<&str>) -> Nullable<Text<0, 120>> {
    Nullable(value.and_then(|text| Text::truncated(text).ok()))
}

pub fn text160(value: Option<&str>) -> Nullable<Text<0, 160>> {
    Nullable(value.and_then(|text| Text::truncated(text).ok()))
}

pub fn counter_opt(value: Option<u64>) -> Nullable<Counter> {
    Nullable(value.and_then(|n| Counter::new(n).ok()))
}

pub fn json_u64(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_u64().or_else(|| {
            number.as_i64().and_then(|n| u64::try_from(n).ok()).or_else(|| {
                number
                    .as_f64()
                    .and_then(|n| if n.is_finite() && n >= 0.0 { Some(n.trunc() as u64) } else { None })
            })
        }),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

pub fn json_i64(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number.as_i64().or_else(|| number.as_f64().map(|n| n.trunc() as i64)),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

pub fn json_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

pub fn json_str(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty())
}

pub fn stamp_any(value: Option<&Value>) -> Option<Stamp> {
    if let Some(text) = json_str(value) {
        return stamp_text(text).or_else(|| text.parse::<i64>().ok().and_then(stamp_epoch_number));
    }
    json_i64(value).and_then(stamp_epoch_number)
}

fn stamp_epoch_number(value: i64) -> Option<Stamp> {
    if value.abs() > 10_000_000_000 { stamp_millis(value) } else { stamp_unix(value) }
}

pub fn next_page_token(body: &Value) -> Option<String> {
    if body.get("has_more") == Some(&Value::Bool(false)) {
        return None;
    }
    json_str(body.get("next_page")).or_else(|| json_str(body.get("page"))).map(str::to_owned)
}

pub fn stamp_unix(seconds: i64) -> Option<Stamp> {
    iso(seconds as f64)
}

pub fn stamp_millis(millis: i64) -> Option<Stamp> {
    Stamp::from_millis(millis).ok()
}

pub fn stamp_text(text: &str) -> Option<Stamp> {
    Stamp::parse(text).ok().or_else(|| epoch_text(text).and_then(iso))
}

pub fn usd_from_f64(value: f64) -> Option<Amount> {
    if !value.is_finite() {
        return None;
    }
    let text = format!("{value:.6}");
    let trimmed = text.trim_end_matches('0').trim_end_matches('.');
    Amount::from_str(if trimmed == "-0" { "0" } else { trimmed }).ok()
}

pub fn usd_from_cents(cents: f64) -> Option<Amount> {
    usd_from_f64(cents / 100.0)
}

pub fn usd_from_cents_text(text: &str) -> Option<Amount> {
    usd_from_cents(text.trim().parse().ok()?)
}

pub fn exclusive_fresh(input: Option<u64>, cached: Option<u64>) -> Option<u64> {
    match (input, cached) {
        (Some(input), Some(cached)) => Some(input.saturating_sub(cached)),
        (Some(input), None) => Some(input),
        _ => None,
    }
}

pub fn token_accounting(
    input_fresh: Option<u64>,
    input_cached: Option<u64>,
    cache_write: Option<u64>,
    output: Option<u64>,
    reported_total: Option<u64>,
) -> Option<TokenAccounting> {
    let components = [input_fresh, input_cached, cache_write, output];
    let known: Vec<u64> = components.into_iter().flatten().collect();
    let known_sum: u64 = known.iter().sum();
    let all_known = known.len() == 4;
    let composition_state = if reported_total.is_some_and(|total| known_sum > total) {
        CompositionState::Inconsistent
    } else if all_known {
        CompositionState::Complete
    } else if known.is_empty() && reported_total.is_none() {
        CompositionState::Unknown
    } else {
        CompositionState::Partial
    };
    let unclassified = reported_total
        .filter(|_| composition_state != CompositionState::Inconsistent)
        .map(|total| Counter::saturating(total.saturating_sub(known_sum)));
    Some(TokenAccounting {
        reported_total: counter_opt(reported_total),
        unclassified: Nullable(unclassified),
        composition_state,
    })
}

pub fn tokens_from_exclusive(
    input_fresh: Option<u64>,
    input_cached: Option<u64>,
    cache_write: Option<u64>,
    output: Option<u64>,
) -> Tokens {
    Tokens {
        input_fresh: counter_opt(input_fresh),
        input_cached: counter_opt(input_cached),
        input_cache_write: counter_opt(cache_write),
        output: counter_opt(output),
        reasoning: Nullable::NULL,
    }
}

pub fn pricing_opt(
    effort: Option<&str>,
    tier: Option<&str>,
    speed: Option<&str>,
    context: Option<u64>,
    cache_ttl: Option<&str>,
) -> Option<PricingEvidence> {
    let pricing = PricingEvidence {
        reasoning_effort: code_opt(effort),
        service_tier: code_opt(tier),
        speed: code_opt(speed),
        context_window_tokens: counter_opt(context),
        cache_write_ttl: code_opt(cache_ttl),
    };
    pricing.has_evidence().then_some(pricing)
}

#[allow(clippy::too_many_arguments)]
pub fn usage_bucket(
    binding: &Uuid,
    adapter: Adapter,
    channel: Channel,
    parser_version: &str,
    observed_at: Stamp,
    report_source: &str,
    bucket_start: Stamp,
    bucket_end: Stamp,
    dimensions: Dimensions,
    measures: Measures,
    accounting: Option<TokenAccounting>,
    provider_event_id: Option<&str>,
    provider_refreshed_at: Option<Stamp>,
) -> Option<Record> {
    let locator = format!(
        "{}:{}:{}:{}:{}",
        report_source,
        bucket_start.as_str(),
        bucket_end.as_str(),
        provider_event_id.unwrap_or(""),
        dimensions_locator(&dimensions)
    );
    Some(Record::AccountUsageBucket(AccountUsageBucket {
        record_id: record_id(binding, channel, &locator),
        binding_id: binding.clone(),
        adapter,
        channel,
        observed_at,
        basis: Basis::Reported,
        parser_version: parser_text(parser_version)?,
        report_source: Code::try_from(report_source.to_owned()).ok()?,
        bucket_start,
        bucket_end,
        provider_timezone: Nullable::NULL,
        dimensions,
        measures,
        token_accounting: accounting,
        provider_event_id: text120(provider_event_id),
        provider_refreshed_at: Nullable(provider_refreshed_at),
    }))
}

fn dimensions_locator(dimensions: &Dimensions) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}",
        dimensions.model.as_ref().map(|value| value.as_str()).unwrap_or(""),
        dimensions.product.as_ref().map(|value| value.as_str()).unwrap_or(""),
        dimensions.user_ref.as_ref().map(|value| value.as_str()).unwrap_or(""),
        dimensions.workspace_ref.as_ref().map(|value| value.as_str()).unwrap_or(""),
        dimensions.api_key_ref.as_ref().map(|value| value.as_str()).unwrap_or(""),
        dimensions
            .pricing
            .as_ref()
            .map(|pricing| format!(
                "{}:{}:{}:{}:{}",
                pricing.reasoning_effort.as_ref().map(|v| v.as_str()).unwrap_or(""),
                pricing.service_tier.as_ref().map(|v| v.as_str()).unwrap_or(""),
                pricing.speed.as_ref().map(|v| v.as_str()).unwrap_or(""),
                pricing.context_window_tokens.as_ref().map(|v| v.get().to_string()).unwrap_or_default(),
                pricing.cache_write_ttl.as_ref().map(|v| v.as_str()).unwrap_or("")
            ))
            .unwrap_or_default()
    )
}

#[allow(clippy::too_many_arguments)]
pub fn money_entry(
    binding: &Uuid,
    adapter: Adapter,
    channel: Channel,
    parser_version: &str,
    observed_at: Stamp,
    kind: EntryKind,
    amount: Amount,
    source_unit: Option<&str>,
    period_start: Option<Stamp>,
    period_end: Option<Stamp>,
    reference: Reference,
    sku: Option<&str>,
    model: Option<&str>,
) -> Option<Record> {
    let locator = format!(
        "money:{}:{}:{}:{}",
        kind.as_str(),
        reference.kind.as_str(),
        reference.key.as_ref().map(|value| value.as_str()).unwrap_or(""),
        period_start.as_ref().map(Stamp::as_str).unwrap_or("")
    );
    Some(Record::MoneyEntry(MoneyEntry {
        record_id: record_id(binding, channel, &locator),
        binding_id: binding.clone(),
        adapter,
        channel,
        observed_at,
        basis: Basis::Reported,
        parser_version: parser_text(parser_version)?,
        entry_kind: kind,
        amount,
        unit: MoneyUnit::Usd,
        source_unit: code_opt(source_unit),
        price_basis: Code::try_from("provider_reported".to_owned()).ok()?,
        period_start: Nullable(period_start),
        period_end: Nullable(period_end),
        reference,
        sku: code_opt(sku),
        model: model_opt(model),
    }))
}

pub fn event_reference(event_id: &str) -> Reference {
    Reference { kind: ReferenceKind::ProviderEvent, key: text160(Some(event_id)) }
}

pub fn bucket_reference(locator: &str) -> Reference {
    Reference { kind: ReferenceKind::UsageBucket, key: text160(Some(locator)) }
}

#[allow(clippy::too_many_arguments)]
pub fn count_reading(
    binding: &Uuid,
    adapter: Adapter,
    channel: Channel,
    reader: Reader,
    parser_version: &str,
    meter_key: &str,
    label: &str,
    remaining: f64,
    capacity: Option<f64>,
    window_minutes: Option<u64>,
    observed_at: Stamp,
    resets_at: Option<Stamp>,
    raw_window_id: &str,
) -> Option<Record> {
    if !(0.0..=1e12).contains(&remaining) {
        return None;
    }
    let locator = format!("{}:{}:{}", reader.as_str(), meter_key, observed_at.as_str());
    Some(Record::AllowanceReading(AllowanceReading {
        record_id: record_id(binding, channel, &locator),
        binding_id: binding.clone(),
        adapter,
        channel,
        observed_at,
        basis: Basis::Reported,
        parser_version: parser_text(parser_version)?,
        meter_key: MeterKey::try_from(meter_key.to_owned()).ok()?,
        label: Text::truncated(label).ok()?,
        kind: AllowanceKind::CountRemaining,
        value: Nullable::some(Real::from_f64(remaining).ok()?),
        unit: Nullable::some(AllowanceUnit::Requests),
        capacity: Nullable(capacity.and_then(|value| Real::from_f64(value).ok())),
        window_minutes: Nullable(window_minutes.and_then(|minutes| WindowMinutes::new(minutes).ok())),
        window_started_at: Nullable::NULL,
        resets_at: Nullable(resets_at),
        reader,
        raw_window_id: Nullable::some(Text::truncated(raw_window_id).ok()?),
    }))
}

#[allow(clippy::too_many_arguments)]
pub fn percent_reading(
    binding: &Uuid,
    adapter: Adapter,
    channel: Channel,
    reader: Reader,
    parser_version: &str,
    meter_key: &str,
    label: &str,
    used_percent: f64,
    window_minutes: u64,
    observed_at: Stamp,
    resets_at: Stamp,
    raw_window_id: &str,
) -> Option<Record> {
    if !(0.0..=100.0).contains(&used_percent) {
        return None;
    }
    let used = serde_json::Number::from_f64(used_percent)?;
    let locator = format!("{}:{}:{}", reader.as_str(), meter_key, observed_at.as_str());
    Some(Record::AllowanceReading(AllowanceReading {
        record_id: record_id(binding, channel, &locator),
        binding_id: binding.clone(),
        adapter,
        channel,
        observed_at,
        basis: Basis::Reported,
        parser_version: parser_text(parser_version)?,
        meter_key: MeterKey::try_from(meter_key.to_owned()).ok()?,
        label: Text::truncated(label).ok()?,
        kind: AllowanceKind::PercentUsed,
        value: Nullable::some(Real::try_from(used).ok()?),
        unit: Nullable::some(AllowanceUnit::Percent),
        capacity: Nullable::NULL,
        window_minutes: Nullable::some(WindowMinutes::new(window_minutes).ok()?),
        window_started_at: Nullable::NULL,
        resets_at: Nullable::some(resets_at),
        reader,
        raw_window_id: Nullable::some(Text::truncated(raw_window_id).ok()?),
    }))
}

#[allow(clippy::too_many_arguments)]
pub fn unlimited_reading(
    binding: &Uuid,
    adapter: Adapter,
    channel: Channel,
    reader: Reader,
    parser_version: &str,
    meter_key: &str,
    label: &str,
    observed_at: Stamp,
    raw_window_id: Option<&str>,
) -> Option<Record> {
    let locator = format!("{}:{}:{}", reader.as_str(), meter_key, observed_at.as_str());
    Some(Record::AllowanceReading(AllowanceReading {
        record_id: record_id(binding, channel, &locator),
        binding_id: binding.clone(),
        adapter,
        channel,
        observed_at,
        basis: Basis::Reported,
        parser_version: parser_text(parser_version)?,
        meter_key: MeterKey::try_from(meter_key.to_owned()).ok()?,
        label: Text::truncated(label).ok()?,
        kind: AllowanceKind::Unlimited,
        value: Nullable::NULL,
        unit: Nullable::NULL,
        capacity: Nullable::NULL,
        window_minutes: Nullable::NULL,
        window_started_at: Nullable::NULL,
        resets_at: Nullable::NULL,
        reader,
        raw_window_id: text120(raw_window_id),
    }))
}

pub fn hour_stamp(seconds: i64) -> Option<Stamp> {
    iso(hour_floor(seconds as f64) as f64)
}

pub fn add_seconds(stamp: &Stamp, seconds: i64) -> Option<Stamp> {
    iso(stamp.epoch_seconds().saturating_add(seconds) as f64)
}

pub fn lookback_start(now_seconds: i64, days: u64) -> i64 {
    now_seconds.saturating_sub(i64::try_from(days.saturating_mul(86_400)).unwrap_or(i64::MAX)).max(0)
}

pub fn overlap_seconds(bucket_seconds: i64) -> i64 {
    bucket_seconds.saturating_mul(2)
}

pub fn dimensions(
    model: Option<&str>,
    product: Option<&str>,
    user: Option<&str>,
    workspace: Option<&str>,
    api_key: Option<&str>,
    pricing: Option<PricingEvidence>,
) -> Dimensions {
    Dimensions {
        model: model_opt(model),
        product: code_opt(product),
        client: Nullable::NULL,
        user_ref: hashed_ref_opt("user", user),
        workspace_ref: hashed_ref_opt("workspace", workspace),
        api_key_ref: hashed_ref_opt("api_key", api_key),
        pricing,
    }
}

pub fn measures(
    requests: Option<u64>,
    input_fresh: Option<u64>,
    cached: Option<u64>,
    cache_write: Option<u64>,
    output: Option<u64>,
    reasoning: Option<u64>,
    total: Option<u64>,
) -> Measures {
    Measures {
        requests: counter_opt(requests),
        input_tokens: counter_opt(input_fresh),
        cached_tokens: counter_opt(cached),
        cache_write_tokens: counter_opt(cache_write),
        output_tokens: counter_opt(output),
        reasoning_tokens: counter_opt(reasoning),
        total_tokens: counter_opt(total),
    }
}

pub fn exclusive_tokens(
    input: Option<u64>,
    cached: Option<u64>,
    cache_write: Option<u64>,
    output: Option<u64>,
) -> (Option<u64>, Option<u64>, Option<u64>, Option<u64>) {
    (exclusive_fresh(input, cached), cached, cache_write, output)
}

pub fn provider_client(ctx: &RunContext) -> ProviderClient {
    let timeout = ctx.remaining().clamp(Duration::from_secs(1), Duration::from_secs(30));
    ProviderClient::new(timeout)
}

pub fn admin_key(ctx: &RunContext, anthropic: bool) -> Result<Secret, AdapterError> {
    match Secrets::load(ctx.secrets_dir()) {
        Ok(Some(secrets)) => {
            let key = if anthropic { secrets.anthropic_admin_key } else { secrets.openai_admin_key };
            key.filter(|value| !value.is_empty())
                .ok_or(AdapterError::Credential(DetailCode::CredentialMissing))
        }
        Ok(None) => Err(AdapterError::Credential(DetailCode::CredentialMissing)),
        Err(_) => Err(AdapterError::Io),
    }
}

pub fn credential_error(error: CredentialError) -> AdapterError {
    error.adapter_error()
}

pub fn confirmed_binding<'a>(
    bindings: impl Iterator<Item = &'a BindingContext>,
    local_hash: Option<&Sha256Hex>,
) -> Option<&'a BindingContext> {
    let hash = local_hash?;
    let matches: Vec<&'a BindingContext> = bindings
        .filter(|binding| {
            binding.enabled
                && !binding.identity_conflict
                && binding.identity == IdentityState::Confirmed
                && binding.identity_hash.as_ref() == Some(hash)
        })
        .collect();
    match matches.as_slice() {
        [one] => Some(*one),
        _ => None,
    }
}

pub fn observed_now(ctx: &RunContext) -> Stamp {
    Stamp::from_timestamp(ctx.now)
}

pub fn allowance_row(state: CapabilityState, detail: Option<&str>) -> CapabilityCoverage {
    CapabilityCoverage {
        dimension: CapabilityDimension::Allowance,
        state,
        detail_code: Nullable(detail.and_then(|value| Code::try_from(value.to_owned()).ok())),
    }
}

pub fn utilization_percent(value: f64) -> Option<f64> {
    let percent = if (0.0..=1.0).contains(&value) { value * 100.0 } else { value };
    (0.0..=100.0).contains(&percent).then_some(percent)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PageCursor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_through: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_page: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_through: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_page: Option<String>,
}

impl PageCursor {
    pub fn parse(cursor: Option<&Cursor>) -> Self {
        cursor.and_then(|cursor| serde_json::from_str(&cursor.0).ok()).unwrap_or_default()
    }

    pub fn encode(&self) -> Option<Cursor> {
        serde_json::to_string(self).ok().map(Cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashed_refs_are_stable_json_pairs() {
        assert_eq!(hashed_ref("workspace", "wrkspc_1"), Sha256Hex::digest(br#"["workspace","wrkspc_1"]"#));
        assert!(hashed_ref_opt("user", None).as_ref().is_none());
    }

    #[test]
    fn usd_formatting_matches_the_amount_pattern() {
        assert_eq!(usd_from_cents(4.0).unwrap().as_str(), "0.04");
        assert_eq!(usd_from_f64(1.23).unwrap().as_str(), "1.23");
    }
}
