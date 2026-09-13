//! The local inboxes that hooks write and adapters read.
//!
//! The Claude Code statusline hook writes one sample file per UTC hour, atomically
//! and `0600`, plus a status sidecar beside the inbox (never inside it, so the
//! reader never parses it as a sample). Tool hook receivers append one line per
//! invocation. No cwd, session id, transcript path, or prompt is retained.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::paths::{ensure_private_dir, write_private};

pub const STATUS_SIDECAR: &str = "claude-statusline-status.json";

/// The two pooled windows v1 recognized, with their minutes.
pub const WINDOWS: [(&str, u64); 2] = [("five_hour", 300), ("seven_day", 10080)];

/// The window length of a Claude allowance key: the pooled five-hour and weekly
/// windows, plus every model-scoped weekly window (`seven_day_<model slug>`),
/// which the provider caps separately from the shared weekly allowance.
pub fn window_minutes(key: &str) -> Option<u64> {
    if key == "five_hour" {
        Some(300)
    } else if key == "seven_day" || (key.starts_with("seven_day_") && key.len() > "seven_day_".len()) {
        Some(10080)
    } else {
        None
    }
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

/// The label a window carries: the v1 labels for the pooled windows, and
/// `Claude · weekly · <Model>` for a model-scoped window.
pub fn window_label(key: &str) -> String {
    match key {
        "five_hour" => "Claude · 5h".to_owned(),
        "seven_day" => "Claude · weekly".to_owned(),
        scoped => format!("Claude · weekly · {}", title_case(scoped.trim_start_matches("seven_day_"))),
    }
}

/// A statusline sample in the v1 inbox shape, which `collect.py` also reads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatuslineSample {
    pub window_key: String,
    pub label: String,
    pub observed_at: String,
    pub used_percent: serde_json::Number,
    pub resets_at: String,
    pub window_minutes: u64,
}

/// Python `datetime.isoformat()` for a UTC instant with `+00:00` replaced by `Z`:
/// microseconds are written only when non-zero.
pub fn py_isoformat(at: Timestamp) -> String {
    let zoned = at.to_zoned(TimeZone::UTC);
    let date = zoned.date();
    let time = zoned.time();
    let micros = time.subsec_nanosecond() / 1000;
    let mut text = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        date.year(),
        date.month(),
        date.day(),
        time.hour(),
        time.minute(),
        time.second()
    );
    if micros != 0 {
        text.push_str(&format!(".{micros:06}"));
    }
    text.push('Z');
    text
}

/// The file name for the current UTC hour: `YYYY-MM-DDTHH.json`.
pub fn hour_file_name(at: Timestamp) -> String {
    let zoned = at.to_zoned(TimeZone::UTC);
    format!("{:04}-{:02}-{:02}T{:02}.json", zoned.year(), zoned.month(), zoned.day(), zoned.hour())
}

/// Extracts valid samples from the statusline JSON: every recognized window key
/// (see `window_minutes`) whose `used_percentage` is in range and whose reset is
/// in the future, in key order.
pub fn samples_from_statusline(data: &Value, now: Timestamp) -> Vec<StatuslineSample> {
    let limits = match data.get("rate_limits") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let now_seconds = now.as_microsecond() as f64 / 1e6;
    let mut samples = Vec::new();
    for (key, value) in &limits {
        let Some(minutes) = window_minutes(key) else { continue };
        let Value::Object(window) = value else { continue };
        let used = window.get("used_percentage").and_then(Value::as_number);
        let reset = window.get("resets_at").and_then(Value::as_f64);
        let (Some(used), Some(reset)) = (used, reset) else { continue };
        let percent = used.as_f64().unwrap_or(-1.0);
        // The reset must lie inside the window (plus a day of slack); anything else is a
        // bad clock or a hand-written payload and would pin the forecast for weeks.
        if !(0.0..=100.0).contains(&percent)
            || reset <= now_seconds
            || reset > now_seconds + (minutes * 60 + 86_400) as f64
        {
            continue;
        }
        let Some(resets_at) = crate::pyjson::iso(reset) else { continue };
        samples.push(StatuslineSample {
            window_key: key.clone(),
            label: window_label(key),
            observed_at: py_isoformat(now),
            used_percent: used.clone(),
            resets_at: py_isoformat(resets_at.timestamp()),
            window_minutes: minutes,
        });
    }
    samples
}

