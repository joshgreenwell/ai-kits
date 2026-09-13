//! `allowance.reading` records from the local allowance slots: the embedded
//! Codex rate limits (reader `embedded`) and the Claude Code statusline inbox
//! (reader `statusline`). Meter keys equal the v1 `window_key`; model-scoped
//! weekly windows (`seven_day_<model>`) are accepted beside the pooled ones.

use observatory_contract::records::WindowMinutes;
use observatory_contract::{
    Adapter, AllowanceKind, AllowanceReading, AllowanceUnit, Basis, Channel, MeterKey, Nullable, Reader,
    Real, Record, Stamp, Text, Uuid,
};
use observatory_core::adapter::{BindingContext, RunContext, Sink, record_id};
use observatory_core::inbox::{read_statusline_files, window_minutes};
use observatory_core::pyjson::{digest, epoch};
use observatory_core::state::State;
use serde_json::{Value, json};

/// Builds a reading from a stored slot payload (the v1 quota item plus `raw_window_id`).
pub fn reading_from_slot(
    binding: &Uuid,
    adapter: Adapter,
    channel: Channel,
    reader: Reader,
    parser_version: &str,
    payload: &Value,
) -> Option<Record> {
    let window_key = payload.get("window_key")?.as_str()?;
    let label = payload.get("label")?.as_str()?;
    let observed_at = Stamp::parse(payload.get("observed_at")?.as_str()?).ok()?;
    let resets_at = Stamp::parse(payload.get("resets_at")?.as_str()?).ok()?;
    let used = payload.get("used_percent")?.as_number()?.clone();
    let minutes = payload.get("window_minutes")?.as_u64()?;
    let raw_window_id = payload.get("raw_window_id").and_then(Value::as_str).unwrap_or(window_key);
    let locator = format!("{}:{}:{}", reader.as_str(), window_key, observed_at.as_str());
    Some(Record::AllowanceReading(AllowanceReading {
        record_id: record_id(binding, channel, &locator),
        binding_id: binding.clone(),
        adapter,
        channel,
        observed_at,
        basis: Basis::Reported,
        parser_version: Text::truncated(parser_version).ok()?,
        meter_key: MeterKey::try_from(window_key.to_owned()).ok()?,
        label: Text::truncated(label).ok()?,
        kind: AllowanceKind::PercentUsed,
        value: Nullable::some(Real::try_from(used).ok()?),
        unit: Nullable::some(AllowanceUnit::Percent),
        capacity: Nullable::NULL,
        window_minutes: Nullable::some(WindowMinutes::new(minutes).ok()?),
        window_started_at: Nullable::NULL,
        resets_at: Nullable::some(resets_at),
        reader,
        raw_window_id: Nullable::some(Text::truncated(raw_window_id).ok()?),
    }))
}

/// Emits every dirty slot of a binding as a reading and clears the mark.
/// Returns the number emitted.
pub fn emit_dirty_slots(
    state: &State,
    binding: &BindingContext,
    adapter: Adapter,
    channel: Channel,
    reader: Reader,
    parser_version: &str,
    sink: &mut dyn Sink,
) -> Result<u64, observatory_core::adapter::AdapterError> {
    let mut emitted = 0;
    for (slot, payload) in state.dirty_allowance_slots(binding.binding_id.as_str())? {
        let value: Value = match serde_json::from_str(&payload) {
            Ok(value) => value,
            Err(_) => {
                state.clear_allowance_dirty(binding.binding_id.as_str(), &slot)?;
                continue;
            }
        };
        if let Some(record) =
            reading_from_slot(&binding.binding_id, adapter, channel, reader, parser_version, &value)
        {
            sink.emit(record, Some(value));
            emitted += 1;
        }
        state.clear_allowance_dirty(binding.binding_id.as_str(), &slot)?;
    }
    Ok(emitted)
}

/// Reads the Claude Code statusline inbox as `collect.py` does, extended to the
/// model-scoped weekly windows: accepts samples whose key is a recognized window,
/// in range and inside the backfill window, keyed by the digest of the six
/// whitelisted fields, inserted once. Returns the number of malformed files.
pub fn ingest_statusline_inbox(
    state: &State,
    ctx: &RunContext,
    binding: &BindingContext,
) -> Result<u64, observatory_core::adapter::AdapterError> {
    let mut malformed = 0;
    for file in read_statusline_files(&ctx.statusline_inbox) {
        let Ok(Value::Array(samples)) = file else {
            malformed += 1;
            continue;
        };
        for sample in samples {
            let Some(q) = sample.as_object() else {
                malformed += 1;
                break;
            };
            let window_key = q.get("window_key").and_then(Value::as_str);
            if window_key.is_none_or(|key| window_minutes(key).is_none()) {
                continue;
            }
            let Some(used) = q.get("used_percent").and_then(|v| match v {
                Value::Number(n) => n.as_f64(),
                _ => None,
            }) else {
                continue;
            };
            if !(0.0..=100.0).contains(&used) {
                continue;
            }
            let observed = epoch(q.get("observed_at"));
            let reset = epoch(q.get("resets_at"));
            let (Some(observed), Some(reset)) = (observed, reset) else { continue };
            if observed < ctx.since || observed > ctx.now_seconds + 300.0 || reset <= observed {
                continue;
            }
            let keys = ["window_key", "label", "observed_at", "used_percent", "resets_at", "window_minutes"];
            let mut safe = serde_json::Map::new();
            let mut complete = true;
            for key in keys {
                match q.get(key) {
                    Some(value) => {
                        safe.insert(key.to_owned(), value.clone());
                    }
                    None => complete = false,
                }
            }
            if !complete {
                malformed += 1;
                break;
            }
            let mut stored = Value::Object(safe.clone());
            if let Value::Object(map) = &mut stored {
                map.insert("raw_window_id".to_owned(), Value::String(window_key.unwrap_or("").to_owned()));
            }
            let slot = digest(&Value::Object(safe)).as_str().to_owned();
            state.insert_allowance_slot_if_absent(binding.binding_id.as_str(), &slot, &stored.to_string())?;
        }
    }
    Ok(malformed)
}

/// The v1 quota item shape, for tests and snapshots.
pub fn slot_item(
    window_key: &str,
    label: &str,
    observed_at: &str,
    used: f64,
    resets_at: &str,
    minutes: u64,
) -> Value {
    json!({"window_key": window_key, "label": label, "observed_at": observed_at, "used_percent": used,
        "resets_at": resets_at, "window_minutes": minutes})
}
