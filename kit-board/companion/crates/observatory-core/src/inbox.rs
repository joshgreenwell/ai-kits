//! The local inboxes that hooks write and adapters read.
//!
//! The Claude Code statusline hook writes one part file per changed reading
//! (`<YYYY-MM-DDTHH>-<observed microseconds>.json`, atomically and `0600`), so
//! concurrent sessions never share a file, plus three files beside the inbox
//! (never inside it, so neither the reader nor v1 `collect.py` parses them as
//! samples): the status sidecar, the kept-state file that tells a changed
//! reading from a repeat, and the identity cache. Tool hook receivers append
//! one line per invocation. No cwd, session id, transcript path, or prompt is
//! retained.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use observatory_contract::Adapter;
use observatory_contract::settings::{Gate, denied};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::discovery::claude_identity_from;
use crate::paths::{ensure_private_dir, mtime_ns, write_private};

pub const STATUS_SIDECAR: &str = "claude-statusline-status.json";

/// The last sample the hook kept per identity stamp and window, beside the inbox.
pub const LATEST_STATE: &str = "claude-statusline-latest.json";

/// The hook's cached identity evidence per Claude config file, in the
/// configuration directory.
pub const IDENTITY_CACHE: &str = "claude-identity-cache.json";

/// The statusline reader's own mode path. Under `allowance.claude_reader =
/// oauth_usage` the server gate names the OAuth reader while the statusline
/// still runs as the documented fallback, so a local deny of the statusline is
/// matched against this path as well.
pub const STATUSLINE_MODE_PATH: &str = "allowance.claude_reader.statusline";
pub const OAUTH_USAGE_MODE_PATH: &str = "allowance.claude_reader.oauth_usage";

/// True when a local deny-list entry removes the statusline reader whichever
/// reader the server selects: the adapter id, `providers.claude`, the exact
/// path, or a dotted prefix of it (`allowance.claude_reader`).
pub fn statusline_reader_denied(deny: &[String]) -> bool {
    let gate = Gate { enabled: true, provider_enabled: true, mode_path: STATUSLINE_MODE_PATH.to_owned() };
    deny.iter().any(|entry| denied(entry, Adapter::ClaudeAccount, &gate))
}

/// True when a local deny-list entry removes the OAuth usage reader whichever
/// reader the server selects.
pub fn oauth_usage_reader_denied(deny: &[String]) -> bool {
    let gate = Gate { enabled: true, provider_enabled: true, mode_path: OAUTH_USAGE_MODE_PATH.to_owned() };
    deny.iter().any(|entry| denied(entry, Adapter::ClaudeAccount, &gate))
}

/// An unchanged reading is written again after this long, so an idle meter
/// still proves the hook runs.
pub const HEARTBEAT_MINUTES: i64 = 15;

/// The largest Claude config file the hook parses; a bigger one is a runaway
/// history, not a sign-in record.
const CLAUDE_CONFIG_LIMIT: u64 = 8 * 1024 * 1024;

/// The two pooled windows v1 recognized, with their minutes.
pub const WINDOWS: [(&str, u64); 2] = [("five_hour", 300), ("seven_day", 10080)];

/// The age past which the newest allowance reading counts as stale, the same
/// rule the Observatory applies: two missed cadences plus a margin, never
/// under two hours, so an hourly reader survives one missed run.
pub fn stale_after_minutes(cadence_minutes: u64) -> u64 {
    (2 * cadence_minutes + 15).max(120)
}

/// The window length of a Claude allowance key: the pooled five-hour and weekly
/// windows, plus every model-scoped weekly window (`seven_day_<model slug>`),
/// which the provider caps separately from the shared weekly allowance.
pub fn window_minutes(key: &str) -> Option<u64> {
    if key == "five_hour" {
        Some(300)
    } else if key == "seven_day"
        || key == "extra_usage"
        || (key.starts_with("seven_day_") && key.len() > "seven_day_".len())
    {
        Some(10080)
    } else {
        None
    }
}

/// Slug a display name the way the browser quota normalizer does: lowercase,
/// non-alphanumerics to underscores, edges trimmed.
pub fn window_slug(value: &str) -> String {
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
        "extra_usage" => "Claude · extra usage".to_owned(),
        scoped => format!("Claude · weekly · {}", title_case(scoped.trim_start_matches("seven_day_"))),
    }
}

/// A statusline sample in the v1 inbox shape, which `collect.py` also reads,
/// plus the identity stamp: the hash of the account signed in when the hook
/// observed the reading. v1 ignores the stamp, and the slot digest excludes it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatuslineSample {
    pub window_key: String,
    pub label: String,
    pub observed_at: String,
    pub used_percent: serde_json::Number,
    pub resets_at: String,
    pub window_minutes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_hash: Option<String>,
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

/// The UTC hour prefix of a file name: `YYYY-MM-DDTHH`.
pub fn hour_prefix(at: Timestamp) -> String {
    let zoned = at.to_zoned(TimeZone::UTC);
    format!("{:04}-{:02}-{:02}T{:02}", zoned.year(), zoned.month(), zoned.day(), zoned.hour())
}

