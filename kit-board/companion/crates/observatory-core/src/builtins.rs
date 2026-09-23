//! The companion's name lists, in three kinds that must never be merged
//! (spec section 2.2):
//!
//! 1. Per-provider classification lists. `classify_claude`, `classify_codex`,
//!    `claude_identity` and `codex_identity` in `observatory-adapters` read
//!    these. Their content is the 2.1.0 content, byte for byte; the golden
//!    classification test in `observatory-adapters/tests` pins that.
//! 2. Upload gates. Which names may travel readable: in a request's `tools[]`
//!    (`REQUEST_TOOLS_RETAIN`, unchanged since 2.1.0 so no request record is
//!    revised), in a `tool.event` (`TOOL_EVENT_READABLE`, the same list plus
//!    `PowerShell` and `NotebookRead`), and as a builtin agent name
//!    (`AGENT_NAME_READABLE`).
//! 3. Label display lists. Which readable labels name a builtin agent, so a
//!    `name.label` for an `agent` or `session_agent` may travel at
//!    `tool_detail = builtin_only` (section 0.5). They never change a ledger
//!    record; the server keeps its own display lists.

use observatory_contract::Provider;

/// Claude Code subagent types classed `builtin` (2.1.0 `classify_claude`).
pub const CLAUDE_BUILTIN_AGENTS: &[&str] =
    &["general-purpose", "Explore", "Plan", "claude-code-guide", "statusline-setup", "claude"];

/// Codex agent roles classed `builtin` (2.1.0 `classify_codex`). A thread with
/// no role at all is builtin too; `classify_codex` handles that case.
pub const CODEX_BUILTIN_AGENTS: &[&str] = &["codex-auto-review"];

/// Claude Code tools classed `builtin` (2.1.0 `claude_builtin`).
pub const CLAUDE_BUILTIN_TOOLS: &[&str] = &[
    "Agent",
    "AskUserQuestion",
    "Bash",
    "BashOutput",
    "Edit",
    "EnterPlanMode",
    "ExitPlanMode",
    "Glob",
    "Grep",
    "KillShell",
    "LS",
    "MultiEdit",
    "NotebookEdit",
    "NotebookRead",
    "PowerShell",
    "Read",
    "Skill",
    "SlashCommand",
    "Task",
    "TaskOutput",
    "TaskStop",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
    "Write",
];

/// Codex tool names classed `builtin` (2.1.0 `codex_builtin_name`).
pub const CODEX_BUILTIN_TOOLS: &[&str] = &[
    "apply_patch",
    "create_goal",
    "exec",
    "exec_command",
    "get_goal",
    "local_shell",
    "request_user_input",
    "request_user_input_async",
    "shell_command",
    "update_goal",
    "update_plan",
    "view_image",
    "wait",
    "web_search",
    "write_stdin",
];

/// Codex function namespaces classed `builtin` (2.1.0 `codex_builtin_namespace`).
pub const CODEX_BUILTIN_NAMESPACES: &[&str] =
    &["clock", "codex_app", "collaboration", "image_gen", "multi_agent_v1", "web"];

/// Builtin tool names a request's `tools[]` keeps readable. This is the 2.1.0
/// list and must not change: a change would revise request records.
pub const REQUEST_TOOLS_RETAIN: &[&str] = &[
    "Agent",
    "AskUserQuestion",
    "Bash",
    "BashOutput",
    "Edit",
    "EnterPlanMode",
    "ExitPlanMode",
    "Glob",
    "Grep",
    "KillShell",
    "LS",
    "MultiEdit",
    "NotebookEdit",
    "Read",
    "Skill",
    "SlashCommand",
    "Task",
    "TaskOutput",
    "TaskStop",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
    "Write",
    "apply_patch",
    "automation_update",
    "capture_screen_context",
    "close_agent",
    "consume_usage_reset",
    "create_goal",
    "create_sidebar_section",
    "create_thread",
    "delete_sidebar_section",
    "end_realtime_voice_call",
    "exec",
    "exec_command",
    "followup_task",
    "fork_thread",
    "get_goal",
    "get_handoff_status",
    "get_usage_limits",
    "handoff_thread",
    "imagegen",
    "interrupt_agent",
    "list_agents",
    "list_archived_threads",
    "list_projects",
    "list_threads",
    "load_workspace_dependencies",
    "local_shell",
    "move_project_to_sidebar_section",
    "move_thread_to_sidebar_section",
    "navigate_to_codex_page",
    "open_in_codex",
    "read_thread",
    "read_thread_terminal",
    "request_user_input",
    "request_user_input_async",
    "rename_sidebar_section",
    "reorder_section",
    "reorder_sidebar_projects",
    "reorder_sidebar_sections",
    "run",
    "send_message",
    "send_message_to_thread",
    "set_thread_archived",
    "set_thread_title",
    "share_thread",
    "shell_command",
    "sleep",
    "spawn_agent",
    "uninstall_plugin",
    "update_goal",
    "update_plan",
    "view_image",
    "wait",
    "wait_agent",
    "wait_threads",
    "web_search",
    "write_stdin",
];

/// Builtin tool names a `tool.event` keeps readable: `REQUEST_TOOLS_RETAIN`
/// plus the two Claude builtins the 2.1.0 gate missed. Only `tool.event`
/// records are revised by the addition (section 0.2).
pub const TOOL_EVENT_READABLE_ADDED: &[&str] = &["NotebookRead", "PowerShell"];

/// Builtin tool namespaces a `tool.event` keeps readable (2.1.0, unchanged).
pub const TOOL_NAMESPACE_READABLE: &[&str] = CODEX_BUILTIN_NAMESPACES;

