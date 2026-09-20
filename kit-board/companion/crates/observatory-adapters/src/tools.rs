//! Privacy-safe tool invocation evidence shared by local execution adapters.
//! Provider call identifiers are hashed immediately. Arguments and results are
//! inspected only while parsing and are never retained in companion state.
//! Custom, MCP, and function names are hashed under the install's privacy key
//! (`observatory_core::privacy`), so the same tool hashes differently on every
//! machine and a hash cannot be confirmed by guessing the name.

use std::collections::{BTreeMap, HashMap};
use std::str::FromStr;

use observatory_contract::settings::ToolDetail;
use observatory_contract::{
    Adapter, Basis, Channel, Code, Counter, EventOutcome, Nullable, Provider, Record, Sha256Hex, Stamp,
    ToolClass, ToolCount, ToolEvent, ToolEventKind, ToolIdentity, ToolName, Uuid,
};
use observatory_core::adapter::record_id;
use observatory_core::privacy::{PrivacyKey, tool_name_hash, tool_namespace_hash};
use observatory_core::pyjson::digest;
use observatory_core::state::{State, StateError, ToolEventRow};
use serde_json::json;

const RAW_NAME_LIMIT: usize = 400;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolEvidence {
    pub class: String,
    pub name: Option<String>,
    pub name_hash: Option<String>,
    pub namespace: Option<String>,
    pub namespace_hash: Option<String>,
    pub name_truncated: bool,
}

impl ToolEvidence {
    /// The hashes cover the bounded name within its namespace, so a stored row
    /// (which keeps the same bounded values) can be re-keyed later.
    fn new(key: &PrivacyKey, class: &str, name: Option<&str>, namespace: Option<&str>) -> Self {
        let (name, name_truncated) = bounded_raw(name);
        let (namespace, namespace_truncated) = bounded_raw(namespace);
        let name_hash = name.as_deref().map(|name| tool_name_hash(key, namespace.as_deref(), name));
        let namespace_hash = namespace.as_deref().map(|namespace| tool_namespace_hash(key, namespace));
        Self {
            class: class.to_owned(),
            name,
            name_hash,
            namespace,
            namespace_hash,
            name_truncated: name_truncated || namespace_truncated,
        }
    }

    pub fn unknown() -> Self {
        Self {
            class: "unknown".to_owned(),
            name: None,
            name_hash: None,
            namespace: None,
            namespace_hash: None,
            name_truncated: false,
        }
    }
}

fn bounded_raw(value: Option<&str>) -> (Option<String>, bool) {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return (None, false);
    };
    let truncated = value.chars().count() > RAW_NAME_LIMIT;
    (Some(value.chars().take(RAW_NAME_LIMIT).collect()), truncated)
}

fn claude_builtin(name: &str) -> bool {
    matches!(
        name,
        "Agent"
            | "AskUserQuestion"
            | "Bash"
            | "BashOutput"
            | "Edit"
            | "EnterPlanMode"
            | "ExitPlanMode"
            | "Glob"
            | "Grep"
            | "KillShell"
            | "LS"
            | "MultiEdit"
            | "NotebookEdit"
            | "NotebookRead"
            | "PowerShell"
            | "Read"
            | "Skill"
            | "SlashCommand"
            | "Task"
            | "TaskOutput"
            | "TaskStop"
            | "TodoWrite"
            | "WebFetch"
            | "WebSearch"
            | "Write"
    )
}

fn codex_builtin_name(name: &str) -> bool {
    matches!(
        name,
        "apply_patch"
            | "create_goal"
            | "exec"
            | "exec_command"
            | "get_goal"
            | "local_shell"
            | "request_user_input"
            | "request_user_input_async"
            | "shell_command"
            | "update_goal"
            | "update_plan"
            | "view_image"
            | "wait"
            | "web_search"
            | "write_stdin"
    )
}

fn codex_builtin_namespace(namespace: &str) -> bool {
    matches!(namespace, "clock" | "codex_app" | "collaboration" | "image_gen" | "multi_agent_v1" | "web")
}

pub fn claude_identity(key: &PrivacyKey, raw_name: Option<&str>) -> ToolEvidence {
    let Some(raw_name) = raw_name.map(str::trim).filter(|value| !value.is_empty()) else {
        return ToolEvidence::unknown();
    };
    if let Some(rest) = raw_name.strip_prefix("mcp__") {
        let mut parts = rest.splitn(2, "__");
        let namespace = parts.next().filter(|value| !value.is_empty());
        let name = parts.next().filter(|value| !value.is_empty()).unwrap_or(raw_name);
        ToolEvidence::new(key, "mcp", Some(name), namespace)
    } else if claude_builtin(raw_name) {
        ToolEvidence::new(key, "builtin", Some(raw_name), None)
    } else {
        ToolEvidence::new(key, "custom", Some(raw_name), None)
    }
}