/// The file name for the current UTC hour: `YYYY-MM-DDTHH.json` (the v1 hour
/// file; still read, no longer written).
pub fn hour_file_name(at: Timestamp) -> String {
    format!("{}.json", hour_prefix(at))
}

/// The file name of one hook write: the hour prefix plus the observation's
/// microsecond timestamp, so sessions writing in the same hour never collide.
pub fn part_file_name(at: Timestamp) -> String {
    format!("{}-{}.json", hour_prefix(at), at.as_microsecond())
}

/// Whether a file name starts with an hour prefix (`YYYY-MM-DDTHH`).
fn has_hour_prefix(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() >= 13
        && bytes.iter().take(13).enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            10 => *byte == b'T',
            _ => byte.is_ascii_digit(),
        })
}

/// Extracts valid samples from the statusline JSON: every recognized window key
/// (see `window_minutes`) whose used percentage is in range and whose reset is
/// in the future, in encounter order. A top-level `limits` array (the shape
/// Claude Code uses for model-scoped weekly windows) wins over a duplicate key
/// in `rate_limits`. Samples come back unstamped.
pub fn samples_from_statusline(data: &Value, now: Timestamp) -> Vec<StatuslineSample> {
    let now_seconds = now.as_microsecond() as f64 / 1e6;
    let mut samples = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for sample in samples_from_limits_array(data.get("limits"), now, now_seconds) {
        if seen.insert(sample.window_key.clone()) {
            samples.push(sample);
        }
    }
    let empty = Map::new();
    let limits = match data.get("rate_limits") {
        Some(Value::Object(map)) => map,
        _ => &empty,
    };
    for (key, value) in limits {
        if seen.contains(key) {
            continue;
        }
        let Some(minutes) = window_minutes(key) else { continue };
        let Value::Object(window) = value else { continue };
        let Some(used) = window_used_percent(window) else { continue };
        let Some(reset) = reset_unix(window.get("resets_at")) else { continue };
        if let Some(sample) = sample_if_current(key, used, reset, minutes, now, now_seconds) {
            seen.insert(key.clone());
            samples.push(sample);
        }
    }
    if !seen.contains("extra_usage") {
        if let Some(weekly) = samples.iter().find(|sample| sample.window_key == "seven_day").cloned() {
            if let Some(sample) = extra_usage_sample(data.get("extra_usage"), &weekly, now, now_seconds) {
                samples.push(sample);
            }
        }
    }
    samples
}

fn samples_from_limits_array(
    limits: Option<&Value>,
    now: Timestamp,
    now_seconds: f64,
) -> Vec<StatuslineSample> {
    let Some(items) = limits.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut samples = Vec::new();
    for row in items {
        let Some(obj) = row.as_object() else { continue };
        let Some(key) = limit_row_key(obj) else { continue };
        let Some(minutes) = window_minutes(&key) else { continue };
        let Some(used) = window_used_percent(obj).or_else(|| {
            serde_json::Number::from_f64(number_in_percent_range(obj.get("percent").and_then(Value::as_f64))?)
        }) else {
            continue;
        };
        let Some(reset) = reset_unix(obj.get("resets_at")).or_else(|| reset_unix(obj.get("resetsAt"))) else {
            continue;
        };
        if let Some(sample) = sample_if_current(&key, used, reset, minutes, now, now_seconds) {
            samples.push(sample);
        }
    }
    samples
}

fn limit_row_key(row: &Map<String, Value>) -> Option<String> {
    match row.get("kind").and_then(Value::as_str).unwrap_or("") {
        "session" => Some("five_hour".to_owned()),
        "weekly_all" => Some("seven_day".to_owned()),
        "weekly_scoped" => {
            let name = scoped_window_name(row.get("scope"))?;
            let slug = window_slug(&name);
            (!slug.is_empty()).then(|| format!("seven_day_{slug}"))
        }
        _ => None,
    }
}

fn scoped_window_name(scope: Option<&Value>) -> Option<String> {
    let scope = scope?.as_object()?;
    if let Some(model) = scope.get("model") {
        if let Some(name) = model.get("display_name").or(model.get("id")).and_then(Value::as_str) {
            return Some(name.to_owned());
        }
    }
    match scope.get("surface") {
        Some(Value::String(name)) => Some(name.clone()),
        Some(Value::Object(surface)) => {
            surface.get("display_name").or(surface.get("id")).and_then(Value::as_str).map(str::to_owned)
        }
        _ => None,
    }
}

fn extra_usage_sample(
    extra: Option<&Value>,
    weekly: &StatuslineSample,
    now: Timestamp,
    now_seconds: f64,
) -> Option<StatuslineSample> {
    let extra = extra?.as_object()?;
    if extra.get("is_enabled").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let used = window_used_percent(extra)?;
    let reset = reset_unix(extra.get("resets_at"))
        .or_else(|| Timestamp::from_str(&weekly.resets_at).ok().map(|at| at.as_microsecond() as f64 / 1e6))?;
    sample_if_current("extra_usage", used, reset, weekly.window_minutes, now, now_seconds)
}

