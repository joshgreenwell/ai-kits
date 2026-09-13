//! The v1 parity port (section 2.6): file discovery, checkpoints, Codex and
//! Claude record parsing, event saving, and embedded Codex rate limits, restated
//! from `collect.py` v1.1.0 so the port is exact. The parity test in
//! `tests/parity.rs` fails when any rule drifts.
//!
//! Every place `collect.py` would raise `TypeError`, `ValueError`, or
//! `AttributeError` for a line (a `.get` on a non-dict, for example) is a
//! `Malformed` here: the line counts as malformed and scanning continues, with
//! any side effects that happened before the failure kept, as in Python.

use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use observatory_contract::{Provider, Sha256Hex};
use observatory_core::adapter::{AdapterError, BindingContext, RunContext};
use observatory_core::paths::{file_identity, home_dir, mtime_ns, mtime_seconds};
use observatory_core::pyjson::{count, digest, epoch, hour_floor, iso, py_str, py_truthy, uuid_time};
use observatory_core::state::{EventRow, FileCheckpoint, State};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// A line `collect.py` would have counted as malformed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Malformed;

/// The per-file parser context, persisted with the checkpoint.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Ctx {
    pub session: String,
    pub model: String,
    pub own_started: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cumulative: Option<Value>,
    /// v2 only: whether `session` came from the provider (`session_meta`) or the file name.
    #[serde(default)]
    pub session_from_provider: bool,
    /// v2 only: the client version the provider wrote, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_version: Option<String>,
    /// v2 only: the working directory Codex last recorded for this file (`session_meta`, then
    /// each `turn_context`). Claude carries `cwd` on every line instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// v2 only: the contract surface derived from the Codex `originator` or `source`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
}

impl Ctx {
    /// `{ session: <file stem>, model: 'unknown', own_started: false }`.
    pub fn fresh(stem: &str) -> Self {
        Ctx {
            session: stem.to_owned(),
            model: "unknown".to_owned(),
            own_started: false,
            created: None,
            cumulative: None,
            session_from_provider: false,
            client_version: None,
            cwd: None,
            surface: None,
        }
    }
}

/// `scan()` metrics, as `collect.py` reports them in `coverage`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ScanMetrics {
    pub files: u64,
    pub bytes_read: u64,
    pub malformed_lines: u64,
    pub unavailable_roots: u64,
    /// v2 only: roots that existed.
    pub stores_discovered: u64,
    /// v2 only: true when the deadline stopped the scan before every file was read.
    pub interrupted: bool,
}

/// What each saved event carries beyond v1: the fields `activity.request` needs.
#[derive(Clone, Debug)]
pub struct EventExtras {
    pub product: &'static str,
    pub parent_session: Option<String>,
}

/// Per-line attribution beyond v1: where the request ran and from which surface.
#[derive(Clone, Copy, Debug, Default)]
pub struct Attribution<'a> {
    pub cwd: Option<&'a str>,
    pub surface: Option<&'a str>,
}

/// A working directory as a project key: trailing separators trimmed, bounded, otherwise as
/// written. The same directory yields the same key from Claude and Codex; two machines with
/// different paths yield different keys, which labels join on the server.
pub fn normalize_cwd(cwd: &str) -> Option<String> {
    let trimmed = cwd.trim_end_matches(['/', '\\']);
    let value = if trimmed.is_empty() { cwd } else { trimmed };
    if value.trim().is_empty() {
        return None;
    }
    Some(value.chars().take(400).collect())
}

/// `sha256(["project", cwd])` in the repository's stable JSON form; a normalized cwd only.
pub fn project_hash(cwd: &str) -> Sha256Hex {
    digest(&json!(["project", cwd]))
}

/// Claude Code's `entrypoint` as a contract surface. A transcript without the field counts as
/// CLI, which is what every transcript was before the field existed.
pub fn claude_surface(entrypoint: Option<&str>) -> &'static str {
    match entrypoint {
        None | Some("cli") => "cli",
        Some("claude-desktop") => "desktop",
        Some("claude-vscode") => "ide",
        Some(value) if value.starts_with("sdk-") => "sdk",
        Some(_) => "unknown",
    }
}

