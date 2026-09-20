/**
 * Verdict categories (JG-155, plan §3.8).
 *
 * A category names *why* a widening delta matters to the verdict. Every
 * delta whose direction is `widens` carries exactly one category; every
 * other delta carries `null`. `--fail-on` accepts these names plus the
 * pseudo-category `projected` (see `verdict.ts`).
 */

/** Categories a widening delta can belong to, in the order `--help` lists them. */
export const CATEGORIES = [
  "hook",
  "mcp",
  "mode",
  "whole-tool-allow",
  "directory",
  "hooks-reenabled",
  "deny-removed",
  "env",
  "scoped-allow",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Categories that fail `check` (exit 1) unless `--fail-on` overrides them. */
export const DEFAULT_FAILING_CATEGORIES: readonly Category[] = [
  "hook",
  "mcp",
  "mode",
  "whole-tool-allow",
  "directory",
  "hooks-reenabled",
  "deny-removed",
  "env",
];

/** `--fail-on` pseudo-category: projected widenings also exit 1. */
export const PROJECTED_PSEUDO_CATEGORY = "projected";

export interface CategoryMeta {
  id: Category;
  title: string;
  failing_by_default: boolean;
  explain: string;
}

/** Documentation for each category, rendered by `explain <category>` and `docs/interpretations.md`. */
export const CATEGORY_META: readonly CategoryMeta[] = [
  {
    id: "hook",
    title: "New hook or changed hook command",
    failing_by_default: true,
    explain:
      "A hook entry was added, or the command behind an existing event/matcher changed (the entry key carries sha256(command), so a changed command is a new key paired with the removed one). Claude Code runs hook commands automatically; presence is proven, the command is recorded and never executed.",
  },
  {
    id: "mcp",
    title: "New MCP server, changed transport, or enableAllProjectMcpServers",
    failing_by_default: true,
    explain:
      "An MCP server was added to .mcp.json, its command/args/url/transport changed, or enableAllProjectMcpServers became true (which auto-approves every server in .mcp.json). A server with a variable-expanded URL is still in this category but unresolved.",
  },
  {
    id: "mode",
    title: "defaultMode changed to bypassPermissions, auto or dontAsk",
    failing_by_default: true,
    explain:
      "permissions.defaultMode moved to a widening mode from an absent or non-widening one. acceptEdits, plan and default never land here (interpretation I5).",
  },
  {
    id: "whole-tool-allow",
    title: "Whole-tool allow rule added",
    failing_by_default: true,
    explain:
      "An allow rule with breadth whole_tool (a bare tool name such as Bash or Read, or Tool(*)) was added. It grants every use of that tool without asking once the workspace is trusted (interpretation I2).",
  },
  {
    id: "directory",
    title: "additionalDirectories entry added",
    failing_by_default: true,
    explain:
      "permissions.additionalDirectories gained a path. Claude Code treats it like the working directory. The path is recorded as written; anchoring is not interpreted.",
  },
  {
    id: "hooks-reenabled",
    title: "disableAllHooks turned off",
    failing_by_default: true,
    explain: "disableAllHooks went from true to false (or was removed while true), so every configured hook runs again.",
  },
  {
    id: "deny-removed",
    title: "Deny rule removed",
    failing_by_default: true,
    explain:
      "A permissions.deny rule disappeared. Whatever it blocked is no longer blocked by the repository; the direction is proven from the list semantics regardless of the rule's breadth.",
  },
  {
    id: "env",
    title: "Sensitive environment value set or changed",
    failing_by_default: true,
    explain:
      "A variable on the sensitive list (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY, NODE_OPTIONS, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, PATH, LD_PRELOAD, and every CLAUDE_CODE_* or DYLD_* name) was set or had its value changed, in the top-level env block or in an MCP server's env. Such a value redirects the agent's traffic or loads code into its process. The value is never carried: an entry holds only its length and sha256, and the delta says that the digest differs (direction rule D-env-sensitive-set).",
  },
  {
    id: "scoped-allow",
    title: "Scoped allow rule added (annotate-only by default)",
    failing_by_default: false,
    explain:
      "An allow rule with breadth exact, prefix or glob (Bash(npm test), Bash(npm run *), Bash(git * main)) or an uninterpreted path rule was added. Annotated but not failing unless --fail-on names scoped-allow; a glob breadth is additionally listed as unresolved (interpretations I3/I4).",
  },
];
