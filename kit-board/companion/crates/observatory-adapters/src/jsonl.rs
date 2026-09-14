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

use crate::agents::{
    AgentEvidence, agent_key, classify_claude, classify_codex, complete_spawn, enrich_profile,
    invocation_key, is_known_child, save_observed_spawn, save_observed_start, save_profile,
    save_spawn_attempt,
};
use crate::tools::{
    claude_identity, codex_identity, result_key, save_invocation as save_tool_invocation,
    save_result as save_tool_result,
};

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
    /// v3: the effort recorded on the current Codex turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// v4: privacy-safe agent attribution for the current file/thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentEvidence>,
    /// v5: Codex calls awaiting the next request accounting event. Only
    /// privacy-safe invocation hashes are checkpointed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_tool_invocations: Vec<String>,
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
            reasoning_effort: None,
            agent: None,
            pending_tool_invocations: Vec::new(),
        }
    }
}

/// `scan()` metrics, as `collect.py` reports them in `coverage`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ScanMetrics {
    pub files: u64,
    pub bytes_read: u64,
    pub malformed_lines: u64,
    /// Files with an unresolved malformed relevant line, including gaps found
    /// on an earlier run whose checkpoint was reused.
    pub history_gap_files: u64,
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
    pub include_subagents: bool,
}

/// Per-line attribution beyond v1: where the request ran and from which surface.
#[derive(Clone, Copy, Debug, Default)]
pub struct Attribution<'a> {
    pub cwd: Option<&'a str>,
    pub surface: Option<&'a str>,
    pub agent: Option<&'a AgentEvidence>,
}

/// Nullable request facts retained alongside the legacy counters. Missing or
/// invalid fields stay unknown; they are never converted to zero.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RequestEvidence {
    pub input_fresh: Option<i64>,
    pub input_cached: Option<i64>,
    pub input_cache_write: Option<i64>,
    pub output: Option<i64>,
    pub reasoning: Option<i64>,
    pub reported_total: Option<i64>,
    pub model_requested: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub speed: Option<String>,
    pub context_window_tokens: Option<i64>,
    pub cache_write_ttl: Option<String>,
    pub outcome: Option<String>,
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

fn non_negative(value: Option<&Value>) -> Option<i64> {
    is_int_not_bool(value).filter(|value| *value >= 0)
}

fn bounded_code(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(50).collect())
}

fn bounded_text(value: Option<&Value>, limit: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(limit).collect())
}

fn claude_file_agent(path: &Path, account: &str) -> Option<AgentEvidence> {
    let stem = path.file_stem()?.to_str()?;
    let raw_id = stem.strip_prefix("agent-")?;
    let subagents_dir = path.parent()?;
    if subagents_dir.file_name()?.to_str()? != "subagents" {
        return None;
    }
    let sidecar = path.with_file_name(format!("{stem}.meta.json"));
    let meta = fs::read(&sidecar)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null);
    let name = bounded_text(meta.get("agentType"), 80);
    let depth = non_negative(meta.get("spawnDepth"));
    let tool_invocation_key =
        bounded_text(meta.get("toolUseId"), 200).map(|id| invocation_key(Provider::Claude, account, &id));
    let parent_id = subagents_dir
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .map(|name| name.strip_prefix("agent-").unwrap_or(name));
    Some(AgentEvidence {
        key: Some(agent_key(Provider::Claude, account, raw_id)),
        identity_basis: "provider".into(),
        parent_key: parent_id.map(|id| agent_key(Provider::Claude, account, id)),
        parent_identity_basis: if parent_id.is_some() { "provider" } else { "unknown" }.into(),
        parent_evidence: if parent_id.is_some() { "structural" } else { "unknown" }.into(),
        class: classify_claude(name.as_deref()).into(),
        name,
        depth,
        depth_evidence: if depth.is_some() { "explicit" } else { "unknown" }.into(),
        model_requested: None,
        tool_invocation_key,
    })
}

fn claude_agent_for_line(
    state: &State,
    binding: &str,
    account: &str,
    object: &Map<String, Value>,
    file_agent: Option<&AgentEvidence>,
) -> Result<AgentEvidence, AdapterError> {
    let session_id = bounded_text(object.get("sessionId"), 200);
    let line_agent_id = bounded_text(object.get("agentId"), 200);
    let line_agent_key = line_agent_id.as_deref().map(|id| agent_key(Provider::Claude, account, id));
    let sidechain = object.get("isSidechain").and_then(Value::as_bool) == Some(true);
    let line_name = bounded_text(object.get("attributionAgent"), 80);
    let same_as_file = line_agent_key.as_deref().is_some_and(|key| {
        file_agent.and_then(|agent| agent.key.as_deref()).is_some_and(|file_key| file_key == key)
    });
    let mut evidence = if same_as_file || (line_agent_key.is_none() && file_agent.is_some()) {
        file_agent.cloned().unwrap_or_else(AgentEvidence::unknown)
    } else if line_agent_key.is_some() || sidechain {
        AgentEvidence::unknown()
    } else if let Some(session_id) = session_id.as_deref() {
        AgentEvidence::main(Provider::Claude, account, session_id)
    } else {
        AgentEvidence::unknown()
    };
    if let Some(key) = line_agent_key {
        evidence.key = Some(key);
        evidence.identity_basis = "provider".into();
    }
    if let Some(name) = line_name {
        evidence.class = classify_claude(Some(&name)).into();
        evidence.name = Some(name);
    }
    enrich_profile(state, binding, &mut evidence)?;
    if evidence.class != "main" && evidence.parent_key.is_none() {
        if !same_as_file
            && let Some(parent) = file_agent
            && let Some(parent_key) = parent.key.as_ref()
        {
            evidence.parent_key = Some(parent_key.clone());
            evidence.parent_identity_basis = parent.identity_basis.clone();
            evidence.parent_evidence = "structural".into();
            evidence.depth = parent.depth.and_then(|depth| depth.checked_add(1));
            evidence.depth_evidence = if evidence.depth.is_some() { "inferred" } else { "unknown" }.into();
        } else if let Some(session_id) = session_id {
            evidence.parent_key = Some(agent_key(Provider::Claude, account, &session_id));
            evidence.parent_identity_basis = "provider".into();
            evidence.parent_evidence = "fallback".into();
            evidence.depth = Some(1);
            evidence.depth_evidence = "inferred".into();
        }
    }
    Ok(evidence)
}

