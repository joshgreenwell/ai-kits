//! Spec test R7: the classification golden test.
//!
//! 2.2.0 moved the per-provider classification lists and the upload gates into
//! `observatory_core::builtins`. This test keeps a frozen copy of the 2.1.0
//! functions and runs both over every distinct name in a sanitized corpus
//! (`fixtures/classification-corpus.json`: product and harness names kept, every
//! other name a synthetic stand-in of the same form) plus every name any list
//! holds. The output must be identical, except that the `tool.event` upload gate
//! now also keeps `PowerShell` and `NotebookRead` readable.

use std::collections::BTreeSet;

use observatory_adapters::agents::{classify_claude, classify_codex};
use observatory_adapters::tools::{claude_identity, codex_identity};
use observatory_core::builtins;
use observatory_core::privacy::PrivacyKey;
use serde_json::Value;

/// The 2.1.0 functions, verbatim in behavior.
mod legacy {
    pub fn claude_builtin(name: &str) -> bool {
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

    pub fn codex_builtin_name(name: &str) -> bool {
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

    pub fn codex_builtin_namespace(namespace: &str) -> bool {
        matches!(namespace, "clock" | "codex_app" | "collaboration" | "image_gen" | "multi_agent_v1" | "web")
    }

    pub fn claude_class(raw: Option<&str>) -> &'static str {
        let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else { return "unknown" };
        if raw.starts_with("mcp__") {
            "mcp"
        } else if claude_builtin(raw) {
            "builtin"
        } else {
            "custom"
        }
    }

    pub fn codex_class(kind: &str, raw_name: Option<&str>, raw_namespace: Option<&str>) -> &'static str {
        match kind {
            "web_search_call" | "local_shell_call" => "builtin",
            "mcp_tool_call" => "mcp",
            "custom_tool_call" if raw_name.is_some_and(codex_builtin_name) => "builtin",
            "custom_tool_call" => "custom",
            "function_call" => match raw_namespace {
                Some(namespace) if namespace.starts_with("mcp__") => "mcp",
                Some(namespace) if codex_builtin_namespace(namespace) => "builtin",
                None if raw_name.is_some_and(codex_builtin_name) => "builtin",
                _ => "function",
            },
            _ => "unknown",
        }
    }

    pub fn classify_claude(name: Option<&str>) -> &'static str {
        match name {
            Some(
                "general-purpose" | "Explore" | "Plan" | "claude-code-guide" | "statusline-setup" | "claude",
            ) => "builtin",
            Some(_) => "custom",
            None => "unknown",
        }
    }

    pub fn classify_codex(role: Option<&str>) -> &'static str {
        match role {
            Some("codex-auto-review") => "builtin",
            Some(_) => "custom",
            None => "builtin",
        }
    }

    /// `run.rs` `is_builtin_tool_name`: both the request `tools[]` and the `tool.event` gate in 2.1.0.
    pub fn run_tool_gate(value: &str) -> bool {
        matches!(
            value,
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
                | "apply_patch"
                | "automation_update"
                | "capture_screen_context"
                | "close_agent"
                | "consume_usage_reset"
                | "create_goal"
                | "create_sidebar_section"
                | "create_thread"
                | "delete_sidebar_section"
                | "end_realtime_voice_call"
                | "exec"
                | "exec_command"
                | "followup_task"
                | "fork_thread"
                | "get_goal"
                | "get_handoff_status"
                | "get_usage_limits"
                | "handoff_thread"
                | "imagegen"
                | "interrupt_agent"
                | "list_agents"
                | "list_archived_threads"
                | "list_projects"
                | "list_threads"
                | "load_workspace_dependencies"
                | "local_shell"
                | "move_project_to_sidebar_section"
                | "move_thread_to_sidebar_section"
                | "navigate_to_codex_page"
                | "open_in_codex"
                | "read_thread"
                | "read_thread_terminal"
                | "request_user_input"
                | "request_user_input_async"
                | "rename_sidebar_section"
                | "reorder_section"
                | "reorder_sidebar_projects"
                | "reorder_sidebar_sections"
                | "run"
                | "send_message"
                | "send_message_to_thread"
                | "set_thread_archived"
                | "set_thread_title"
                | "share_thread"
                | "shell_command"
                | "sleep"
                | "spawn_agent"
                | "uninstall_plugin"
                | "update_goal"
                | "update_plan"
                | "view_image"
                | "wait"
                | "wait_agent"
                | "wait_threads"
                | "web_search"
                | "write_stdin"
        )
    }

    pub fn run_namespace_gate(value: &str) -> bool {
        matches!(value, "clock" | "codex_app" | "collaboration" | "image_gen" | "multi_agent_v1" | "web")
    }

    pub fn run_agent_name_gate(name: &str) -> bool {
        matches!(
            name,
            "general-purpose"
                | "Explore"
                | "Plan"
                | "claude-code-guide"
                | "statusline-setup"
                | "claude"
                | "codex-auto-review"
        )
    }
}

struct Corpus {
    names: BTreeSet<String>,
    namespaces: BTreeSet<Option<String>>,
    pairs: BTreeSet<(String, Option<String>)>,
    claude_raw: BTreeSet<String>,
    agents: BTreeSet<String>,
}