/// The one-line summary the statusline prints.
pub fn summary_line(samples: &[StatuslineSample]) -> String {
    if samples.is_empty() {
        return "Claude".to_owned();
    }
    samples
        .iter()
        .map(|sample| {
            format!("{} {:.0}% left", sample.label, 100.0 - sample.used_percent.as_f64().unwrap_or(0.0))
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Writes the hour's samples atomically. Returns the file written.
pub fn write_statusline_samples(
    inbox: &Path,
    samples: &[StatuslineSample],
    now: Timestamp,
) -> io::Result<PathBuf> {
    let target = inbox.join(hour_file_name(now));
    let text = serde_json::to_vec(samples).map_err(|_| io::Error::other("serialize"))?;
    write_private(&target, &text)?;
    Ok(target)
}

/// Records that the hook ran and which windows Claude offered it, without any
/// session field. Sits beside the inbox, not inside it.
pub fn record_statusline_status(
    inbox: &Path,
    data: &Value,
    published: &[StatuslineSample],
    now: Timestamp,
) -> io::Result<()> {
    let parent = inbox.parent().unwrap_or(inbox);
    let target = parent.join(STATUS_SIDECAR);
    let previous: Map<String, Value> = fs::read(&target)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();
    let stamp = py_isoformat(now);
    let limits = match data.get("rate_limits") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let mut keys: Vec<&String> = limits.keys().collect();
    keys.sort();
    let offered: Map<String, Value> = limits
        .iter()
        .filter(|(key, value)| window_minutes(key).is_some() && value.is_object())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let invocations = previous.get("invocations").and_then(Value::as_u64).unwrap_or(0) + 1;
    let mut status = Map::new();
    status.insert("last_invocation_at".into(), Value::String(stamp.clone()));
    status.insert("invocations".into(), Value::from(invocations));
    status.insert("claude_code_version".into(), data.get("version").cloned().unwrap_or(Value::Null));
    status.insert("entrypoint".into(), data.get("entrypoint").cloned().unwrap_or(Value::Null));
    status.insert(
        "rate_limits_present".into(),
        Value::Bool(data.get("rate_limits").is_some_and(Value::is_object)),
    );
    status.insert(
        "rate_limit_keys".into(),
        Value::Array(keys.into_iter().map(|k| Value::String(k.clone())).collect()),
    );
    status.insert("offered_windows".into(), Value::Object(offered));
    status.insert(
        "published_windows".into(),
        Value::Array(published.iter().map(|s| Value::String(s.window_key.clone())).collect()),
    );
    status.insert(
        "last_published_at".into(),
        if published.is_empty() {
            previous.get("last_published_at").cloned().unwrap_or(Value::Null)
        } else {
            Value::String(stamp)
        },
    );
    let text =
        serde_json::to_vec_pretty(&Value::Object(status)).map_err(|_| io::Error::other("serialize"))?;
    write_private(&target, &text)
}

/// Every `*.json` file directly inside the inbox, parsed. An unreadable or
/// unparsable file is `Err(())`, which the reader counts as malformed.
pub fn read_statusline_files(inbox: &Path) -> Vec<Result<Value, ()>> {
    let Ok(entries) = fs::read_dir(inbox) else { return Vec::new() };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json") && path.is_file())
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            fs::read(&path).map_err(|_| ()).and_then(|bytes| serde_json::from_slice(&bytes).map_err(|_| ()))
        })
        .collect()
}

/// Removes sample files older than the given number of days by their hour name.
pub fn prune_statusline_files(inbox: &Path, now: Timestamp, keep_days: i64) -> usize {
    let Ok(entries) = fs::read_dir(inbox) else { return 0 };
    let cutoff = now.as_second() - keep_days * 86_400;
    let cutoff_name = hour_file_name(Timestamp::from_second(cutoff).unwrap_or(now));
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.extension().is_some_and(|ext| ext == "json")
            && name < cutoff_name.as_str()
            && fs::remove_file(&path).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

/// One tool hook invocation, reduced to the fields the companion keeps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookEvent {
    pub observed_at: String,
    pub provider: String,
    pub event: String,
    pub tool: Option<String>,
    /// `sha256(session id)`, for local correlation only.
    pub session_hash: Option<String>,
}

/// Appends one line to `<dir>/<provider>-<YYYY-MM-DDTHH>.jsonl`.
pub fn append_hook_event(dir: &Path, event: &HookEvent, now: Timestamp) -> io::Result<()> {
    ensure_private_dir(dir)?;
    let name = format!("{}-{}", event.provider, hour_file_name(now).replace(".json", ".jsonl"));
    let path = dir.join(name);
    let created = !path.exists();
    let mut file = fs::OpenOptions::new().append(true).create(true).open(&path)?;
    let mut line = serde_json::to_vec(event).map_err(|_| io::Error::other("serialize"))?;
    line.push(b'\n');
    file.write_all(&line)?;
    if created {
        crate::state::restrict_file(&path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn statusline_samples_match_python_and_accept_scoped_weekly_windows() {
        let now = Timestamp::from_second(1_788_310_800).unwrap();
        let data = json!({"rate_limits": {"five_hour": {"used_percentage": 20, "resets_at": 1_788_314_400},
            "seven_day": {"used_percentage": 120, "resets_at": 1_788_400_000},
            "seven_day_fable": {"used_percentage": 51.5, "resets_at": 1_788_400_000},
            "seven_day_far": {"used_percentage": 10, "resets_at": 4_102_444_800_u64},
            "spend": {"used_percentage": 1}}, "version": "2.0.0"});
        let samples = samples_from_statusline(&data, now);
        assert_eq!(
            samples.iter().map(|s| s.window_key.as_str()).collect::<Vec<_>>(),
            ["five_hour", "seven_day_fable"]
        );
        assert_eq!(samples[0].label, "Claude · 5h");
        assert_eq!(samples[1].label, "Claude · weekly · Fable");
        assert_eq!(samples[1].window_minutes, 10080);
        assert_eq!(samples[0].observed_at, "2026-09-02T01:00:00Z");
        assert_eq!(samples[0].resets_at, "2026-09-02T02:00:00Z");
        assert_eq!(summary_line(&samples), "Claude · 5h 80% left · Claude · weekly · Fable 48% left");
        assert_eq!(summary_line(&[]), "Claude");
        assert_eq!(window_label("seven_day_claude_opus_4_1"), "Claude · weekly · Claude Opus 4 1");
        assert_eq!(window_minutes("seven_day_"), None);
        assert_eq!(window_minutes("spend"), None);
        assert_eq!(
            py_isoformat(Timestamp::from_microsecond(1_788_310_800_123_456).unwrap()),
            "2026-09-02T01:00:00.123456Z"
        );
        assert_eq!(hour_file_name(now), "2026-09-02T01.json");

        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("inbox").join("claude-statusline");
        write_statusline_samples(&inbox, &samples, now).unwrap();
        record_statusline_status(&inbox, &data, &samples, now).unwrap();
        record_statusline_status(&inbox, &data, &[], now).unwrap();
        let files = read_statusline_files(&inbox);
        assert_eq!(files.len(), 1);
        let status: Value =
            serde_json::from_slice(&fs::read(inbox.parent().unwrap().join(STATUS_SIDECAR)).unwrap()).unwrap();
        assert_eq!(status["invocations"], 2);
        assert_eq!(status["last_published_at"], "2026-09-02T01:00:00Z");
        assert_eq!(
            status["rate_limit_keys"],
            json!(["five_hour", "seven_day", "seven_day_fable", "seven_day_far", "spend"])
        );
        assert!(status["offered_windows"].get("seven_day_fable").is_some());
        assert!(status["offered_windows"].get("spend").is_none());
        assert!(status.get("cwd").is_none());
    }

    #[test]
    fn hook_events_append() {
        let dir = tempfile::tempdir().unwrap();
        let now = Timestamp::from_second(1_788_310_800).unwrap();
        let event = HookEvent {
            observed_at: "x".into(),
            provider: "claude".into(),
            event: "PostToolUse".into(),
            tool: Some("Read".into()),
            session_hash: None,
        };
        append_hook_event(dir.path(), &event, now).unwrap();
        append_hook_event(dir.path(), &event, now).unwrap();
        let text = fs::read_to_string(dir.path().join("claude-2026-09-02T01.jsonl")).unwrap();
        assert_eq!(text.lines().count(), 2);
    }
}