fn codex_agent_for_session(
    payload: &Value,
    account: &str,
    session: &str,
    session_from_provider: bool,
) -> AgentEvidence {
    let spawn = get(payload, "source")
        .ok()
        .flatten()
        .and_then(|source| get(source, "subagent").ok().flatten())
        .and_then(|subagent| get(subagent, "thread_spawn").ok().flatten())
        .filter(|value| value.is_object());
    let Some(spawn) = spawn else {
        let mut main = AgentEvidence::main(Provider::Codex, account, session);
        if !session_from_provider {
            main.identity_basis = "derived".into();
        }
        return main;
    };
    let parent = bounded_text(get(spawn, "parent_thread_id").ok().flatten(), 200);
    let role = bounded_text(get(spawn, "agent_role").ok().flatten(), 80)
        .or_else(|| bounded_text(get(payload, "agent_role").ok().flatten(), 80));
    let depth = non_negative(get(spawn, "depth").ok().flatten());
    AgentEvidence {
        key: Some(agent_key(Provider::Codex, account, session)),
        identity_basis: if session_from_provider { "provider" } else { "derived" }.into(),
        parent_key: parent.as_deref().map(|id| agent_key(Provider::Codex, account, id)),
        parent_identity_basis: if parent.is_some() { "provider" } else { "unknown" }.into(),
        parent_evidence: if parent.is_some() { "explicit" } else { "unknown" }.into(),
        class: classify_codex(role.as_deref()).into(),
        name: role,
        depth,
        depth_evidence: if depth.is_some() { "explicit" } else { "unknown" }.into(),
        model_requested: None,
        tool_invocation_key: None,
    }
}

fn claude_parent_agent(
    account: &str,
    object: &Map<String, Value>,
    file_agent: Option<&AgentEvidence>,
) -> AgentEvidence {
    if let Some(id) = bounded_text(object.get("agentId"), 200) {
        AgentEvidence {
            key: Some(agent_key(Provider::Claude, account, &id)),
            identity_basis: "provider".into(),
            parent_key: None,
            parent_identity_basis: "unknown".into(),
            parent_evidence: "unknown".into(),
            class: classify_claude(bounded_text(object.get("attributionAgent"), 80).as_deref()).into(),
            name: bounded_text(object.get("attributionAgent"), 80),
            depth: None,
            depth_evidence: "unknown".into(),
            model_requested: None,
            tool_invocation_key: None,
        }
    } else if let Some(agent) = file_agent {
        agent.clone()
    } else if let Some(session) = bounded_text(object.get("sessionId"), 200) {
        AgentEvidence::main(Provider::Claude, account, &session)
    } else {
        AgentEvidence::unknown()
    }
}

#[allow(clippy::too_many_arguments)]
fn process_claude_agent_lifecycle(
    state: &State,
    binding: &str,
    account: &str,
    object: &Map<String, Value>,
    file_agent: Option<&AgentEvidence>,
    timestamp: Option<f64>,
    since: f64,
    now: f64,
) -> Result<(), AdapterError> {
    let Some(ts) = timestamp.filter(|value| since <= *value && *value <= now + 300.0) else {
        return Ok(());
    };
    let Some(timestamp_text) = iso(ts).map(|value| value.as_str().to_owned()) else { return Ok(()) };
    let session_hash = object
        .get("sessionId")
        .filter(|value| py_truthy(value))
        .map(|session| digest(&json!([Provider::Claude.as_str(), account, session])).as_str().to_owned());
    let mut parent = claude_parent_agent(account, object, file_agent);
    enrich_profile(state, binding, &mut parent)?;
    let message = or_empty(object.get("message"));
    if let Some(content) = get(&message, "content").ok().flatten().and_then(Value::as_array) {
        for block in content {
            let Some(block) = block.as_object() else { continue };
            if block.get("type").and_then(Value::as_str) == Some("tool_use")
                && block.get("name").and_then(Value::as_str) == Some("Agent")
            {
                let Some(id) = bounded_text(block.get("id"), 200) else { continue };
                let input = block.get("input").filter(|value| value.is_object()).unwrap_or(&Value::Null);
                let role = bounded_text(get(input, "subagent_type").ok().flatten(), 80);
                let model = bounded_text(get(input, "model").ok().flatten(), 100);
                let invocation = invocation_key(Provider::Claude, account, &id);
                save_spawn_attempt(
                    state,
                    binding,
                    Provider::Claude,
                    account,
                    &invocation,
                    &timestamp_text,
                    session_hash.as_deref(),
                    &parent,
                    role.as_deref(),
                    model.as_deref(),
                )?;
            }
        }
    }
    let result = object.get("toolUseResult").filter(|value| value.is_object());
    let Some(result) = result else { return Ok(()) };
    let tool_id = get(&message, "content").ok().flatten().and_then(Value::as_array).and_then(|content| {
        content.iter().find_map(|block| {
            let block = block.as_object()?;
            (block.get("type").and_then(Value::as_str) == Some("tool_result"))
                .then(|| bounded_text(block.get("tool_use_id"), 200))
                .flatten()
        })
    });
    let Some(tool_id) = tool_id else { return Ok(()) };
    let invocation = invocation_key(Provider::Claude, account, &tool_id);
    let existing = state.agent_spawn_for_invocation(binding, &invocation)?;
    let agent_id = bounded_text(get(result, "agentId").ok().flatten(), 200);
    if existing.is_none() && agent_id.is_none() {
        return Ok(());
    }
    let role = existing.as_ref().and_then(|row| row.name.clone());
    let outcome = if agent_id.is_some() {
        "succeeded"
    } else {
        match bounded_text(get(result, "status").ok().flatten(), 30).as_deref() {
            Some("denied") => "denied",
            Some("cancelled" | "canceled") => "cancelled",
            Some("failed" | "error") => "failed",
            _ => "unknown",
        }
    };
    let mut child = AgentEvidence {
        key: agent_id.as_deref().map(|id| agent_key(Provider::Claude, account, id)),
        identity_basis: if agent_id.is_some() { "provider" } else { "unknown" }.into(),
        parent_key: existing.as_ref().and_then(|row| row.parent_key.clone()).or_else(|| parent.key.clone()),
        parent_identity_basis: existing
            .as_ref()
            .map_or_else(|| parent.identity_basis.clone(), |row| row.parent_identity_basis.clone()),
        parent_evidence: if existing.as_ref().is_some_and(|row| row.parent_key.is_some())
            || parent.key.is_some()
        {
            "explicit"
        } else {
            "unknown"
        }
        .into(),
        class: existing
            .as_ref()
            .map_or_else(|| classify_claude(role.as_deref()).into(), |row| row.class.clone()),
        name: role,
        depth: existing.as_ref().and_then(|row| row.depth),
        depth_evidence: if existing.as_ref().is_some_and(|row| row.depth.is_some()) {
            "inferred"
        } else {
            "unknown"
        }
        .into(),
        model_requested: existing.as_ref().and_then(|row| row.model_requested.clone()),
        tool_invocation_key: Some(invocation.clone()),
    };
    enrich_profile(state, binding, &mut child)?;
    complete_spawn(
        state,
        binding,
        Provider::Claude,
        account,
        &invocation,
        &timestamp_text,
        session_hash.as_deref(),
        &child,
        outcome,
    )?;
    Ok(())
}