fn sample_if_current(
    key: &str,
    used: serde_json::Number,
    reset: f64,
    minutes: u64,
    now: Timestamp,
    now_seconds: f64,
) -> Option<StatuslineSample> {
    let percent = used.as_f64().unwrap_or(-1.0);
    // The reset must lie inside the window (plus a day of slack); anything else is a
    // bad clock or a hand-written payload and would pin the forecast for weeks.
    if !(0.0..=100.0).contains(&percent)
        || reset <= now_seconds
        || reset > now_seconds + (minutes * 60 + 86_400) as f64
    {
        return None;
    }
    let resets_at = crate::pyjson::iso(reset)?;
    Some(StatuslineSample {
        window_key: key.to_owned(),
        label: window_label(key),
        observed_at: py_isoformat(now),
        used_percent: used,
        resets_at: py_isoformat(resets_at.timestamp()),
        window_minutes: minutes,
        identity_hash: None,
    })
}

fn window_used_percent(window: &Map<String, Value>) -> Option<serde_json::Number> {
    if let Some(number) =
        window.get("used_percentage").or(window.get("used_percent")).and_then(Value::as_number)
    {
        return number_in_percent_range(number.as_f64()).map(|_| number.clone());
    }
    let utilization = window.get("utilization").and_then(Value::as_f64)?;
    let percent = if (0.0..=1.0).contains(&utilization) { utilization * 100.0 } else { utilization };
    number_in_percent_range(Some(percent))?;
    serde_json::Number::from_f64(percent)
}

fn number_in_percent_range(value: Option<f64>) -> Option<f64> {
    value.filter(|percent| (0.0..=100.0).contains(percent))
}

fn reset_unix(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => Timestamp::from_str(text).ok().map(|at| at.as_microsecond() as f64 / 1e6),
        _ => None,
    }
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

/// The last sample kept for one window: enough to tell a changed reading from
/// a repeat, and when it was kept, for the heartbeat.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeptSample {
    pub used_percent: serde_json::Number,
    pub resets_at: String,
    pub kept_at: String,
}

/// The kept state by identity stamp (the empty string for an unstamped sample),
/// then by window key, so two Claude profiles (`CLAUDE_CONFIG_DIR`) sharing one
/// companion directory each keep their own change detection.
pub type LatestState = BTreeMap<String, BTreeMap<String, KeptSample>>;

fn latest_state_path(inbox: &Path) -> PathBuf {
    inbox.parent().unwrap_or(inbox).join(LATEST_STATE)
}

/// The kept-state key of a sample: its stamp, or the empty string.
fn kept_identity(sample: &StatuslineSample) -> &str {
    sample.identity_hash.as_deref().unwrap_or("")
}

/// The kept state beside the inbox; empty when absent or unreadable (which costs
/// one duplicate sample, deduplicated by digest at ingest).
pub fn read_latest_state(inbox: &Path) -> LatestState {
    fs::read(latest_state_path(inbox))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// The samples worth writing: each whose `(used_percent, resets_at)` differs from
/// the kept one for its stamp and window, or whose kept one is older than the
/// heartbeat.
pub fn samples_to_write(
    latest: &LatestState,
    samples: &[StatuslineSample],
    now: Timestamp,
) -> Vec<StatuslineSample> {
    let heartbeat_before = now.as_second() - HEARTBEAT_MINUTES * 60;
    samples
        .iter()
        .filter(|sample| {
            match latest.get(kept_identity(sample)).and_then(|windows| windows.get(&sample.window_key)) {
                Some(kept) => {
                    kept.used_percent != sample.used_percent
                        || kept.resets_at != sample.resets_at
                        || crate::pyjson::epoch_text(&kept.kept_at)
                            .is_none_or(|at| at < heartbeat_before as f64)
                }
                None => true,
            }
        })
        .cloned()
        .collect()
}

/// What one hook invocation wrote.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StatuslineWrite {
    /// The part file, when at least one sample changed.
    pub part_file: Option<PathBuf>,
    /// The samples in it.
    pub samples: Vec<StatuslineSample>,
}

/// Writes the changed samples as one part file and updates the kept state.
/// Nothing is written when every window repeats its kept reading inside the
/// heartbeat. The kept state is written after the part file, so losing it
/// can only cost a duplicate, never a sample.
pub fn write_statusline_samples(
    inbox: &Path,
    samples: &[StatuslineSample],
    now: Timestamp,
) -> io::Result<StatuslineWrite> {
    let mut latest = read_latest_state(inbox);
    let changed = samples_to_write(&latest, samples, now);
    if changed.is_empty() {
        return Ok(StatuslineWrite::default());
    }
    let target = inbox.join(part_file_name(now));
    let text = serde_json::to_vec(&changed).map_err(|_| io::Error::other("serialize"))?;
    write_private(&target, &text)?;
    let kept_at = py_isoformat(now);
    for sample in &changed {
        latest.entry(kept_identity(sample).to_owned()).or_default().insert(
            sample.window_key.clone(),
            KeptSample {
                used_percent: sample.used_percent.clone(),
                resets_at: sample.resets_at.clone(),
                kept_at: kept_at.clone(),
            },
        );
    }
    let state = serde_json::to_vec(&latest).map_err(|_| io::Error::other("serialize"))?;
    write_private(&latest_state_path(inbox), &state)?;
    Ok(StatuslineWrite { part_file: Some(target), samples: changed })
}