pub fn codex_identity(
    key: &PrivacyKey,
    kind: &str,
    raw_name: Option<&str>,
    raw_namespace: Option<&str>,
) -> ToolEvidence {
    match kind {
        "web_search_call" => ToolEvidence::new(key, "builtin", Some("web_search"), None),
        "local_shell_call" => ToolEvidence::new(key, "builtin", Some("local_shell"), None),
        "mcp_tool_call" => ToolEvidence::new(key, "mcp", raw_name, raw_namespace),
        "custom_tool_call" => {
            let class = if raw_name.is_some_and(codex_builtin_name) { "builtin" } else { "custom" };
            ToolEvidence::new(key, class, raw_name, raw_namespace)
        }
        "function_call" => {
            let class = match raw_namespace {
                Some(namespace) if namespace.starts_with("mcp__") => "mcp",
                Some(namespace) if codex_builtin_namespace(namespace) => "builtin",
                None if raw_name.is_some_and(codex_builtin_name) => "builtin",
                _ => "function",
            };
            ToolEvidence::new(key, class, raw_name, raw_namespace)
        }
        _ => ToolEvidence::unknown(),
    }
}

pub fn result_key(provider: Provider, account: &str, provider_id: &str) -> String {
    digest(&json!(["tool-result", provider.as_str(), account, provider_id])).as_str().to_owned()
}

