/**
 * Display lists: which readable agent and tool names the Tokens cards tag as built in, per provider.
 *
 * These are for DISPLAY ONLY. They never classify a ledger row: the companion's per-provider
 * classification lists (companion `builtins.rs`) decide `agent_class` and `tool_class`, and those stay
 * byte-identical across releases. A name here only adds the "built-in" tag to a row whose ledger class
 * is custom or unknown, for example a harness tool the ledger stored as custom before its name was known.
 *
 * Kept per provider on purpose: a label key carries no provider, so "builtin" can only be derived from
 * (provider, class, label) at read time (spec section 6.3). They are passed to SQL as one text[] per
 * provider (lib/usage-query.ts `builtinArraysSql`).
 */
export const KNOWN_BUILTIN_AGENTS: Record<string, readonly string[]> = {
  claude: ['general-purpose', 'Explore', 'Plan', 'workflow-subagent', 'claude-code-guide', 'statusline-setup'],
  codex: ['default', 'worker', 'explorer', 'guardian'],
  cursor: ['explore', 'generalPurpose'],
};

export const KNOWN_BUILTIN_TOOLS: Record<string, readonly string[]> = {
  claude: [
    'ToolSearch', 'Workflow', 'Artifact', 'SendMessage', 'StructuredOutput', 'SendUserFile', 'Monitor', 'ListAgents',
    'ReportFindings', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'CronList', 'PushNotification',
    'RemoteTrigger', 'ListSkills', 'SearchSkills', 'SearchPlugins', 'ListPlugins', 'SuggestPluginInstall', 'TaskStop',
    'Skill', 'Task', 'Agent', 'TodoWrite', 'AskUserQuestion', 'PowerShell', 'NotebookRead', 'NotebookEdit',
    'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'BashOutput', 'KillShell',
    'ExitPlanMode', 'EnterPlanMode', 'SlashCommand',
  ],
  codex: ['exec', 'shell', 'exec_command', 'write_stdin', 'apply_patch', 'update_plan', 'view_image', 'web_search', 'spawn_agent', 'wait', 'send_input', 'close_agent'],
  cursor: [],
};

export const BUILTIN_PROVIDERS = ['claude', 'codex', 'cursor'] as const;