/// One Claude config file's cached identity evidence: its `stat` and the hash
/// it named (`null` when signed out).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityCacheEntry {
    pub mtime_ns: i64,
    pub size: u64,
    pub evidence_hash: Option<String>,
}

/// The hook's identity cache, keyed by the resolved config-file path, so
/// sessions alternating between Claude profiles (`CLAUDE_CONFIG_DIR`) both hit
/// the `stat`-only path.
pub type IdentityCache = BTreeMap<String, IdentityCacheEntry>;

/// The identity hash the hook stamps: the account in the Claude config file,
/// read only when the file's `stat` changed since the cache (a hit costs one
/// `stat`). A signed-out file caches `null`; a file over the size limit is not
/// parsed and caches `null`; a file that fails to parse (half-written by Claude
/// Code) yields `None` without touching the cache, so it is read again next time.
pub fn cached_claude_identity(cache_path: &Path, config_file: &Path) -> Option<String> {
    let meta = fs::metadata(config_file).ok()?;
    let path = config_file.to_string_lossy().into_owned();
    let current = IdentityCacheEntry {
        mtime_ns: i64::try_from(mtime_ns(&meta)).unwrap_or(0),
        size: meta.len(),
        evidence_hash: None,
    };
    let mut cache: IdentityCache =
        fs::read(cache_path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    if let Some(cached) = cache.get(&path)
        && cached.mtime_ns == current.mtime_ns
        && cached.size == current.size
    {
        return cached.evidence_hash.clone();
    }
    let evidence_hash = if current.size > CLAUDE_CONFIG_LIMIT {
        None
    } else {
        let bytes = fs::read(config_file).ok()?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        claude_identity_from(&value).map(|identity| identity.evidence_hash.as_str().to_owned())
    };
    cache.insert(path, IdentityCacheEntry { evidence_hash: evidence_hash.clone(), ..current });
    if let Ok(text) = serde_json::to_vec(&cache) {
        let _ = write_private(cache_path, &text);
    }
    evidence_hash
}

/// Records that the hook ran and which windows Claude offered it, without any
/// session field. Sits beside the inbox, not inside it. `published` are the
/// samples written this invocation; the offered windows accumulate for the
/// life of the sidecar so a hook that never sees a meter is distinguishable
/// from one that sees an idle one.
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
    let mut keys: Vec<String> = match data.get("rate_limits") {
        Some(Value::Object(map)) => map.keys().cloned().collect(),
        _ => Vec::new(),
    };
    let mut offered: Map<String, Value> = match data.get("rate_limits") {
        Some(Value::Object(map)) => map
            .iter()
            .filter(|(key, value)| window_minutes(key).is_some() && value.is_object())
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        _ => Map::new(),
    };
    if let Some(items) = data.get("limits").and_then(Value::as_array) {
        for row in items {
            let Some(obj) = row.as_object() else { continue };
            let Some(key) = limit_row_key(obj) else { continue };
            keys.push(key.clone());
            offered.entry(key).or_insert_with(|| Value::Object(obj.clone()));
        }
    }
    keys.sort();
    keys.dedup();
    let mut offered_ever: Vec<String> = previous
        .get("offered_windows_ever")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    offered_ever.extend(offered.keys().cloned());
    offered_ever.sort();
    offered_ever.dedup();
    let invocations = previous.get("invocations").and_then(Value::as_u64).unwrap_or(0) + 1;
    let mut status = Map::new();
    status.insert("last_invocation_at".into(), Value::String(stamp.clone()));
    status.insert("invocations".into(), Value::from(invocations));
    status.insert("claude_code_version".into(), data.get("version").cloned().unwrap_or(Value::Null));
    status.insert("entrypoint".into(), data.get("entrypoint").cloned().unwrap_or(Value::Null));
    status.insert(
        "rate_limits_present".into(),
        Value::Bool(
            data.get("rate_limits").is_some_and(Value::is_object)
                || data.get("limits").is_some_and(Value::is_array),
        ),
    );
    status.insert("rate_limit_keys".into(), Value::Array(keys.into_iter().map(Value::String).collect()));
    status.insert(
        "last_offered_at".into(),
        if offered.is_empty() {
            previous.get("last_offered_at").cloned().unwrap_or(Value::Null)
        } else {
            Value::String(stamp.clone())
        },
    );
    status.insert("offered_windows".into(), Value::Object(offered));
    status.insert(
        "offered_windows_ever".into(),
        Value::Array(offered_ever.into_iter().map(Value::String).collect()),
    );
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

/// The sidecar as the run reads it: the fields that show whether the hook
/// executes and whether Claude ever offered it a meter. A sidecar written by
/// an older hook lacks `offered_windows_ever`, which stays `None` rather than
/// reading as "never offered".
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidecarStatus {
    #[serde(default)]
    pub last_invocation_at: Option<String>,
    #[serde(default)]
    pub invocations: u64,
    #[serde(default)]
    pub last_offered_at: Option<String>,
    #[serde(default)]
    pub offered_windows_ever: Option<Vec<String>>,
    #[serde(default)]
    pub last_published_at: Option<String>,
}

/// Reads the sidecar beside the inbox; `None` when absent or unreadable.
pub fn read_statusline_status(inbox: &Path) -> Option<SidecarStatus> {
    let target = inbox.parent().unwrap_or(inbox).join(STATUS_SIDECAR);
    serde_json::from_slice(&fs::read(target).ok()?).ok()
}

/// Every `*.json` file directly inside the inbox, parsed, with its size. An
/// unreadable or unparsable file is `Err(())`, which the reader counts as malformed.
pub fn read_statusline_files(inbox: &Path) -> Vec<(u64, Result<Value, ()>)> {
    let Ok(entries) = fs::read_dir(inbox) else { return Vec::new() };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json") && path.is_file())
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|path| match fs::read(&path) {
            Ok(bytes) => (bytes.len() as u64, serde_json::from_slice(&bytes).map_err(|_| ())),
            Err(_) => (0, Err(())),
        })
        .collect()
}