/// Codex's `originator`, then `source`, as a contract surface. The desktop app reports
/// `Codex Desktop` with `source: vscode`, so the originator decides first.
pub fn codex_surface(originator: Option<&str>, source: Option<&str>) -> &'static str {
    let originator = originator.map(str::to_ascii_lowercase);
    match originator.as_deref() {
        Some("codex_cli_rs" | "codex_exec") => "cli",
        Some(value) if value.contains("desktop") => "desktop",
        Some(value)
            if value.contains("vscode") || value.contains("vs code") || value.contains("jetbrains") =>
        {
            "ide"
        }
        _ => match source {
            None | Some("cli" | "exec") => "cli",
            Some("vscode") => "ide",
            Some(_) => "unknown",
        },
    }
}

fn truncate100(text: String) -> String {
    text.chars().take(100).collect()
}

/// `payload.get(key)`, or `Malformed` when `payload` is not a dict.
fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, Malformed> {
    match value {
        Value::Object(map) => Ok(map.get(key)),
        _ => Err(Malformed),
    }
}

/// `x or {}`: a falsy value becomes an empty dict; a truthy one stays as is.
fn or_empty(value: Option<&Value>) -> Value {
    match value {
        Some(v) if py_truthy(v) => v.clone(),
        _ => Value::Object(Map::new()),
    }
}

fn is_number_not_bool(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    }
}

fn is_int_not_bool(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(n)) if n.is_i64() || n.is_u64() => n.as_i64(),
        _ => None,
    }
}

/// `components(provider, usage)`: the four exclusive classes.
pub fn components(provider: Provider, usage: &Value) -> Result<[i64; 4], Malformed> {
    let field = |key: &str| get(usage, key);
    match provider {
        Provider::Codex => {
            let cached = count(field("cached_input_tokens")?);
            let written = count(field("cache_write_input_tokens")?);
            let fresh = (count(field("input_tokens")?) - cached - written).max(0);
            Ok([fresh, cached, written, count(field("output_tokens")?)])
        }
        Provider::Claude | Provider::Cursor | Provider::AnthropicApi | Provider::OpenaiApi => Ok([
            count(field("input_tokens")?),
            count(field("cache_read_input_tokens")?),
            count(field("cache_creation_input_tokens")?),
            count(field("output_tokens")?),
        ]),
    }
}

/// `save_event`: drop an all-zero event; a repeated event id keeps component-wise maxima.
#[allow(clippy::too_many_arguments)]
pub fn save_event(
    state: &State,
    binding: &str,
    event_id: &str,
    session: &str,
    session_from_provider: bool,
    timestamp: f64,
    timestamp_text: &str,
    model: &str,
    values: [i64; 4],
    extras: &EventExtras,
    client_version: Option<&str>,
    attribution: Attribution<'_>,
) -> Result<(), AdapterError> {
    if values.iter().sum::<i64>() == 0 {
        return Ok(());
    }
    let Some(hour) = iso(hour_floor(timestamp) as f64) else { return Ok(()) };
    let project = attribution.cwd.and_then(normalize_cwd).map(|cwd| (project_hash(&cwd), cwd));
    if let Some((hash, cwd)) = &project {
        state.upsert_project(binding, hash.as_str(), cwd, timestamp_text)?;
    }
    let hash_text = project.as_ref().map(|(hash, _)| hash.as_str().to_owned());
    match state.event(binding, event_id)? {
        Some(old) => {
            let merged = [
                old.input_tokens.max(values[0]),
                old.cached_tokens.max(values[1]),
                old.cache_write_tokens.max(values[2]),
                old.output_tokens.max(values[3]),
            ];
            state.update_event_tokens(binding, event_id, merged)?;
            let fills_project = old.project_hash.is_none() && hash_text.is_some();
            let fills_surface = old.surface.is_none() && attribution.surface.is_some();
            if fills_project || fills_surface {
                state.fill_event_attribution(binding, event_id, hash_text.as_deref(), attribution.surface)?;
            }
        }
        None => {
            state.insert_event(
                binding,
                &EventRow {
                    id: event_id.to_owned(),
                    session: session.to_owned(),
                    hour: hour.as_str().to_owned(),
                    model: model.to_owned(),
                    input_tokens: values[0],
                    cached_tokens: values[1],
                    cache_write_tokens: values[2],
                    output_tokens: values[3],
                    session_identity: if session_from_provider {
                        "provider".into()
                    } else {
                        "synthetic".into()
                    },
                    timestamp: timestamp_text.to_owned(),
                    product: extras.product.to_owned(),
                    client_version: client_version.map(str::to_owned),
                    parent_session: extras.parent_session.clone(),
                    project_hash: hash_text,
                    surface: attribution.surface.map(str::to_owned),
                },
            )?;
        }
    }
    Ok(())
}