fn explicit_outcome(value: Option<&str>) -> Option<&'static str> {
    match value.map(str::to_ascii_lowercase).as_deref() {
        Some("completed" | "complete" | "succeeded" | "success" | "ok") => Some("succeeded"),
        Some("failed" | "failure" | "error") => Some("failed"),
        Some("denied" | "rejected" | "permission_denied") => Some("denied"),
        Some("cancelled" | "canceled" | "aborted" | "interrupted") => Some("cancelled"),
        _ => None,
    }
}

fn result_text(value: &Value, remaining: &mut usize, depth: u8, out: &mut String) {
    if *remaining == 0 || depth > 8 {
        return;
    }
    match value {
        Value::String(text) => {
            let fragment: String = text.chars().take(*remaining).collect();
            *remaining -= fragment.chars().count();
            out.push_str(&fragment);
        }
        Value::Array(values) => {
            for value in values {
                result_text(value, remaining, depth + 1, out);
                if *remaining == 0 {
                    break;
                }
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if matches!(key.as_str(), "text" | "message" | "error" | "stderr" | "output") {
                    result_text(value, remaining, depth + 1, out);
                }
                if *remaining == 0 {
                    break;
                }
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn narrow_text_outcome(value: &Value) -> Option<&'static str> {
    let mut text = String::new();
    result_text(value, &mut 8_192, 0, &mut text);
    let text = text.to_ascii_lowercase();
    let marker = "process exited with code ";
    if let Some(rest) = text.split_once(marker).map(|(_, rest)| rest) {
        let code: String = rest
            .chars()
            .skip_while(|value| value.is_whitespace())
            .take_while(|value| value.is_ascii_digit() || *value == '-')
            .collect();
        if let Ok(code) = code.parse::<i64>() {
            return Some(if code == 0 { "succeeded" } else { "failed" });
        }
    }
    if [
        "permission request denied",
        "permission denied by user",
        "exec command rejected by user",
        "tool call rejected by user",
        "request was denied by the user",
    ]
    .iter()
    .any(|pattern| text.contains(pattern))
    {
        return Some("denied");
    }
    if ["command cancelled by user", "command canceled by user", "request cancelled by user"]
        .iter()
        .any(|pattern| text.contains(pattern))
    {
        return Some("cancelled");
    }
    None
}

fn structured_outcome(value: &Value, depth: u8) -> Option<&'static str> {
    if depth > 1 {
        return None;
    }
    match value {
        Value::Array(values) => values
            .iter()
            .filter(|value| value.is_object())
            .find_map(|value| structured_outcome(value, depth + 1)),
        Value::Object(values) => {
            for key in ["status", "outcome"] {
                if let Some(outcome) = explicit_outcome(values.get(key).and_then(Value::as_str)) {
                    return Some(outcome);
                }
            }
            if values.get("interrupted").and_then(Value::as_bool) == Some(true) {
                return Some("cancelled");
            }
            if values.get("is_error").and_then(Value::as_bool) == Some(true)
                || values.get("success").and_then(Value::as_bool) == Some(false)
            {
                return Some("failed");
            }
            if let Some(code) = values.get("exit_code").and_then(Value::as_i64) {
                return Some(if code == 0 { "succeeded" } else { "failed" });
            }
            if values.get("is_error").and_then(Value::as_bool) == Some(false)
                || values.get("success").and_then(Value::as_bool) == Some(true)
            {
                return Some("succeeded");
            }
            None
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => None,
    }
}

fn claude_result_outcome(block: &Map<String, Value>, outer: Option<&Value>) -> &'static str {
    let outer_status = outer.and_then(|value| value.get("status")).and_then(Value::as_str);
    let outer_outcome = explicit_outcome(outer_status);
    if let Some(outcome @ ("denied" | "cancelled" | "failed")) = outer_outcome {
        return outcome;
    }
    if outer.and_then(|value| value.get("interrupted")).and_then(Value::as_bool) == Some(true) {
        return "cancelled";
    }
    if block.get("is_error").and_then(Value::as_bool) == Some(true) {
        if let Some(outcome @ ("denied" | "cancelled")) = block.get("content").and_then(narrow_text_outcome) {
            return outcome;
        }
        return "failed";
    }
    if block.get("is_error").and_then(Value::as_bool) == Some(false) {
        return "succeeded";
    }
    if let Some(outcome @ ("denied" | "cancelled")) = block.get("content").and_then(narrow_text_outcome) {
        return outcome;
    }
    outer_outcome.unwrap_or("unknown")
}

fn codex_result_outcome(payload: &Value) -> &'static str {
    let status = payload.get("status").and_then(Value::as_str);
    if let Some(outcome) = explicit_outcome(status) {
        return outcome;
    }
    let output = payload.get("output").unwrap_or(&Value::Null);
    structured_outcome(output, 0).or_else(|| narrow_text_outcome(output)).unwrap_or("unknown")
}

#[allow(clippy::too_many_arguments)]
fn process_claude_tool_evidence(
    state: &State,
    binding: &str,
    account: &str,
    object: &Map<String, Value>,
    file_agent: Option<&AgentEvidence>,
    timestamp: Option<f64>,
    since: f64,
    now: f64,
) -> Result<(), AdapterError> {
    let Some(ts) = timestamp.filter(|value| since <= *value && *value <= now + 300.0) else {
        return Ok(());
    };
    let Some(timestamp) = iso(ts).map(|value| value.as_str().to_owned()) else { return Ok(()) };
    let message = or_empty(object.get("message"));
    let Some(content) = get(&message, "content").ok().flatten().and_then(Value::as_array) else {
        return Ok(());
    };
    let session_hash = object
        .get("sessionId")
        .filter(|value| py_truthy(value))
        .map(|session| digest(&json!([Provider::Claude.as_str(), account, session])).as_str().to_owned());
    let caller_request = get(&message, "id")
        .ok()
        .flatten()
        .filter(|value| py_truthy(value))
        .map(|id| digest(&json!([Provider::Claude.as_str(), account, id])).as_str().to_owned());
    let mut caller_agent = claude_agent_for_line(state, binding, account, object, file_agent)?;
    enrich_profile(state, binding, &mut caller_agent)?;
    let caller_is_subagent = is_known_child(&caller_agent);
    for block in content {
        let Some(block) = block.as_object() else { continue };
        match block.get("type").and_then(Value::as_str) {
            Some("tool_use") => {
                let raw_id =
                    block.get("id").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
                let raw_name = block.get("name").and_then(Value::as_str);
                if raw_id.is_none() || raw_name.is_none() {
                    state.mark_tool_coverage(binding, true, false)?;
                    continue;
                }
                let raw_id = raw_id.unwrap_or_default();
                let invocation = invocation_key(Provider::Claude, account, raw_id);
                let identity = claude_identity(raw_name);
                let parent = block
                    .get("parent_tool_use_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|id| invocation_key(Provider::Claude, account, id));
                state.mark_tool_coverage(binding, false, identity.name_truncated)?;
                save_tool_invocation(
                    state,
                    binding,
                    &invocation,
                    &timestamp,
                    session_hash.as_deref(),
                    caller_request.as_deref(),
                    caller_agent.key.as_deref(),
                    caller_is_subagent,
                    parent.as_deref(),
                    &identity,
                    "unknown",
                )?;
            }
            Some("tool_result") => {
                let Some(raw_id) = block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    state.mark_tool_coverage(binding, true, false)?;
                    continue;
                };
                let invocation = invocation_key(Provider::Claude, account, raw_id);
                let result = result_key(Provider::Claude, account, raw_id);
                let outcome = claude_result_outcome(block, object.get("toolUseResult"));
                save_tool_result(
                    state,
                    binding,
                    &result,
                    &invocation,
                    &timestamp,
                    outcome,
                    session_hash.as_deref(),
                    caller_agent.key.as_deref(),
                    caller_is_subagent,
                )?;
            }
            Some(kind) if kind.starts_with("tool_") => {
                state.mark_tool_coverage(binding, true, false)?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn derived_codex_tool_id(account: &str, session: &str, timestamp: Option<&Value>, payload: &Value) -> String {
    digest(&json!(["derived-tool", Provider::Codex.as_str(), account, session, timestamp, payload]))
        .as_str()
        .to_owned()
}

#[allow(clippy::too_many_arguments)]
fn process_codex_tool_evidence(
    state: &State,
    binding: &str,
    account: &str,
    object: &Map<String, Value>,
    payload: &Value,
    ctx: &mut Ctx,
    timestamp: Option<f64>,
    since: f64,
    now: f64,
) -> Result<(), AdapterError> {
    if object.get("type").and_then(Value::as_str) != Some("response_item") {
        return Ok(());
    }
    let Some(ts) = timestamp.filter(|value| since <= *value && *value <= now + 300.0) else {
        return Ok(());
    };
    let Some(timestamp_text) = iso(ts).map(|value| value.as_str().to_owned()) else { return Ok(()) };
    let Some(kind) = payload.get("type").and_then(Value::as_str) else { return Ok(()) };
    let call_kinds =
        ["function_call", "custom_tool_call", "mcp_tool_call", "web_search_call", "local_shell_call"];
    let result_kinds = [
        "function_call_output",
        "custom_tool_call_output",
        "mcp_tool_call_output",
        "local_shell_call_output",
    ];
    if !call_kinds.contains(&kind) && !result_kinds.contains(&kind) {
        if kind.contains("call") {
            state.mark_tool_coverage(binding, true, false)?;
        }
        return Ok(());
    }
    let provider_id = payload
        .get("call_id")
        .and_then(Value::as_str)
        .or_else(|| payload.get("id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if result_kinds.contains(&kind) && provider_id.is_none() {
        state.mark_tool_coverage(binding, true, false)?;
        return Ok(());
    }
    let raw_id = provider_id
        .unwrap_or_else(|| derived_codex_tool_id(account, &ctx.session, object.get("timestamp"), payload));
    let invocation = invocation_key(Provider::Codex, account, &raw_id);
    let session_hash = digest(&json!([Provider::Codex.as_str(), account, ctx.session]));
    let caller_agent_key = ctx.agent.as_ref().and_then(|agent| agent.key.as_deref());
    let caller_is_subagent = ctx.agent.as_ref().is_some_and(is_known_child);
    if result_kinds.contains(&kind) {
        let result = result_key(Provider::Codex, account, &raw_id);
        save_tool_result(
            state,
            binding,
            &result,
            &invocation,
            &timestamp_text,
            codex_result_outcome(payload),
            Some(session_hash.as_str()),
            caller_agent_key,
            caller_is_subagent,
        )?;
        return Ok(());
    }
    let raw_name = payload.get("name").and_then(Value::as_str);
    let raw_namespace = payload.get("namespace").and_then(Value::as_str);
    let identity = codex_identity(kind, raw_name, raw_namespace);
    let missing_name = !matches!(kind, "web_search_call" | "local_shell_call") && raw_name.is_none();
    state.mark_tool_coverage(binding, missing_name, identity.name_truncated)?;
    let parent = payload
        .get("parent_call_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|id| invocation_key(Provider::Codex, account, id));
    let server_outcome = matches!(kind, "web_search_call" | "local_shell_call")
        .then(|| explicit_outcome(payload.get("status").and_then(Value::as_str)))
        .flatten()
        .unwrap_or("unknown");
    save_tool_invocation(
        state,
        binding,
        &invocation,
        &timestamp_text,
        Some(session_hash.as_str()),
        None,
        caller_agent_key,
        caller_is_subagent,
        parent.as_deref(),
        &identity,
        server_outcome,
    )?;
    if !ctx.pending_tool_invocations.contains(&invocation) {
        ctx.pending_tool_invocations.push(invocation);
    }
    Ok(())
}

fn claude_evidence(object: &Map<String, Value>, usage: &Value) -> RequestEvidence {
    let input_fresh = non_negative(get(usage, "input_tokens").ok().flatten());
    let input_cached = non_negative(get(usage, "cache_read_input_tokens").ok().flatten());
    let input_cache_write = non_negative(get(usage, "cache_creation_input_tokens").ok().flatten());
    let output = non_negative(get(usage, "output_tokens").ok().flatten());
    let reasoning = get(usage, "output_tokens_details")
        .ok()
        .flatten()
        .and_then(|details| get(details, "thinking_tokens").ok().flatten())
        .and_then(|value| non_negative(Some(value)))
        .filter(|value| output.is_none_or(|output| *value <= output));
    let cache_creation = get(usage, "cache_creation").ok().flatten();
    let five_minute = cache_creation
        .and_then(|value| get(value, "ephemeral_5m_input_tokens").ok().flatten())
        .and_then(|value| non_negative(Some(value)))
        .unwrap_or(0);
    let one_hour = cache_creation
        .and_then(|value| get(value, "ephemeral_1h_input_tokens").ok().flatten())
        .and_then(|value| non_negative(Some(value)))
        .unwrap_or(0);
    let cache_write_ttl = match (five_minute > 0, one_hour > 0) {
        (true, true) => Some("mixed".to_owned()),
        (true, false) => Some("5m".to_owned()),
        (false, true) => Some("1h".to_owned()),
        (false, false) => None,
    };
    RequestEvidence {
        input_fresh,
        input_cached,
        input_cache_write,
        output,
        reasoning,
        reasoning_effort: bounded_code(object.get("effort")),
        service_tier: bounded_code(get(usage, "service_tier").ok().flatten()),
        speed: bounded_code(get(usage, "speed").ok().flatten()),
        cache_write_ttl,
        outcome: Some(
            if object.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
                "failed"
            } else {
                "completed"
            }
            .to_owned(),
        ),
        ..RequestEvidence::default()
    }
}

fn codex_evidence(ctx: &Ctx, info: &Value, usage: &Value) -> RequestEvidence {
    let input_total = non_negative(get(usage, "input_tokens").ok().flatten());
    let input_cached = non_negative(get(usage, "cached_input_tokens").ok().flatten());
    let input_cache_write = non_negative(get(usage, "cache_write_input_tokens").ok().flatten());
    let input_fresh = match (input_total, input_cached, input_cache_write) {
        (Some(total), Some(cached), Some(written)) => {
            Some(total.saturating_sub(cached.saturating_add(written)))
        }
        _ => None,
    };
    let output = non_negative(get(usage, "output_tokens").ok().flatten());
    let reasoning = non_negative(get(usage, "reasoning_output_tokens").ok().flatten())
        .filter(|value| output.is_none_or(|output| *value <= output));
    RequestEvidence {
        input_fresh,
        input_cached,
        input_cache_write,
        output,
        reasoning,
        reported_total: non_negative(get(usage, "total_tokens").ok().flatten()),
        reasoning_effort: ctx.reasoning_effort.clone(),
        context_window_tokens: non_negative(get(info, "model_context_window").ok().flatten()),
        outcome: Some("completed".to_owned()),
        ..RequestEvidence::default()
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
    evidence: &RequestEvidence,
    extras: &EventExtras,
    client_version: Option<&str>,
    attribution: Attribution<'_>,
) -> Result<(), AdapterError> {
    let Some(hour) = iso(hour_floor(timestamp) as f64) else { return Ok(()) };
    let bucket_eligible = values.iter().sum::<i64>() != 0;
    let has_token_evidence = [
        evidence.input_fresh,
        evidence.input_cached,
        evidence.input_cache_write,
        evidence.output,
        evidence.reasoning,
        evidence.reported_total,
    ]
    .iter()
    .any(Option::is_some);
    if !bucket_eligible && !has_token_evidence {
        return Ok(());
    }
    let project = attribution.cwd.and_then(normalize_cwd).map(|cwd| (project_hash(&cwd), cwd));
    if let Some((hash, cwd)) = &project {
        state.upsert_project(binding, hash.as_str(), cwd, timestamp_text)?;
    }
    let hash_text = project.as_ref().map(|(hash, _)| hash.as_str().to_owned());
    let agent = attribution.agent;
    match state.event(binding, event_id)? {
        Some(old) => {
            let max_option = |old: Option<i64>, new: Option<i64>| match (old, new) {
                (Some(old), Some(new)) => Some(old.max(new)),
                (old, new) => old.or(new),
            };
            state.insert_event(
                binding,
                &EventRow {
                    id: old.id,
                    session: old.session,
                    hour: old.hour,
                    model: if old.model == "unknown" && model != "unknown" {
                        model.to_owned()
                    } else {
                        old.model
                    },
                    input_tokens: old.input_tokens.max(values[0]),
                    cached_tokens: old.cached_tokens.max(values[1]),
                    cache_write_tokens: old.cache_write_tokens.max(values[2]),
                    output_tokens: old.output_tokens.max(values[3]),
                    session_identity: old.session_identity,
                    timestamp: old.timestamp,
                    product: old.product,
                    client_version: old.client_version.or_else(|| client_version.map(str::to_owned)),
                    parent_session: old.parent_session.or_else(|| extras.parent_session.clone()),
                    project_hash: old.project_hash.or(hash_text),
                    surface: old.surface.or_else(|| attribution.surface.map(str::to_owned)),
                    detail_observed: true,
                    bucket_eligible: old.bucket_eligible || bucket_eligible,
                    detail_input_fresh: max_option(old.detail_input_fresh, evidence.input_fresh),
                    detail_input_cached: max_option(old.detail_input_cached, evidence.input_cached),
                    detail_input_cache_write: max_option(
                        old.detail_input_cache_write,
                        evidence.input_cache_write,
                    ),
                    detail_output: max_option(old.detail_output, evidence.output),
                    detail_reasoning: max_option(old.detail_reasoning, evidence.reasoning),
                    reported_total: max_option(old.reported_total, evidence.reported_total),
                    model_requested: old
                        .model_requested
                        .or_else(|| evidence.model_requested.clone())
                        .or_else(|| agent.and_then(|value| value.model_requested.clone())),
                    reasoning_effort: old.reasoning_effort.or_else(|| evidence.reasoning_effort.clone()),
                    service_tier: old.service_tier.or_else(|| evidence.service_tier.clone()),
                    speed: old.speed.or_else(|| evidence.speed.clone()),
                    context_window_tokens: max_option(
                        old.context_window_tokens,
                        evidence.context_window_tokens,
                    ),
                    cache_write_ttl: old.cache_write_ttl.or_else(|| evidence.cache_write_ttl.clone()),
                    outcome: evidence.outcome.clone().or(old.outcome),
                    agent_observed: old.agent_observed || agent.is_some(),
                    agent_key: old.agent_key.or_else(|| agent.and_then(|value| value.key.clone())),
                    agent_identity_basis: if old.agent_identity_basis == "unknown" {
                        agent.map_or_else(|| "unknown".into(), |value| value.identity_basis.clone())
                    } else {
                        old.agent_identity_basis
                    },
                    parent_agent_key: old
                        .parent_agent_key
                        .or_else(|| agent.and_then(|value| value.parent_key.clone())),
                    parent_agent_identity_basis: if old.parent_agent_identity_basis == "unknown" {
                        agent.map_or_else(|| "unknown".into(), |value| value.parent_identity_basis.clone())
                    } else {
                        old.parent_agent_identity_basis
                    },
                    agent_class: if old.agent_class == "unknown" {
                        agent.map_or_else(|| "unknown".into(), |value| value.class.clone())
                    } else {
                        old.agent_class
                    },
                    agent_name: old.agent_name.or_else(|| agent.and_then(|value| value.name.clone())),
                    agent_depth: old.agent_depth.or_else(|| agent.and_then(|value| value.depth)),
                },
            )?;
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
                    detail_observed: true,
                    bucket_eligible,
                    detail_input_fresh: evidence.input_fresh,
                    detail_input_cached: evidence.input_cached,
                    detail_input_cache_write: evidence.input_cache_write,
                    detail_output: evidence.output,
                    detail_reasoning: evidence.reasoning,
                    reported_total: evidence.reported_total,
                    model_requested: evidence
                        .model_requested
                        .clone()
                        .or_else(|| agent.and_then(|value| value.model_requested.clone())),
                    reasoning_effort: evidence.reasoning_effort.clone(),
                    service_tier: evidence.service_tier.clone(),
                    speed: evidence.speed.clone(),
                    context_window_tokens: evidence.context_window_tokens,
                    cache_write_ttl: evidence.cache_write_ttl.clone(),
                    outcome: evidence.outcome.clone(),
                    agent_observed: agent.is_some(),
                    agent_key: agent.and_then(|value| value.key.clone()),
                    agent_identity_basis: agent
                        .map_or_else(|| "unknown".into(), |value| value.identity_basis.clone()),
                    parent_agent_key: agent.and_then(|value| value.parent_key.clone()),
                    parent_agent_identity_basis: agent
                        .map_or_else(|| "unknown".into(), |value| value.parent_identity_basis.clone()),
                    agent_class: agent.map_or_else(|| "unknown".into(), |value| value.class.clone()),
                    agent_name: agent.and_then(|value| value.name.clone()),
                    agent_depth: agent.and_then(|value| value.depth),
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

    if provider == Provider::Claude {
        process_claude_agent_lifecycle(
            state,
            binding,
            account,
            object,
            ctx.agent.as_ref(),
            timestamp,
            since,
            now,
        )?;
        process_claude_tool_evidence(
            state,
            binding,
            account,
            object,
            ctx.agent.as_ref(),
            timestamp,
            since,
            now,
        )?;
    }

    if provider == Provider::Codex {
        if ctx.own_started {
            process_codex_tool_evidence(
                state, binding, account, object, &payload, ctx, timestamp, since, now,
            )?;
        }
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
                ctx.agent =
                    Some(codex_agent_for_session(&payload, account, &ctx.session, ctx.session_from_provider));
                if let Some(agent) = ctx.agent.as_ref() {
                    save_profile(state, binding, agent)?;
                    if extras.include_subagents
                        && agent.class != "main"
                        && let Some(observed_at) =
                            timestamp.filter(|value| since <= *value && *value <= now + 300.0).and_then(iso)
                    {
                        let session_hash = digest(&json!([provider_text, account, ctx.session]));
                        save_observed_spawn(
                            state,
                            binding,
                            provider,
                            account,
                            observed_at.as_str(),
                            session_hash.as_str(),
                            agent,
                        )?;
                        save_observed_start(
                            state,
                            binding,
                            provider,
                            account,
                            observed_at.as_str(),
                            session_hash.as_str(),
                            agent,
                        )?;
                    }
                }
            }
            Some("turn_context") => {
                // A new turn proves any earlier call with no accounting event
                // has no supported caller-request join. Keep the call itself.
                ctx.pending_tool_invocations.clear();
                let Ok(model) = get(&payload, "model") else { return Ok(Err(Malformed)) };
                let chosen = match model {
                    Some(v) if py_truthy(v) => py_str(v),
                    _ if !ctx.model.is_empty() => ctx.model.clone(),
                    _ => "unknown".to_owned(),
                };
                ctx.model = truncate100(chosen);
                ctx.reasoning_effort = bounded_code(get(&payload, "effort").ok().flatten());
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
                        if !extras.include_subagents
                            && ctx.agent.as_ref().is_some_and(|agent| agent.class != "main")
                        {
                            return Ok(Ok(()));
                        }
                        if let Err(AdapterError::Io) = save_codex_quotas(state, binding, &payload, ts) {
                            return Ok(Err(Malformed));
                        }
                        let Ok(usage) = get(&info, "last_token_usage") else { return Ok(Err(Malformed)) };
                        let Some(usage) = usage.filter(|v| v.is_object()) else { return Ok(Ok(())) };
                        let mut usage_value = usage.clone();
                        let mut legacy_delta_accepted = false;
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
                            // Keep the compatibility delta exactly aligned with v1.
                            // Nullable reasoning evidence must not decide whether
                            // the legacy token counters use cumulative deltas.
                            let legacy_keys = [
                                "input_tokens",
                                "cached_input_tokens",
                                "cache_write_input_tokens",
                                "output_tokens",
                                "total_tokens",
                            ];
                            let mut deltas = Map::new();
                            let mut all_non_negative = true;
                            for key in legacy_keys {
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
                                legacy_delta_accepted = true;
                            }
                        }
                        let mut detail_usage_value = usage.clone();
                        if cumulative_truthy && previous_truthy {
                            let (Some(cumulative_value), Some(previous_value)) =
                                (cumulative.as_ref(), previous.as_ref())
                            else {
                                return Ok(Err(Malformed));
                            };
                            let mut detail_deltas = Map::new();
                            let core_keys = [
                                "input_tokens",
                                "cached_input_tokens",
                                "cache_write_input_tokens",
                                "output_tokens",
                                "total_tokens",
                            ];
                            for key in core_keys {
                                let delta = legacy_delta_accepted
                                    .then(|| {
                                        let current =
                                            non_negative(get(cumulative_value, key).ok().flatten())?;
                                        let before = non_negative(get(previous_value, key).ok().flatten())?;
                                        (current >= before).then_some(current - before)
                                    })
                                    .flatten();
                                if let Some(value) =
                                    delta.or_else(|| non_negative(get(usage, key).ok().flatten()))
                                {
                                    detail_deltas.insert(key.to_owned(), Value::from(value));
                                }
                            }
                            let reasoning_delta = legacy_delta_accepted
                                .then(|| {
                                    let current = non_negative(
                                        get(cumulative_value, "reasoning_output_tokens").ok().flatten(),
                                    )?;
                                    let before = non_negative(
                                        get(previous_value, "reasoning_output_tokens").ok().flatten(),
                                    )?;
                                    (current >= before).then_some(current - before)
                                })
                                .flatten();
                            if let Some(value) = reasoning_delta.or_else(|| {
                                non_negative(get(usage, "reasoning_output_tokens").ok().flatten())
                            }) {
                                detail_deltas
                                    .insert("reasoning_output_tokens".to_owned(), Value::from(value));
                            }
                            detail_usage_value = Value::Object(detail_deltas);
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
                        let mut request_agent = ctx.agent.clone().unwrap_or_else(AgentEvidence::unknown);
                        enrich_profile(state, binding, &mut request_agent)?;
                        let mut evidence = codex_evidence(ctx, &info, &detail_usage_value);
                        evidence.model_requested = request_agent.model_requested.clone();
                        let model =
                            if ctx.model.is_empty() { "unknown".to_owned() } else { ctx.model.clone() };
                        let timestamp_text = raw_timestamp.as_str().unwrap_or("").to_owned();
                        if request_agent.key.is_some() {
                            save_observed_start(
                                state,
                                binding,
                                provider,
                                account,
                                &timestamp_text,
                                session_hash.as_str(),
                                &request_agent,
                            )?;
                        }
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
                            &evidence,
                            extras,
                            ctx.client_version.as_deref(),
                            Attribution {
                                cwd: ctx.cwd.as_deref(),
                                surface: ctx.surface.as_deref(),
                                agent: Some(&request_agent),
                            },
                        )?;
                        state.assign_tool_caller_request(
                            binding,
                            &ctx.pending_tool_invocations,
                            event_id.as_str(),
                        )?;
                        ctx.pending_tool_invocations.clear();
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
    let mut agent = claude_agent_for_line(state, binding, account, object, ctx.agent.as_ref())?;
    enrich_profile(state, binding, &mut agent)?;
    if !extras.include_subagents && is_known_child(&agent) {
        return Ok(Ok(()));
    }
    let client_version =
        object.get("version").and_then(Value::as_str).map(|v| v.chars().take(40).collect::<String>());
    let timestamp_text = object.get("timestamp").and_then(Value::as_str).unwrap_or("").to_owned();
    save_observed_start(state, binding, provider, account, &timestamp_text, session_hash.as_str(), &agent)?;
    enrich_profile(state, binding, &mut agent)?;
    let mut evidence = claude_evidence(object, usage);
    evidence.model_requested = agent.model_requested.clone();
    let attribution = Attribution {
        cwd: object.get("cwd").and_then(Value::as_str),
        surface: Some(claude_surface(object.get("entrypoint").and_then(Value::as_str))),
        agent: Some(&agent),
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
        &evidence,
        extras,
        client_version.as_deref(),
        attribution,
    )?;
    Ok(Ok(()))
}

/// Only lines containing one of these bytes are parsed.
const INTERESTING: [&[u8]; 8] = [
    b"token_count",
    b"session_meta",
    b"turn_context",
    b"task_started",
    b"\"assistant\"",
    b"toolUseResult",
    b"tool_result",
    b"_call",
];

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
    let scan_generation = format!("{}:subagents={include_subagents}", crate::EXECUTION_PARSER_VERSION);
    state.prepare_file_scan(binding_id, &scan_generation)?;
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
                include_subagents,
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
            let current_file_agent =
                (provider == Provider::Claude).then(|| claude_file_agent(&resolved, account)).flatten();
            let previous_file_agent = old
                .as_ref()
                .and_then(|checkpoint| serde_json::from_str::<Ctx>(&checkpoint.context).ok())
                .and_then(|context| context.agent);
            let agent_metadata_changed =
                provider == Provider::Claude && old.is_some() && previous_file_agent != current_file_agent;
            if let Some(old) = &old
                && old.size == size
                && old.mtime_ns == mtime
                && !agent_metadata_changed
            {
                continue;
            }
            let resume = !agent_metadata_changed
                && old.as_ref().is_some_and(|old| old.inode == inode && size >= old.size);
            let mut found_parse_gap = false;
            let stem = resolved.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let mut offset = if resume { old.as_ref().map_or(0, |old| old.offset) } else { 0 };
            let mut ctx = if resume {
                old.as_ref()
                    .and_then(|old| serde_json::from_str(&old.context).ok())
                    .unwrap_or_else(|| Ctx::fresh(&stem))
            } else {
                Ctx::fresh(&stem)
            };
            if provider == Provider::Claude && (!resume || ctx.agent.is_none()) {
                ctx.agent = current_file_agent;
            }
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
                            Err(Malformed) => {
                                metrics.malformed_lines += 1;
                                found_parse_gap = true;
                            }
                        },
                        Err(_) => {
                            metrics.malformed_lines += 1;
                            found_parse_gap = true;
                        }
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
                if found_parse_gap {
                    state.mark_file_parse_gap(binding_id, &path_text)?;
                } else if !resume {
                    state.clear_file_parse_gap(binding_id, &path_text)?;
                }
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
    metrics.history_gap_files = state.file_parse_gap_count(binding_id)?;
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

    #[test]
    fn codex_file_fallback_agent_identity_is_derived() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let mut ctx = Ctx::fresh("filename");
        let line = json!({
            "timestamp": "2026-09-02T04:00:00Z",
            "type": "session_meta",
            "payload": { "timestamp": "2026-09-02T04:00:00Z" }
        });
        let result = process_line(
            &state,
            "binding",
            &line,
            &mut ctx,
            Provider::Codex,
            "account",
            0.0,
            2_000_000_000.0,
            &EventExtras { product: "codex", parent_session: None, include_subagents: true },
        )
        .unwrap();
        assert!(result.is_ok());
        assert!(!ctx.session_from_provider);
        let main = ctx.agent.unwrap();
        assert_eq!(main.identity_basis, "derived");
        assert_eq!(main.class, "main");
        assert_eq!(main.depth, Some(0));

        let provider = codex_agent_for_session(&json!({}), "account", "thread-id", true);
        assert_eq!(provider.identity_basis, "provider");
    }

    #[test]
    fn outcome_classification_prefers_explicit_failures_and_handles_unicode() {
        let block = json!({ "is_error": true, "content": "synthetic failure" });
        let block = block.as_object().unwrap();
        assert_eq!(claude_result_outcome(block, Some(&json!({ "status": "completed" }))), "failed");
        let denied = json!({ "is_error": true, "content": "permission request denied 🔒" });
        assert_eq!(claude_result_outcome(denied.as_object().unwrap(), None), "denied");
        let successful_text = json!({
            "is_error": false,
            "content": "Documentation example: permission request denied"
        });
        assert_eq!(claude_result_outcome(successful_text.as_object().unwrap(), None), "succeeded");
        assert_eq!(codex_result_outcome(&json!({ "output": "Process exited with code 0\n✅" })), "succeeded");
        assert_eq!(
            codex_result_outcome(&json!({
                "output": "Process exited with code 0\nFinal output: permission request denied"
            })),
            "succeeded"
        );
        assert_eq!(
            codex_result_outcome(&json!({
                "output": { "success": true, "output": "permission request denied" }
            })),
            "succeeded"
        );
        assert_eq!(
            codex_result_outcome(&json!({
                "output": { "exit_code": 0, "output": "permission request denied" }
            })),
            "succeeded"
        );
        assert_eq!(
            codex_result_outcome(&json!({ "output": [{ "type": "text", "text": "{\"success\":true}" }] })),
            "unknown"
        );
    }
}