fn corpus() -> Corpus {
    let value: Value =
        serde_json::from_str(include_str!("fixtures/classification-corpus.json")).expect("corpus parses");
    let text = |value: &Value| value.as_str().map(str::to_owned);
    let mut corpus = Corpus {
        names: BTreeSet::new(),
        namespaces: BTreeSet::from([None]),
        pairs: BTreeSet::new(),
        claude_raw: value["claude_raw_names"].as_array().unwrap().iter().filter_map(text).collect(),
        agents: value["agent_names"].as_array().unwrap().iter().filter_map(text).collect(),
    };
    for tool in value["tools"].as_array().unwrap() {
        let name = text(&tool["name"]).unwrap();
        let namespace = text(&tool["namespace"]);
        corpus.names.insert(name.clone());
        corpus.namespaces.insert(namespace.clone());
        corpus.pairs.insert((name, namespace));
    }
    for namespace in value["namespaces"].as_array().unwrap().iter().filter_map(text) {
        corpus.namespaces.insert(Some(namespace));
    }
    // Every name any list holds, old or new, so no builtin escapes the comparison.
    let lists = [
        builtins::CLAUDE_BUILTIN_TOOLS,
        builtins::CODEX_BUILTIN_TOOLS,
        builtins::REQUEST_TOOLS_RETAIN,
        builtins::TOOL_EVENT_READABLE_ADDED,
        builtins::CLAUDE_HARNESS_TOOL_LABELS,
    ];
    for list in lists {
        for name in list {
            corpus.names.insert((*name).to_owned());
            corpus.claude_raw.insert((*name).to_owned());
        }
    }
    for list in [
        builtins::CLAUDE_BUILTIN_AGENTS,
        builtins::CODEX_BUILTIN_AGENTS,
        builtins::AGENT_NAME_READABLE,
        builtins::CLAUDE_BUILTIN_AGENT_LABELS,
        builtins::CODEX_BUILTIN_AGENT_LABELS,
        builtins::CURSOR_BUILTIN_AGENT_LABELS,
    ] {
        corpus.agents.extend(list.iter().map(|name| (*name).to_owned()));
    }
    for namespace in builtins::CODEX_BUILTIN_NAMESPACES {
        corpus.namespaces.insert(Some((*namespace).to_owned()));
    }
    corpus
}

#[test]
fn classification_is_byte_identical_to_2_1_0() {
    let corpus = corpus();
    assert!(corpus.names.len() > 100 && corpus.agents.len() > 20, "the corpus is not trivial");
    let key = PrivacyKey::fixed_for_tests();
    let mut compared = 0u64;
    for raw in corpus.claude_raw.iter().chain(corpus.names.iter()) {
        assert_eq!(claude_identity(&key, Some(raw)).class, legacy::claude_class(Some(raw)), "claude {raw:?}");
        compared += 1;
    }
    assert_eq!(claude_identity(&key, None).class, legacy::claude_class(None));
    let kinds = [
        "function_call",
        "custom_tool_call",
        "mcp_tool_call",
        "web_search_call",
        "local_shell_call",
        "other_call",
    ];
    let pairs: BTreeSet<(String, Option<String>)> = corpus
        .pairs
        .iter()
        .cloned()
        .chain(corpus.names.iter().flat_map(|name| {
            corpus.namespaces.iter().map(move |namespace| (name.clone(), namespace.clone()))
        }))
        .collect();
    for (name, namespace) in &pairs {
        for kind in kinds {
            for raw_name in [Some(name.as_str()), None] {
                assert_eq!(
                    codex_identity(&key, kind, raw_name, namespace.as_deref()).class,
                    legacy::codex_class(kind, raw_name, namespace.as_deref()),
                    "codex {kind} {raw_name:?} {namespace:?}"
                );
                compared += 1;
            }
        }
    }
    for agent in corpus.agents.iter().map(|name| Some(name.as_str())).chain([None]) {
        assert_eq!(classify_claude(agent), legacy::classify_claude(agent), "claude agent {agent:?}");
        assert_eq!(classify_codex(agent), legacy::classify_codex(agent), "codex agent {agent:?}");
        if let Some(agent) = agent {
            assert_eq!(builtins::agent_name_readable(agent), legacy::run_agent_name_gate(agent), "{agent:?}");
        }
        compared += 1;
    }
    let mut newly_readable = BTreeSet::new();
    for name in &corpus.names {
        let before = legacy::run_tool_gate(name);
        assert_eq!(builtins::request_tool_retained(name), before, "request tools[] {name:?}");
        let after = builtins::tool_event_name_readable(name);
        assert!(after || !before, "{name:?} lost its readable tool.event name");
        if after && !before {
            newly_readable.insert(name.clone());
        }
        compared += 1;
    }
    assert_eq!(
        newly_readable,
        BTreeSet::from(["NotebookRead".to_owned(), "PowerShell".to_owned()]),
        "the only tool.event gate change"
    );
    for namespace in corpus.namespaces.iter().flatten() {
        assert_eq!(builtins::tool_namespace_readable(namespace), legacy::run_namespace_gate(namespace));
    }
    assert!(compared > 5_000, "compared {compared} classifications");
}