/// `save_codex_quotas`: one reading per window per UTC hour, freshest wins.
pub fn save_codex_quotas(
    state: &State,
    binding: &str,
    payload: &Value,
    timestamp: f64,
) -> Result<(), AdapterError> {
    let limits = or_empty(get(payload, "rate_limits").map_err(|_| AdapterError::Io).ok().flatten());
    for key in ["primary", "secondary"] {
        let Ok(Some(Value::Object(window))) = get(&limits, key) else {
            if get(&limits, key).is_err() {
                return Err(AdapterError::Io);
            }
            continue;
        };
        let used = window.get("used_percent");
        let reset = is_number_not_bool(window.get("resets_at"));
        let minutes = is_int_not_bool(window.get("window_minutes"));
        let (Some(used_value), Some(reset), Some(minutes)) = (is_number_not_bool(used), reset, minutes)
        else {
            continue;
        };
        if !(0.0..=100.0).contains(&used_value) || reset <= timestamp || minutes <= 0 {
            continue;
        }
        let limit_id = get(&limits, "limit_id").map_err(|_| AdapterError::Io)?;
        let limit_name = get(&limits, "limit_name").map_err(|_| AdapterError::Io)?;
        let id_text = match limit_id {
            Some(v) if py_truthy(v) => py_str(v),
            _ => "codex".to_owned(),
        };
        let name_text = match limit_name {
            Some(v) if py_truthy(v) => py_str(v),
            _ => "Codex".to_owned(),
        };
        let (Some(observed_at), Some(resets_at), Some(hour)) =
            (iso(timestamp), iso(reset), iso(hour_floor(timestamp) as f64))
        else {
            continue;
        };
        let window_key = format!("{id_text}:{minutes}");
        let label = format!(
            "{name_text}{}",
            if minutes == 10080 { " · weekly".to_owned() } else { format!(" · {}h", minutes / 60) }
        );
        let item = json!({
            "window_key": window_key, "label": label, "observed_at": observed_at.as_str(),
            "used_percent": used.cloned().unwrap_or(Value::Null), "resets_at": resets_at.as_str(),
            "window_minutes": minutes, "raw_window_id": key,
        });
        let slot = format!("{window_key}:{}", hour.as_str());
        let fresher = match state.allowance_slot(binding, &slot)? {
            Some(old) => serde_json::from_str::<Value>(&old)
                .ok()
                .and_then(|old| old.get("observed_at").and_then(Value::as_str).map(str::to_owned))
                .is_none_or(|old_observed| old_observed.as_str() < observed_at.as_str()),
            None => true,
        };
        if fresher {
            state.upsert_allowance_slot(binding, &slot, &item.to_string())?;
        }
    }
    Ok(())
}

/// The outcome of `process_line` beyond side effects: whether the line was malformed.
type LineResult = Result<(), Malformed>;