#[allow(clippy::too_many_arguments)]
pub fn save_invocation(
    state: &State,
    binding: &str,
    invocation_key: &str,
    timestamp: &str,
    session_hash: Option<&str>,
    caller_request_key: Option<&str>,
    caller_agent_key: Option<&str>,
    caller_is_subagent: bool,
    parent_invocation_key: Option<&str>,
    identity: &ToolEvidence,
    outcome: &str,
) -> Result<(), StateError> {
    state.upsert_tool_event(
        binding,
        &ToolEventRow {
            id: invocation_key.to_owned(),
            timestamp: timestamp.to_owned(),
            event_kind: "invocation".into(),
            invocation_key: invocation_key.to_owned(),
            session_hash: session_hash.map(str::to_owned),
            caller_request_key: caller_request_key.map(str::to_owned),
            caller_agent_key: caller_agent_key.map(str::to_owned),
            caller_is_subagent,
            parent_invocation_key: parent_invocation_key.map(str::to_owned),
            class: identity.class.clone(),
            name: identity.name.clone(),
            name_hash: identity.name_hash.clone(),
            namespace: identity.namespace.clone(),
            namespace_hash: identity.namespace_hash.clone(),
            outcome: outcome.to_owned(),
            name_truncated: identity.name_truncated,
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub fn save_result(
    state: &State,
    binding: &str,
    id: &str,
    invocation_key: &str,
    timestamp: &str,
    outcome: &str,
    session_hash: Option<&str>,
    caller_agent_key: Option<&str>,
    caller_is_subagent: bool,
) -> Result<(), StateError> {
    let invocation = state.tool_invocation(binding, invocation_key)?;
    state.upsert_tool_event(
        binding,
        &ToolEventRow {
            id: id.to_owned(),
            timestamp: timestamp.to_owned(),
            event_kind: "result".into(),
            invocation_key: invocation_key.to_owned(),
            session_hash: invocation
                .as_ref()
                .and_then(|row| row.session_hash.clone())
                .or_else(|| session_hash.map(str::to_owned)),
            caller_request_key: invocation.as_ref().and_then(|row| row.caller_request_key.clone()),
            caller_agent_key: invocation
                .as_ref()
                .and_then(|row| row.caller_agent_key.clone())
                .or_else(|| caller_agent_key.map(str::to_owned)),
            caller_is_subagent: invocation.as_ref().is_some_and(|row| row.caller_is_subagent)
                || caller_is_subagent,
            parent_invocation_key: invocation.as_ref().and_then(|row| row.parent_invocation_key.clone()),
            class: invocation.as_ref().map_or_else(|| "unknown".into(), |row| row.class.clone()),
            name: invocation.as_ref().and_then(|row| row.name.clone()),
            name_hash: invocation.as_ref().and_then(|row| row.name_hash.clone()),
            namespace: invocation.as_ref().and_then(|row| row.namespace.clone()),
            namespace_hash: invocation.as_ref().and_then(|row| row.namespace_hash.clone()),
            outcome: outcome.to_owned(),
            name_truncated: invocation.as_ref().is_some_and(|row| row.name_truncated),
        },
    )
}

fn display_name(row: &ToolEventRow, detail: ToolDetail) -> Option<ToolName> {
    if detail == ToolDetail::Off {
        return None;
    }
    let class = ToolClass::from_str(&row.class).ok()?;
    match class {
        ToolClass::Builtin => row.name.as_deref().and_then(|name| ToolName::from_str(name).ok()),
        ToolClass::Mcp | ToolClass::Function | ToolClass::Custom if detail == ToolDetail::HashedCustom => {
            row.name_hash.as_deref().and_then(|name| ToolName::from_str(name).ok())
        }
        ToolClass::Mcp | ToolClass::Function | ToolClass::Custom | ToolClass::Unknown => None,
    }
}

fn display_namespace(row: &ToolEventRow, detail: ToolDetail) -> Option<Code> {
    if detail == ToolDetail::Off {
        return None;
    }
    let class = ToolClass::from_str(&row.class).ok()?;
    match class {
        ToolClass::Builtin => row.namespace.as_deref().and_then(|value| Code::from_str(value).ok()),
        ToolClass::Mcp | ToolClass::Function | ToolClass::Custom if detail == ToolDetail::HashedCustom => {
            row.namespace_hash.as_deref().and_then(|value| Code::from_str(value).ok())
        }
        ToolClass::Mcp | ToolClass::Function | ToolClass::Custom | ToolClass::Unknown => None,
    }
}

pub fn record_from_event(
    binding: &Uuid,
    adapter: Adapter,
    parser_version: &str,
    detail: ToolDetail,
    row: &ToolEventRow,
) -> Option<Record> {
    let event_kind = ToolEventKind::from_str(&row.event_kind).ok()?;
    let class = ToolClass::from_str(&row.class).ok()?;
    Some(Record::ToolEvent(ToolEvent {
        record_id: record_id(binding, Channel::LocalFile, &format!("tool:{}", row.id)),
        binding_id: binding.clone(),
        adapter,
        channel: Channel::LocalFile,
        observed_at: Stamp::parse(&row.timestamp).ok()?,
        basis: Basis::Exact,
        parser_version: observatory_contract::Text::truncated(parser_version).ok()?,
        semantic_key: Sha256Hex::try_from(row.id.clone()).ok()?,
        invocation_key: Sha256Hex::try_from(row.invocation_key.clone()).ok()?,
        event_kind,
        session_hash: Nullable(row.session_hash.clone().and_then(|value| Sha256Hex::try_from(value).ok())),
        caller_request_key: Nullable(
            row.caller_request_key.clone().and_then(|value| Sha256Hex::try_from(value).ok()),
        ),
        caller_agent_key: Nullable(
            row.caller_agent_key.clone().and_then(|value| Sha256Hex::try_from(value).ok()),
        ),
        parent_invocation_key: Nullable(
            row.parent_invocation_key.clone().and_then(|value| Sha256Hex::try_from(value).ok()),
        ),
        tool: ToolIdentity {
            name: Nullable(display_name(row, detail)),
            namespace: Nullable(display_namespace(row, detail)),
            class,
        },
        outcome: EventOutcome::from_str(&row.outcome).unwrap_or(EventOutcome::Unknown),
    }))
}

/// A binding's tool invocations grouped by the request that issued them, built
/// once per binding so each request's summary is a lookup rather than a pass
/// over every tool row. Rows keep their `tool_events` order within a request.
pub struct ToolIndex<'a> {
    by_request: HashMap<&'a str, Vec<&'a ToolEventRow>>,
}

impl<'a> ToolIndex<'a> {
    pub fn new(rows: &'a [ToolEventRow]) -> Self {
        let mut by_request: HashMap<&'a str, Vec<&'a ToolEventRow>> = HashMap::new();
        for row in rows {
            if row.event_kind == "invocation"
                && let Some(request_key) = row.caller_request_key.as_deref()
            {
                by_request.entry(request_key).or_default().push(row);
            }
        }
        ToolIndex { by_request }
    }

    /// Headline invocation total plus privacy-filtered names for one request.
    pub fn request_summary(
        &self,
        request_key: &str,
        include_subagents: bool,
        detail: ToolDetail,
    ) -> (Nullable<Counter>, Option<Vec<ToolCount>>) {
        let invocations = self
            .by_request
            .get(request_key)
            .into_iter()
            .flatten()
            .copied()
            .filter(|row| include_subagents || !row.caller_is_subagent);
        summarize(invocations, detail)
    }
}

fn summarize<'a>(
    invocations: impl Iterator<Item = &'a ToolEventRow>,
    detail: ToolDetail,
) -> (Nullable<Counter>, Option<Vec<ToolCount>>) {
    let mut count = 0u64;
    let mut grouped = BTreeMap::<ToolName, u64>::new();
    for row in invocations {
        count += 1;
        if detail != ToolDetail::Off
            && let Some(name) = display_name(row, detail)
        {
            *grouped.entry(name).or_default() += 1;
        }
    }
    let total = Counter::new(count).ok();
    if detail == ToolDetail::Off {
        return (Nullable(total), None);
    }
    let mut tools: Vec<_> = grouped
        .into_iter()
        .filter_map(|(name, calls)| Some(ToolCount { name, calls: Counter::new(calls).ok()? }))
        .collect();
    tools.sort_by(|left, right| {
        right.calls.get().cmp(&left.calls.get()).then_with(|| left.name.as_str().cmp(right.name.as_str()))
    });
    tools.truncate(observatory_contract::MAX_TOOLS_PER_REQUEST);
    (Nullable(total), (!tools.is_empty()).then_some(tools))
}

pub fn matches_agent_setting(row: &ToolEventRow, include_subagents: bool) -> bool {
    include_subagents || !row.caller_is_subagent
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_forms_map_without_exposing_custom_names() {
        let key = PrivacyKey::fixed_for_tests();
        assert_eq!(claude_identity(&key, Some("Read")).class, "builtin");
        assert_eq!(claude_identity(&key, Some("PowerShell")).class, "builtin");
        assert_eq!(claude_identity(&key, Some("NotebookRead")).class, "builtin");
        let mcp = claude_identity(&key, Some("mcp__vault__search_notes"));
        assert_eq!(
            (mcp.class.as_str(), mcp.namespace.as_deref(), mcp.name.as_deref()),
            ("mcp", Some("vault"), Some("search_notes"))
        );
        assert_eq!(claude_identity(&key, Some("private_tool")).class, "custom");
        assert_eq!(codex_identity(&key, "custom_tool_call", Some("exec"), None).class, "builtin");
        assert_eq!(codex_identity(&key, "custom_tool_call", Some("private_tool"), None).class, "custom");
        assert_eq!(
            codex_identity(&key, "function_call", Some("wait_agent"), Some("collaboration")).class,
            "builtin"
        );
        assert_eq!(codex_identity(&key, "function_call", Some("search"), Some("mcp__vault")).class, "mcp");
        assert_eq!(
            codex_identity(&key, "function_call", Some("private_fn"), Some("functions")).class,
            "function"
        );
    }

    #[test]
    fn long_names_are_bounded_before_hashing() {
        let key = PrivacyKey::fixed_for_tests();
        let prefix = "x".repeat(RAW_NAME_LIMIT);
        let first = claude_identity(&key, Some(&format!("{prefix}a")));
        let second = claude_identity(&key, Some(&format!("{prefix}b")));
        assert!(first.name_truncated);
        assert_eq!(first.name, second.name);
        assert_eq!(first.name_hash, second.name_hash, "the hash covers the stored, bounded name");
    }

    #[test]
    fn hashed_names_are_keyed_per_install_and_scoped_by_namespace() {
        let key = PrivacyKey::fixed_for_tests();
        let other = PrivacyKey::from_bytes([0x11; 32]);
        let mcp = claude_identity(&key, Some("mcp__vault__search"));
        assert_eq!(mcp.name_hash, Some(tool_name_hash(&key, Some("vault"), "search")));
        assert_eq!(mcp.namespace_hash, Some(tool_namespace_hash(&key, "vault")));
        assert_eq!(mcp.name_hash, claude_identity(&key, Some("mcp__vault__search")).name_hash);
        assert_ne!(mcp.name_hash, claude_identity(&other, Some("mcp__vault__search")).name_hash);
        assert_ne!(mcp.namespace_hash, claude_identity(&other, Some("mcp__vault__search")).namespace_hash);
        assert_ne!(mcp.name_hash, claude_identity(&key, Some("mcp__other__search")).name_hash);
        // The same MCP tool seen through Codex hashes the same way on this machine.
        assert_eq!(
            codex_identity(&key, "mcp_tool_call", Some("search"), Some("vault")).name_hash,
            mcp.name_hash
        );
        let custom = claude_identity(&key, Some("private_tool"));
        assert_eq!(custom.name_hash, Some(tool_name_hash(&key, None, "private_tool")));
        assert!(custom.name_hash.as_deref().is_some_and(|hash| hash.starts_with("h:") && hash.len() == 18));
        assert_eq!(claude_identity(&key, None).name_hash, None);
    }

    /// The summary as it was computed before the index: one pass over every
    /// tool row per request.
    fn linear_request_summary(
        rows: &[ToolEventRow],
        request_key: &str,
        include_subagents: bool,
        detail: ToolDetail,
    ) -> (Nullable<Counter>, Option<Vec<ToolCount>>) {
        let invocations: Vec<_> = rows
            .iter()
            .filter(|row| {
                row.event_kind == "invocation"
                    && row.caller_request_key.as_deref() == Some(request_key)
                    && (include_subagents || !row.caller_is_subagent)
            })
            .collect();
        let total = Counter::new(invocations.len() as u64).ok();
        if detail == ToolDetail::Off {
            return (Nullable(total), None);
        }
        let mut grouped = BTreeMap::<ToolName, u64>::new();
        for row in invocations {
            if let Some(name) = display_name(row, detail) {
                *grouped.entry(name).or_default() += 1;
            }
        }
        let mut tools: Vec<_> = grouped
            .into_iter()
            .filter_map(|(name, calls)| Some(ToolCount { name, calls: Counter::new(calls).ok()? }))
            .collect();
        tools.sort_by(|left, right| {
            right.calls.get().cmp(&left.calls.get()).then_with(|| left.name.as_str().cmp(right.name.as_str()))
        });
        tools.truncate(observatory_contract::MAX_TOOLS_PER_REQUEST);
        (Nullable(total), (!tools.is_empty()).then_some(tools))
    }

    fn row(
        index: u64,
        kind: &str,
        request: Option<&str>,
        identity: &ToolEvidence,
        subagent: bool,
    ) -> ToolEventRow {
        ToolEventRow {
            id: format!("{index:064x}"),
            timestamp: "2026-09-04T00:00:00Z".into(),
            event_kind: kind.into(),
            invocation_key: format!("{:064x}", index / 2),
            session_hash: None,
            caller_request_key: request.map(str::to_owned),
            caller_agent_key: None,
            caller_is_subagent: subagent,
            parent_invocation_key: None,
            class: identity.class.clone(),
            name: identity.name.clone(),
            name_hash: identity.name_hash.clone(),
            namespace: identity.namespace.clone(),
            namespace_hash: identity.namespace_hash.clone(),
            outcome: "succeeded".into(),
            name_truncated: false,
        }
    }

    #[test]
    fn the_request_index_summarizes_exactly_as_the_linear_filter_did() {
        let key = PrivacyKey::fixed_for_tests();
        let names = [
            claude_identity(&key, Some("Read")),
            claude_identity(&key, Some("Bash")),
            claude_identity(&key, Some("mcp__vault__search")),
            claude_identity(&key, Some("private_tool")),
            claude_identity(&key, None),
        ];
        let requests = ["r1", "r2", "r3", "r4"];
        let mut rows = Vec::new();
        for index in 0..120u64 {
            let request = match index % 7 {
                6 => None,
                remainder => Some(requests[(remainder as usize) % requests.len()]),
            };
            let kind = if index % 2 == 0 { "invocation" } else { "result" };
            rows.push(row(index, kind, request, &names[(index % 5) as usize], index % 3 == 0));
        }
        let index = ToolIndex::new(&rows);
        for request in requests.iter().chain(["absent"].iter()) {
            for include_subagents in [false, true] {
                for detail in [ToolDetail::Off, ToolDetail::BuiltinOnly, ToolDetail::HashedCustom] {
                    let expected = linear_request_summary(&rows, request, include_subagents, detail);
                    let actual = index.request_summary(request, include_subagents, detail);
                    assert_eq!(actual, expected, "{request} subagents={include_subagents} {detail:?}");
                }
            }
        }
        let (total, tools) = index.request_summary("r1", true, ToolDetail::BuiltinOnly);
        assert!(total.as_ref().is_some_and(|count| count.get() > 0));
        assert!(tools.is_some(), "the fixture exercises named tools");
    }
}