/// Removes sample files older than the given number of days by the hour prefix
/// of their names (part files and v1 hour files alike); a file without an hour
/// prefix is left alone.
pub fn prune_statusline_files(inbox: &Path, now: Timestamp, keep_days: i64) -> usize {
    let Ok(entries) = fs::read_dir(inbox) else { return 0 };
    let cutoff = now.as_second() - keep_days * 86_400;
    let cutoff_prefix = hour_prefix(Timestamp::from_second(cutoff).unwrap_or(now));
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.extension().is_some_and(|ext| ext == "json")
            && has_hour_prefix(name)
            && &name[..13] < cutoff_prefix.as_str()
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
    use std::str::FromStr;

    use super::*;
    use serde_json::json;

    fn statusline(five_hour: u64, seven_day: u64) -> Value {
        json!({"rate_limits": {"five_hour": {"used_percentage": five_hour, "resets_at": 1_788_314_400},
            "seven_day": {"used_percentage": seven_day, "resets_at": 1_788_400_000}}, "version": "2.0.0"})
    }

    fn part_files(inbox: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(inbox)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

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
        assert_eq!(samples[0].identity_hash, None);
        assert!(!serde_json::to_string(&samples[0]).unwrap().contains("identity_hash"));
        assert_eq!(summary_line(&samples), "Claude · 5h 80% left · Claude · weekly · Fable 48% left");
        assert_eq!(summary_line(&[]), "Claude");
        assert_eq!(window_label("seven_day_claude_opus_4_1"), "Claude · weekly · Claude Opus 4 1");
        assert_eq!(window_minutes("seven_day_"), None);
        assert_eq!(window_minutes("spend"), None);
        assert_eq!(window_minutes("extra_usage"), Some(10080));
        assert_eq!(window_slug("Fable 5.1"), "fable_5_1");
        assert_eq!(
            py_isoformat(Timestamp::from_microsecond(1_788_310_800_123_456).unwrap()),
            "2026-09-02T01:00:00.123456Z"
        );
        assert_eq!(hour_file_name(now), "2026-09-02T01.json");
        assert_eq!(part_file_name(now), "2026-09-02T01-1788310800000000.json");

        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("inbox").join("claude-statusline");
        let written = write_statusline_samples(&inbox, &samples, now).unwrap();
        assert_eq!(written.samples, samples);
        record_statusline_status(&inbox, &data, &written.samples, now).unwrap();
        record_statusline_status(&inbox, &data, &[], now).unwrap();
        let files = read_statusline_files(&inbox);
        assert_eq!(files.len(), 1);
        assert!(files[0].0 > 0);
        let status: Value =
            serde_json::from_slice(&fs::read(inbox.parent().unwrap().join(STATUS_SIDECAR)).unwrap()).unwrap();
        assert_eq!(status["invocations"], 2);
        assert_eq!(status["last_published_at"], "2026-09-02T01:00:00Z");
        assert_eq!(status["last_offered_at"], "2026-09-02T01:00:00Z");
        assert_eq!(
            status["rate_limit_keys"],
            json!(["five_hour", "seven_day", "seven_day_fable", "seven_day_far", "spend"])
        );
        assert!(status["offered_windows"].get("seven_day_fable").is_some());
        assert!(status["offered_windows"].get("spend").is_none());
        assert_eq!(
            status["offered_windows_ever"],
            json!(["five_hour", "seven_day", "seven_day_fable", "seven_day_far"])
        );
        assert!(status.get("cwd").is_none());
        let parsed = read_statusline_status(&inbox).unwrap();
        assert_eq!(parsed.invocations, 2);
        assert_eq!(parsed.last_invocation_at.as_deref(), Some("2026-09-02T01:00:00Z"));
        assert_eq!(parsed.offered_windows_ever.as_ref().map(Vec::len), Some(4));
        let legacy: SidecarStatus =
            serde_json::from_str(r#"{"last_invocation_at":"2026-09-02T03:10:00Z","invocations":3}"#).unwrap();
        assert_eq!(legacy.offered_windows_ever, None, "an older sidecar does not claim no windows");
        assert!(read_statusline_status(&dir.path().join("elsewhere")).is_none());
    }

    #[test]
    fn statusline_limits_array_publishes_scoped_weekly_windows() {
        let now = Timestamp::from_second(1_788_310_800).unwrap();
        let data = json!({
            "limits": [
                {"kind": "session", "percent": 20, "resets_at": "2026-09-02T02:00:00Z"},
                {"kind": "weekly_all", "percent": 40, "resets_at": "2026-09-08T01:00:00Z"},
                {"kind": "weekly_scoped", "percent": 51.5, "resets_at": "2026-09-08T01:00:00Z",
                    "scope": {"model": {"display_name": "Fable"}}}
            ],
            "rate_limits": {
                "five_hour": {"used_percentage": 99, "resets_at": 1_788_314_400}
            },
            "extra_usage": {"is_enabled": true, "utilization": 10},
            "version": "2.1.274"
        });
        let samples = samples_from_statusline(&data, now);
        assert_eq!(
            samples.iter().map(|s| s.window_key.as_str()).collect::<Vec<_>>(),
            ["five_hour", "seven_day", "seven_day_fable", "extra_usage"]
        );
        assert_eq!(samples[0].used_percent.as_f64(), Some(20.0), "limits array wins over rate_limits");
        assert_eq!(samples[2].label, "Claude · weekly · Fable");
        assert_eq!(samples[3].label, "Claude · extra usage");
        assert_eq!(samples[3].used_percent.as_f64(), Some(10.0));
        assert_eq!(samples[3].resets_at, samples[1].resets_at);
    }

    #[test]
    fn a_stamped_sample_round_trips_and_older_files_parse_without_the_stamp() {
        let stamped = StatuslineSample {
            window_key: "five_hour".into(),
            label: "Claude · 5h".into(),
            observed_at: "2026-09-02T01:00:00Z".into(),
            used_percent: serde_json::Number::from(20),
            resets_at: "2026-09-02T02:00:00Z".into(),
            window_minutes: 300,
            identity_hash: Some("a".repeat(64)),
        };
        let text = serde_json::to_string(&stamped).unwrap();
        assert!(text.contains("\"identity_hash\""));
        assert_eq!(serde_json::from_str::<StatuslineSample>(&text).unwrap(), stamped);
        let legacy = r#"{"window_key":"five_hour","label":"Claude · 5h","observed_at":"2026-09-02T01:00:00Z","used_percent":20,"resets_at":"2026-09-02T02:00:00Z","window_minutes":300}"#;
        assert_eq!(serde_json::from_str::<StatuslineSample>(legacy).unwrap().identity_hash, None);
    }

    #[test]
    fn part_files_are_written_on_change_and_on_the_heartbeat_only() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("inbox").join("claude-statusline");
        let t0 = Timestamp::from_second(1_788_310_800).unwrap();
        let minute = |n: i64| Timestamp::from_second(1_788_310_800 + n * 60).unwrap();

        let first =
            write_statusline_samples(&inbox, &samples_from_statusline(&statusline(20, 40), t0), t0).unwrap();
        assert_eq!(first.samples.len(), 2);
        assert_eq!(part_files(&inbox), vec![part_file_name(t0)]);
        assert!(!inbox.join(LATEST_STATE).exists(), "the kept state sits beside the inbox");
        assert!(inbox.parent().unwrap().join(LATEST_STATE).exists());

        // The same readings a minute later: nothing is written.
        let repeat = write_statusline_samples(
            &inbox,
            &samples_from_statusline(&statusline(20, 40), minute(1)),
            minute(1),
        )
        .unwrap();
        assert_eq!(repeat, StatuslineWrite::default());
        assert_eq!(part_files(&inbox).len(), 1);

        // One window changed: only that window is written.
        let changed = write_statusline_samples(
            &inbox,
            &samples_from_statusline(&statusline(25, 40), minute(2)),
            minute(2),
        )
        .unwrap();
        assert_eq!(changed.samples.iter().map(|s| s.window_key.as_str()).collect::<Vec<_>>(), ["five_hour"]);
        assert_eq!(part_files(&inbox), vec![part_file_name(t0), part_file_name(minute(2))]);
        let stored: Vec<StatuslineSample> =
            serde_json::from_slice(&fs::read(changed.part_file.unwrap()).unwrap()).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].used_percent, serde_json::Number::from(25));

        // A reset moved: the window is written even at the same percentage.
        let mut moved = statusline(25, 40);
        moved["rate_limits"]["five_hour"]["resets_at"] = json!(1_788_318_000);
        let reset =
            write_statusline_samples(&inbox, &samples_from_statusline(&moved, minute(3)), minute(3)).unwrap();
        assert_eq!(reset.samples.len(), 1);

        // The heartbeat: the weekly window, unchanged since t0, is written again after 15 minutes.
        let idle = write_statusline_samples(&inbox, &samples_from_statusline(&moved, minute(14)), minute(14))
            .unwrap();
        assert!(idle.samples.is_empty());
        let beat = write_statusline_samples(&inbox, &samples_from_statusline(&moved, minute(16)), minute(16))
            .unwrap();
        assert_eq!(beat.samples.iter().map(|s| s.window_key.as_str()).collect::<Vec<_>>(), ["seven_day"]);
        assert_eq!(part_files(&inbox).len(), 4);

        // Every part file is an array the reader accepts.
        assert!(
            read_statusline_files(&inbox).iter().all(|(_, file)| file.as_ref().is_ok_and(Value::is_array))
        );
    }

    #[test]
    fn pruning_compares_the_hour_prefix_and_spares_other_names() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("inbox").join("claude-statusline");
        ensure_private_dir(&inbox).unwrap();
        for name in [
            "2026-09-01T00-1788220800000000.json",
            "2026-09-02T00-1788307200000000.json",
            "2026-09-02T02.json",
            "2026-09-03T05-1788411600000000.json",
            "broken.json",
            "missing-label.json",
            "notes.txt",
        ] {
            fs::write(inbox.join(name), b"[]").unwrap();
        }
        // Two days before 2026-09-04T01 is 2026-09-02T01: strictly older hours go.
        let now = Timestamp::from_str("2026-09-04T01:30:00Z").unwrap();
        assert_eq!(prune_statusline_files(&inbox, now, 2), 2);
        assert_eq!(
            part_files(&inbox),
            vec![
                "2026-09-02T02.json",
                "2026-09-03T05-1788411600000000.json",
                "broken.json",
                "missing-label.json",
                "notes.txt"
            ]
        );
        assert_eq!(prune_statusline_files(&dir.path().join("absent"), now, 2), 0);
        assert!(has_hour_prefix("2026-09-02T02.json"));
        assert!(!has_hour_prefix("2026-09-02.json"));
        assert!(!has_hour_prefix("broken.json"));
    }

    /// A Claude config naming an account, with a secret the cache must never copy.
    fn claude_config(uuid: &str) -> String {
        format!(r#"{{"oauthAccount":{{"accountUuid":"{uuid}"}},"primaryApiKey":"SECRET"}}"#)
    }

    fn read_cache(path: &Path) -> IdentityCache {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn identity_cache_reads_the_config_once_per_change() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join(IDENTITY_CACHE);
        let config = dir.path().join("claude.json");
        let key = config.to_string_lossy().into_owned();
        let hash = crate::discovery::identity_hash("claude", "11111111-2222-4333-8444-555555555555");
        fs::write(&config, claude_config("11111111-2222-4333-8444-555555555555")).unwrap();
        assert_eq!(cached_claude_identity(&cache, &config).as_deref(), Some(hash.as_str()));
        let cached = read_cache(&cache);
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[&key].evidence_hash.as_deref(), Some(hash.as_str()));
        assert!(!fs::read_to_string(&cache).unwrap().contains("SECRET"));

        // A hit is served from the cache: a planted value proves the file was not re-read.
        let mut planted = cached.clone();
        planted.get_mut(&key).unwrap().evidence_hash = Some("f".repeat(64));
        fs::write(&cache, serde_json::to_vec(&planted).unwrap()).unwrap();
        assert_eq!(cached_claude_identity(&cache, &config).as_deref(), Some("f".repeat(64).as_str()));

        // A different path with the same stat is a miss, cached under its own key.
        let other = dir.path().join("other.json");
        fs::copy(&config, &other).unwrap();
        assert_eq!(cached_claude_identity(&cache, &other).as_deref(), Some(hash.as_str()));
        let both = read_cache(&cache);
        assert_eq!(both.len(), 2);
        assert_eq!(both[&key], planted[&key], "the other path's miss leaves this entry alone");

        // Signed out caches null; a half-written file yields nothing and keeps the cache.
        fs::write(&config, br#"{"numStartups":1}"#).unwrap();
        assert_eq!(cached_claude_identity(&cache, &config), None);
        let signed_out = read_cache(&cache);
        assert_eq!(signed_out[&key].evidence_hash, None);
        fs::write(&config, b"{\"oauthAccount\":{\"accountUuid\":\"1111").unwrap();
        assert_eq!(cached_claude_identity(&cache, &config), None);
        assert_eq!(read_cache(&cache), signed_out);
        assert_eq!(cached_claude_identity(&cache, &dir.path().join("missing.json")), None);
        // A cache in the older single-entry shape is a miss, then rewritten as a map.
        fs::write(&cache, br#"{"path":"x","mtime_ns":1,"size":1,"evidence_hash":null}"#).unwrap();
        fs::write(&config, claude_config("11111111-2222-4333-8444-555555555555")).unwrap();
        assert_eq!(cached_claude_identity(&cache, &config).as_deref(), Some(hash.as_str()));
        assert_eq!(read_cache(&cache).len(), 1);
    }

    #[test]
    fn two_profiles_alternating_hit_the_cache_and_keep_their_own_change_detection() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join(IDENTITY_CACHE);
        // Two `CLAUDE_CONFIG_DIR` profiles, each with its own `.claude.json` and account.
        let profile_a = dir.path().join("profile-a").join(".claude.json");
        let profile_b = dir.path().join("profile-b").join(".claude.json");
        fs::create_dir_all(profile_a.parent().unwrap()).unwrap();
        fs::create_dir_all(profile_b.parent().unwrap()).unwrap();
        fs::write(&profile_a, claude_config("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).unwrap();
        fs::write(&profile_b, claude_config("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).unwrap();
        let hash_a = crate::discovery::identity_hash("claude", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let hash_b = crate::discovery::identity_hash("claude", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        assert_eq!(cached_claude_identity(&cache, &profile_a).as_deref(), Some(hash_a.as_str()));
        assert_eq!(cached_claude_identity(&cache, &profile_b).as_deref(), Some(hash_b.as_str()));
        assert_eq!(read_cache(&cache).len(), 2);
        // Alternating renders: both paths are hits, proven by planted values.
        let mut planted = read_cache(&cache);
        for (index, entry) in planted.values_mut().enumerate() {
            entry.evidence_hash = Some(char::from(b'c' + index as u8).to_string().repeat(64));
        }
        fs::write(&cache, serde_json::to_vec(&planted).unwrap()).unwrap();
        let key_a = profile_a.to_string_lossy().into_owned();
        let key_b = profile_b.to_string_lossy().into_owned();
        for _ in 0..2 {
            assert_eq!(cached_claude_identity(&cache, &profile_a), planted[&key_a].evidence_hash);
            assert_eq!(cached_claude_identity(&cache, &profile_b), planted[&key_b].evidence_hash);
        }
        assert_eq!(read_cache(&cache), planted, "hits never rewrite the cache");

        // The kept state: each stamp keeps its own last reading per window.
        let inbox = dir.path().join("inbox").join("claude-statusline");
        let minute = |n: i64| Timestamp::from_second(1_788_310_800 + n * 60).unwrap();
        let stamped = |data: &Value, stamp: &str, at: Timestamp| -> Vec<StatuslineSample> {
            let mut samples = samples_from_statusline(data, at);
            for sample in &mut samples {
                sample.identity_hash = Some(stamp.to_owned());
            }
            samples
        };
        let render = |stamp: &str, five_hour: u64, at: Timestamp| {
            write_statusline_samples(&inbox, &stamped(&statusline(five_hour, 40), stamp, at), at).unwrap()
        };
        assert_eq!(render(hash_a.as_str(), 20, minute(0)).samples.len(), 2, "A's first render");
        assert_eq!(render(hash_b.as_str(), 20, minute(1)).samples.len(), 2, "B's first render");
        assert!(render(hash_a.as_str(), 20, minute(2)).samples.is_empty(), "A repeats");
        assert!(render(hash_b.as_str(), 20, minute(3)).samples.is_empty(), "B repeats");
        let changed = render(hash_a.as_str(), 25, minute(4));
        assert_eq!(changed.samples.iter().map(|s| s.window_key.as_str()).collect::<Vec<_>>(), ["five_hour"]);
        assert!(render(hash_b.as_str(), 20, minute(5)).samples.is_empty(), "A's change is not B's");
        assert_eq!(render(hash_b.as_str(), 25, minute(6)).samples.len(), 1, "B's own change");
        assert!(render(hash_a.as_str(), 25, minute(7)).samples.is_empty());
        assert_eq!(part_files(&inbox).len(), 4);
        let kept = read_latest_state(&inbox);
        let mut stamps = vec![hash_a.as_str(), hash_b.as_str()];
        stamps.sort();
        assert_eq!(kept.keys().collect::<Vec<_>>(), stamps);
        assert_eq!(kept[hash_a.as_str()]["five_hour"].used_percent, serde_json::Number::from(25));
        assert_eq!(kept[hash_b.as_str()]["five_hour"].kept_at, py_isoformat(minute(6)));
        // An unstamped render (an unreadable config) is its own profile, keyed by the empty string.
        let unstamped = write_statusline_samples(
            &inbox,
            &samples_from_statusline(&statusline(25, 40), minute(8)),
            minute(8),
        )
        .unwrap();
        assert_eq!(unstamped.samples.len(), 2);
        assert!(read_latest_state(&inbox).contains_key(""));
    }

    #[test]
    fn freshness_threshold_floors_at_two_hours() {
        assert_eq!(stale_after_minutes(15), 120);
        assert_eq!(stale_after_minutes(30), 120);
        assert_eq!(stale_after_minutes(60), 135);
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