/// `process_line` from `collect.py`, with Python's evaluation order.
#[allow(clippy::too_many_arguments)]
pub fn process_line(
    state: &State,
    binding: &str,
    data: &Value,
    ctx: &mut Ctx,
    provider: Provider,
    account: &str,
    since: f64,
    now: f64,
    extras: &EventExtras,
) -> Result<LineResult, AdapterError> {
    let Some(object) = data.as_object() else { return Ok(Err(Malformed)) };
    let timestamp = epoch(object.get("timestamp"));
    let kind = object.get("type").and_then(Value::as_str);
    let payload = or_empty(object.get("payload"));
    let provider_text = provider.as_str();

    if provider == Provider::Codex {
        match kind {
            Some("session_meta") => {
                let Ok(id) = get(&payload, "id") else { return Ok(Err(Malformed)) };
                if let Some(id) = id.filter(|v| py_truthy(v)) {
                    ctx.session = py_str(id);
                    ctx.session_from_provider = true;
                }
                if let Ok(Some(Value::String(version))) = get(&payload, "cli_version") {
                    ctx.client_version = Some(version.chars().take(40).collect());
                }
                if let Ok(Some(Value::String(cwd))) = get(&payload, "cwd") {
                    ctx.cwd = Some(cwd.chars().take(400).collect());
                }
                let originator = get(&payload, "originator").ok().flatten().and_then(Value::as_str);
                let source = get(&payload, "source").ok().flatten().and_then(Value::as_str);
                ctx.surface = Some(codex_surface(originator, source).to_owned());
                let session_value = Value::String(ctx.session.clone());
                let Ok(meta_timestamp) = get(&payload, "timestamp") else { return Ok(Err(Malformed)) };
                ctx.created = Some(
                    uuid_time(Some(&session_value))
                        .filter(|v| *v != 0.0)
                        .or_else(|| epoch(meta_timestamp).filter(|v| *v != 0.0))
                        .unwrap_or(0.0),
                );
            }
            Some("turn_context") => {
                let Ok(model) = get(&payload, "model") else { return Ok(Err(Malformed)) };
                let chosen = match model {
                    Some(v) if py_truthy(v) => py_str(v),
                    _ if !ctx.model.is_empty() => ctx.model.clone(),
                    _ => "unknown".to_owned(),
                };
                ctx.model = truncate100(chosen);
                if let Ok(Some(Value::String(cwd))) = get(&payload, "cwd") {
                    ctx.cwd = Some(cwd.chars().take(400).collect());
                }
            }
            Some("event_msg") => {
                let Ok(payload_type) = get(&payload, "type") else { return Ok(Err(Malformed)) };
                match payload_type.and_then(Value::as_str) {
                    Some("task_started") => {
                        let Ok(turn_id) = get(&payload, "turn_id") else { return Ok(Err(Malformed)) };
                        let started = uuid_time(turn_id)
                            .filter(|v| *v != 0.0)
                            .or_else(|| timestamp.filter(|v| *v != 0.0))
                            .unwrap_or(0.0);
                        if started >= ctx.created.unwrap_or(0.0) - 5.0 {
                            ctx.own_started = true;
                        }
                    }
                    Some("token_count") => {
                        let Ok(info_raw) = get(&payload, "info") else { return Ok(Err(Malformed)) };
                        let info = or_empty(info_raw);
                        let Ok(cumulative) = get(&info, "total_token_usage") else {
                            return Ok(Err(Malformed));
                        };
                        let cumulative = cumulative.cloned();
                        let previous = ctx.cumulative.clone();
                        let cumulative_truthy = cumulative.as_ref().is_some_and(py_truthy);
                        if cumulative_truthy {
                            ctx.cumulative = cumulative.clone();
                        }
                        let Some(ts) = timestamp else { return Ok(Ok(())) };
                        if ts < since || ts > now + 300.0 || !ctx.own_started {
                            return Ok(Ok(()));
                        }
                        if let Err(AdapterError::Io) = save_codex_quotas(state, binding, &payload, ts) {
                            return Ok(Err(Malformed));
                        }
                        let Ok(usage) = get(&info, "last_token_usage") else { return Ok(Err(Malformed)) };
                        let Some(usage) = usage.filter(|v| v.is_object()) else { return Ok(Ok(())) };
                        let mut usage_value = usage.clone();
                        let previous_truthy = previous.as_ref().is_some_and(py_truthy);
                        if cumulative_truthy && previous_truthy {
                            let (Some(cumulative_value), Some(previous_value)) =
                                (cumulative.as_ref(), previous.as_ref())
                            else {
                                return Ok(Err(Malformed));
                            };
                            if cumulative_value == previous_value {
                                return Ok(Ok(()));
                            }
                            let keys = [
                                "input_tokens",
                                "cached_input_tokens",
                                "cache_write_input_tokens",
                                "output_tokens",
                                "total_tokens",
                            ];
                            let mut deltas = Map::new();
                            let mut all_non_negative = true;
                            for key in keys {
                                let Ok(current) = get(cumulative_value, key) else {
                                    return Ok(Err(Malformed));
                                };
                                let Ok(before) = get(previous_value, key) else { return Ok(Err(Malformed)) };
                                let delta = count(current) - count(before);
                                if delta < 0 {
                                    all_non_negative = false;
                                }
                                deltas.insert(key.to_owned(), Value::from(delta));
                            }
                            if all_non_negative {
                                usage_value = Value::Object(deltas);
                            }
                        }
                        let session_hash = digest(&json!([provider_text, account, ctx.session]));
                        let raw_timestamp = object.get("timestamp").cloned().unwrap_or(Value::Null);
                        let identity_value = if cumulative_truthy {
                            cumulative.clone().unwrap_or(Value::Null)
                        } else {
                            usage_value.clone()
                        };
                        let event_id = digest(&json!([
                            provider_text,
                            account,
                            ctx.session,
                            raw_timestamp,
                            identity_value
                        ]));
                        let Ok(values) = components(provider, &usage_value) else {
                            return Ok(Err(Malformed));
                        };
                        let model =
                            if ctx.model.is_empty() { "unknown".to_owned() } else { ctx.model.clone() };
                        let timestamp_text = raw_timestamp.as_str().unwrap_or("").to_owned();
                        save_event(
                            state,
                            binding,
                            event_id.as_str(),
                            session_hash.as_str(),
                            ctx.session_from_provider,
                            ts,
                            &timestamp_text,
                            &model,
                            values,
                            extras,
                            ctx.client_version.as_deref(),
                            Attribution { cwd: ctx.cwd.as_deref(), surface: ctx.surface.as_deref() },
                        )?;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        return Ok(Ok(()));
    }

    // Claude: `assistant` records within the window.
    let (Some("assistant"), Some(ts)) = (kind, timestamp) else { return Ok(Ok(())) };
    if !(since <= ts && ts <= now + 300.0) {
        return Ok(Ok(()));
    }
    let message = or_empty(object.get("message"));
    let Ok(id) = get(&message, "id") else { return Ok(Err(Malformed)) };
    let Ok(usage) = get(&message, "usage") else { return Ok(Err(Malformed)) };
    let Ok(model) = get(&message, "model") else { return Ok(Err(Malformed)) };
    let Some(id) = id.filter(|v| py_truthy(v)) else { return Ok(Ok(())) };
    let Some(usage) = usage.filter(|v| v.is_object()) else { return Ok(Ok(())) };
    if model.and_then(Value::as_str) == Some("<synthetic>") {
        return Ok(Ok(()));
    }
    let session_id = object.get("sessionId").filter(|v| py_truthy(v));
    let (session_value, from_provider) = match session_id {
        Some(v) => (v.clone(), true),
        None => (Value::String(ctx.session.clone()), false),
    };
    let session_hash = digest(&json!([provider_text, account, session_value]));
    let event_id = digest(&json!([provider_text, account, id]));
    let model_text = truncate100(match model {
        Some(v) if py_truthy(v) => py_str(v),
        _ => "unknown".to_owned(),
    });
    let Ok(values) = components(provider, usage) else { return Ok(Err(Malformed)) };
    let client_version =
        object.get("version").and_then(Value::as_str).map(|v| v.chars().take(40).collect::<String>());
    let timestamp_text = object.get("timestamp").and_then(Value::as_str).unwrap_or("").to_owned();
    let attribution = Attribution {
        cwd: object.get("cwd").and_then(Value::as_str),
        surface: Some(claude_surface(object.get("entrypoint").and_then(Value::as_str))),
    };
    save_event(
        state,
        binding,
        event_id.as_str(),
        session_hash.as_str(),
        from_provider,
        ts,
        &timestamp_text,
        &model_text,
        values,
        extras,
        client_version.as_deref(),
        attribution,
    )?;
    Ok(Ok(()))
}

/// Only lines containing one of these bytes are parsed.
const INTERESTING: [&[u8]; 5] =
    [b"token_count", b"session_meta", b"turn_context", b"task_started", b"\"assistant\""];

fn interesting(line: &[u8]) -> bool {
    INTERESTING.iter().any(|needle| line.windows(needle.len()).any(|window| window == *needle))
}

/// `Path(root).expanduser()`.
pub fn expand_user(root: &Path) -> PathBuf {
    if let Ok(rest) = root.strip_prefix("~")
        && let Some(home) = home_dir()
    {
        return home.join(rest);
    }
    root.to_path_buf()
}

/// `root.rglob('*.jsonl')` without following symlinks, sorted for determinism.
fn walk(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    let mut entries: Vec<PathBuf> = entries.filter_map(Result::ok).map(|entry| entry.path()).collect();
    entries.sort();
    for path in entries {
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            walk(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "jsonl") {
            out.push(path);
        }
    }
}

/// True for a Claude Code subagent transcript (`.../<session>/subagents/<agent>.jsonl`).
pub fn subagent_parent(path: &Path) -> Option<String> {
    let mut components = path.components().rev();
    let _file = components.next()?;
    let dir = components.next()?;
    if dir.as_os_str() != "subagents" {
        return None;
    }
    components.next().map(|parent| parent.as_os_str().to_string_lossy().into_owned())
}

/// `scan()` from `collect.py` for one binding: walks the roots, resumes from
/// checkpoints, parses interesting lines, and saves events and embedded quotas.
pub fn scan(
    state: &State,
    ctx_run: &RunContext,
    binding: &BindingContext,
    provider: Provider,
    product: &'static str,
    include_subagents: bool,
) -> Result<ScanMetrics, AdapterError> {
    let mut metrics = ScanMetrics::default();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let binding_id = binding.binding_id.as_str();
    let account = binding.account_id.as_str();
    let since = ctx_run.since;
    let now = ctx_run.now_seconds;
    'roots: for root in &binding.roots {
        let root = expand_user(root);
        if !root.is_dir() {
            metrics.unavailable_roots += 1;
            continue;
        }
        metrics.stores_discovered += 1;
        let mut files = Vec::new();
        walk(&root, &mut files);
        for path in files {
            if ctx_run.should_stop() {
                metrics.interrupted = true;
                break 'roots;
            }
            let Ok(resolved) = fs::canonicalize(&path) else {
                metrics.unavailable_roots += 1;
                continue;
            };
            if !seen.insert(resolved.clone()) {
                continue;
            }
            let Ok(meta) = fs::metadata(&resolved) else {
                metrics.unavailable_roots += 1;
                continue;
            };
            if mtime_seconds(&meta) < since {
                continue;
            }
            metrics.files += 1;
            let parent_session = subagent_parent(&resolved);
            if parent_session.is_some() && !include_subagents {
                continue;
            }
            let extras = EventExtras {
                product,
                parent_session: parent_session
                    .map(|parent| digest(&json!([provider.as_str(), account, parent])).as_str().to_owned()),
            };
            let path_text = resolved.to_string_lossy().into_owned();
            let size = i64::try_from(meta.len()).unwrap_or(i64::MAX);
            let mtime = i64::try_from(mtime_ns(&meta)).unwrap_or(i64::MAX);
            let old = state.file_checkpoint(binding_id, &path_text)?;
            let Ok(inode) = file_identity(&resolved) else {
                metrics.unavailable_roots += 1;
                continue;
            };
            if let Some(old) = &old
                && old.size == size
                && old.mtime_ns == mtime
            {
                continue;
            }
            let resume = old.as_ref().is_some_and(|old| old.inode == inode && size >= old.size);
            let stem = resolved.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let mut offset = if resume { old.as_ref().map_or(0, |old| old.offset) } else { 0 };
            let mut ctx = if resume {
                old.as_ref()
                    .and_then(|old| serde_json::from_str(&old.context).ok())
                    .unwrap_or_else(|| Ctx::fresh(&stem))
            } else {
                Ctx::fresh(&stem)
            };
            let Ok(file) = fs::File::open(&resolved) else {
                metrics.unavailable_roots += 1;
                continue;
            };
            let mut reader = BufReader::with_capacity(1 << 16, file);
            if reader.seek(SeekFrom::Start(u64::try_from(offset).unwrap_or(0))).is_err() {
                metrics.unavailable_roots += 1;
                continue;
            }
            state.begin()?;
            let mut line = Vec::new();
            let scan_result: Result<(), AdapterError> = (|| {
                loop {
                    line.clear();
                    let read = match reader.read_until(b'\n', &mut line) {
                        Ok(read) => read,
                        Err(_) => return Err(AdapterError::Io),
                    };
                    metrics.bytes_read += read as u64;
                    if read == 0 || line.last() != Some(&b'\n') {
                        break; // A partial trailing record is retried next run.
                    }
                    offset += read as i64;
                    if !interesting(&line) {
                        continue;
                    }
                    match serde_json::from_slice::<Value>(&line) {
                        Ok(data) => match process_line(
                            state, binding_id, &data, &mut ctx, provider, account, since, now, &extras,
                        )? {
                            Ok(()) => {}
                            Err(Malformed) => metrics.malformed_lines += 1,
                        },
                        Err(_) => metrics.malformed_lines += 1,
                    }
                }
                let context = serde_json::to_string(&ctx).map_err(|_| AdapterError::Io)?;
                state.save_file_checkpoint(
                    binding_id,
                    &FileCheckpoint {
                        path: path_text.clone(),
                        size,
                        mtime_ns: mtime,
                        inode,
                        offset,
                        context,
                    },
                )?;
                Ok(())
            })();
            match scan_result {
                Ok(()) => state.commit()?,
                Err(AdapterError::Io) => {
                    state.rollback()?;
                    metrics.unavailable_roots += 1;
                }
                Err(error) => {
                    state.rollback()?;
                    return Err(error);
                }
            }
        }
    }
    Ok(metrics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surfaces_follow_the_provider_fields() {
        assert_eq!(claude_surface(None), "cli");
        assert_eq!(claude_surface(Some("claude-desktop")), "desktop");
        assert_eq!(claude_surface(Some("claude-vscode")), "ide");
        assert_eq!(claude_surface(Some("sdk-py")), "sdk");
        assert_eq!(claude_surface(Some("later-surface")), "unknown");
        assert_eq!(codex_surface(Some("codex_cli_rs"), Some("cli")), "cli");
        assert_eq!(codex_surface(Some("Codex Desktop"), Some("vscode")), "desktop");
        assert_eq!(codex_surface(Some("codex_work_desktop"), Some("vscode")), "desktop");
        assert_eq!(codex_surface(Some("codex_vscode"), None), "ide");
        assert_eq!(codex_surface(None, Some("vscode")), "ide");
        assert_eq!(codex_surface(None, None), "cli");
        assert_eq!(codex_surface(Some("something_new"), Some("mobile")), "unknown");
    }

    #[test]
    fn project_keys_are_normalized_hashes_without_the_path() {
        assert_eq!(normalize_cwd("/work/app/").as_deref(), Some("/work/app"));
        assert_eq!(normalize_cwd("C:\\work\\app\\").as_deref(), Some("C:\\work\\app"));
        assert_eq!(normalize_cwd("/").as_deref(), Some("/"));
        assert_eq!(normalize_cwd("   "), None);
        let hash = project_hash("/work/app");
        assert_eq!(hash, project_hash(normalize_cwd("/work/app/").unwrap().as_str()));
        assert_ne!(hash, project_hash("/work/other"));
        assert!(!hash.as_str().contains("work"));
        assert_eq!(hash.as_str().len(), 64);
    }
}