/// Builtin agent names that travel readable in the ledger (2.1.0, unchanged).
pub const AGENT_NAME_READABLE: &[&str] = &[
    "general-purpose",
    "Explore",
    "Plan",
    "claude-code-guide",
    "statusline-setup",
    "claude",
    "codex-auto-review",
];

/// Claude agent labels that name a builtin, for the label gate only. Adds the
/// harness's own `workflow-subagent`, which the ledger still classes custom.
pub const CLAUDE_BUILTIN_AGENT_LABELS: &[&str] = &[
    "general-purpose",
    "Explore",
    "Plan",
    "workflow-subagent",
    "claude-code-guide",
    "statusline-setup",
    "claude",
];

/// Codex agent labels that name a builtin: the roles Codex itself spawns, and
/// the guardian reviewer, for the label gate only.
pub const CODEX_BUILTIN_AGENT_LABELS: &[&str] =
    &["default", "worker", "explorer", "guardian", "codex-auto-review"];

/// Cursor composer labels that name a builtin: the main composer and the
/// subagent types Cursor ships.
pub const CURSOR_BUILTIN_AGENT_LABELS: &[&str] = &["main", "explore", "generalPurpose"];

/// Claude Code harness tools. The ledger classes them custom (hashed); a label
/// carries their readable name, and the server tags them builtin by name.
pub const CLAUDE_HARNESS_TOOL_LABELS: &[&str] = &[
    "ToolSearch",
    "Workflow",
    "Artifact",
    "SendMessage",
    "StructuredOutput",
    "SendUserFile",
    "Monitor",
    "ListAgents",
    "ReportFindings",
    "EnterWorktree",
    "ExitWorktree",
    "CronCreate",
    "CronDelete",
    "CronList",
    "PushNotification",
    "RemoteTrigger",
    "ListSkills",
    "SearchSkills",
];

/// Whether a request's `tools[]` keeps this builtin name readable.
pub fn request_tool_retained(name: &str) -> bool {
    REQUEST_TOOLS_RETAIN.contains(&name)
}

/// Whether a `tool.event` keeps this builtin name readable.
pub fn tool_event_name_readable(name: &str) -> bool {
    REQUEST_TOOLS_RETAIN.contains(&name) || TOOL_EVENT_READABLE_ADDED.contains(&name)
}

/// Whether a `tool.event` keeps this builtin namespace readable.
pub fn tool_namespace_readable(namespace: &str) -> bool {
    TOOL_NAMESPACE_READABLE.contains(&namespace)
}

/// Whether a builtin agent name travels readable in the ledger.
pub fn agent_name_readable(name: &str) -> bool {
    AGENT_NAME_READABLE.contains(&name)
}

/// Whether a label names a builtin agent of this provider.
pub fn agent_label_names_builtin(provider: Provider, label: &str) -> bool {
    match provider {
        Provider::Claude => CLAUDE_BUILTIN_AGENT_LABELS.contains(&label),
        Provider::Codex => CODEX_BUILTIN_AGENT_LABELS.contains(&label),
        Provider::Cursor => CURSOR_BUILTIN_AGENT_LABELS.contains(&label),
        Provider::AnthropicApi | Provider::OpenaiApi => false,
    }
}

/// Whether a label names a builtin agent of any provider. An `agent` label's
/// key does not say which provider it belongs to, so the upload gate for
/// `builtin_only` asks this.
pub fn any_agent_label_names_builtin(label: &str) -> bool {
    [Provider::Claude, Provider::Codex, Provider::Cursor]
        .into_iter()
        .any(|provider| agent_label_names_builtin(provider, label))
}

/// Whether a tool label names a Claude Code harness tool.
pub fn tool_label_names_harness_builtin(label: &str) -> bool {
    CLAUDE_HARNESS_TOOL_LABELS.contains(&label)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Spec test R8: every name the classification lists call builtin is readable in a tool event.
    #[test]
    fn every_classified_builtin_tool_is_readable_in_a_tool_event() {
        let gaps: Vec<&str> = CLAUDE_BUILTIN_TOOLS
            .iter()
            .chain(CODEX_BUILTIN_TOOLS)
            .copied()
            .filter(|name| !tool_event_name_readable(name))
            .collect();
        assert!(gaps.is_empty(), "builtin tools the tool.event gate would null: {gaps:?}");
        assert!(CODEX_BUILTIN_NAMESPACES.iter().all(|namespace| tool_namespace_readable(namespace)));
    }

    #[test]
    fn the_tool_event_gate_adds_exactly_two_names_to_the_request_list() {
        let added: Vec<&str> =
            TOOL_EVENT_READABLE_ADDED.iter().copied().filter(|name| !request_tool_retained(name)).collect();
        assert_eq!(added, vec!["NotebookRead", "PowerShell"]);
        assert!(!request_tool_retained("PowerShell"), "request tools[] must not change");
    }

    #[test]
    fn label_lists_are_per_provider() {
        assert!(agent_label_names_builtin(Provider::Codex, "guardian"));
        assert!(!agent_label_names_builtin(Provider::Claude, "guardian"));
        assert!(agent_label_names_builtin(Provider::Claude, "workflow-subagent"));
        assert!(agent_label_names_builtin(Provider::Cursor, "generalPurpose"));
        assert!(!any_agent_label_names_builtin("synthetic-custom-role"));
        assert!(tool_label_names_harness_builtin("ToolSearch"));
        // The ledger lists are untouched by the label lists.
        assert!(!agent_name_readable("workflow-subagent"));
        assert!(!agent_name_readable("guardian"));
    }
}
