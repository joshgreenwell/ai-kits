/**
 * Explicitly NOT interpreted (plan §3.6, JG-154).
 *
 * Each item names something agent-surface deliberately does not reason
 * about. When a detector recognises the item in an entry, the delta becomes
 * `unresolved` with a note naming the item. Items without a detector
 * concern files that V0 never reads; they are listed so the documentation
 * and `explain` can say so.
 */

import type { Entry } from "../types.js";
import { permValue } from "./shared.js";
import { IGNORED_SPEC_TOOLS, PATH_TOOLS } from "./i8-ignored-shapes.js";
import type { Classification } from "./types.js";

export interface NotInterpreted {
  /** `N-…` identifier for `explain`. */
  id: string;
  title: string;
  explain: string;
  /** Returns the note when the item is present in `entry`; `null` otherwise. Absent for items V0 cannot observe. */
  detect?: (entry: Entry) => string | null;
}

const WRAPPERS: readonly string[] = ["sudo", "env", "time", "xargs"];

function bashSpec(entry: Entry): string | null {
  const value = permValue(entry);
  return value !== null && value.tool === "Bash" && value.spec !== null && value.spec !== "*" ? value.spec : null;
}

function firstToken(spec: string): string {
  return spec.trim().split(/\s+/)[0] ?? "";
}

export const NOT_INTERPRETED: readonly NotInterpreted[] = [
  {
    id: "N-compound-command",
    title: "Compound-command splitting (`&&`, `;`, `|`)",
    explain:
      "A Bash rule whose spec contains &&, ||, ; or | is not split into its parts. Whether Claude Code matches the rule against the whole line or each command is not modeled; the delta is unresolved.",
    detect: (entry) => {
      const spec = bashSpec(entry);
      return spec !== null && /&&|\|\||;|\|/.test(spec) ? "compound-command splitting (`&&`, `;`, `|`) is not interpreted" : null;
    },
  },
  {
    id: "N-wrapper-stripping",
    title: "Wrapper stripping (`sudo`, `env`, `time`, `xargs`)",
    explain:
      "A Bash rule that starts with a wrapper such as sudo, env, time or xargs is not reduced to the wrapped command. What the wrapper eventually runs is unresolved.",
    detect: (entry) => {
      const spec = bashSpec(entry);
      return spec !== null && WRAPPERS.includes(firstToken(spec)) ? `wrapper stripping (\`${firstToken(spec)}\`) is not interpreted` : null;
    },
  },
  {
    id: "N-env-assignment",
    title: "Env-assignment stripping (`FOO=bar cmd`)",
    explain:
      "A Bash rule that starts with a NAME=value assignment is not reduced to the command after it. The assignment's effect on the command is unresolved.",
    detect: (entry) => {
      const spec = bashSpec(entry);
      return spec !== null && /^[A-Za-z_][A-Za-z0-9_]*=/.test(firstToken(spec)) ? "env-assignment stripping (`FOO=bar cmd`) is not interpreted" : null;
    },
  },
  {
    id: "N-redirect",
    title: "Redirect checks (`>`, `<`)",
    explain: "A Bash rule containing a shell redirect is not analysed for what it writes or reads. The delta is unresolved.",
    detect: (entry) => {
      const spec = bashSpec(entry);
      return spec !== null && /[<>]/.test(spec) ? "redirect checks (`>`) are not interpreted" : null;
    },
  },
  {
    id: "N-path-anchoring",
    title: "Path anchoring (`/`, `//`, `~`)",
    explain:
      "Read/Edit path rules resolve differently depending on their anchor (// absolute, ~ home, / relative to the settings file, otherwise relative to the working directory). agent-surface records the path as written and does not resolve it; a path rule delta is unresolved.",
    detect: (entry) => pathRuleNote(entry),
  },
  {
    id: "N-depth-semantics",
    title: "Depth semantics (`*` vs `**`)",
    explain: "How far a path pattern descends (one segment for *, any depth for **) is not modeled. A path rule delta is unresolved.",
    detect: (entry) => pathRuleNote(entry),
  },
  {
    id: "N-symlink-pairing",
    title: "Symlink pairing",
    explain: "Whether a path rule also covers the link or target of a symlink is not modeled. A path rule delta is unresolved.",
    detect: (entry) => pathRuleNote(entry),
  },
  {
    id: "N-plugin-provided",
    title: "Plugin-provided hooks and servers (`enabledPlugins`)",
    explain:
      "Hooks and MCP servers contributed by plugins are not read. A change to enabledPlugins is unresolved and the assumptions header flags non-empty enabledPlugins.",
    detect: (entry) => (entry.key === "plugin_flag:enabledPlugins" ? "plugin-provided hooks and servers (`enabledPlugins`) are not interpreted" : null),
  },
  {
    id: "N-skill-allowed-tools",
    title: "Skill `allowed-tools`",
    explain:
      "Skill frontmatter (.claude/skills/*/SKILL.md) is not among the V0 inputs; a change there produces no entry and no claim. Listed so the absence is explicit.",
  },
  {
    id: "N-subagent-frontmatter",
    title: "Subagent frontmatter",
    explain:
      "Subagent definitions (.claude/agents/*.md, including their tools list) are not among the V0 inputs; a change there produces no entry and no claim. Listed so the absence is explicit.",
  },
];

const PATH_RULE_NOTE = "path rules are not interpreted: path anchoring (`/`, `//`, `~`), depth semantics (`*`, `**`) and symlink pairing are outside the closed list";

/** Note for any non-Bash `Tool(spec)` that I8 does not declare ignored. */
function pathRuleNote(entry: Entry): string | null {
  const value = permValue(entry);
  if (value === null || value.spec === null || value.spec === "*" || value.tool === "Bash") {
    return null;
  }
  if (IGNORED_SPEC_TOOLS.includes(value.tool) || value.tool.startsWith("mcp__")) {
    return null;
  }
  if (PATH_TOOLS.includes(value.tool)) {
    return value.spec.startsWith("*") ? null : PATH_RULE_NOTE;
  }
  return `\`${value.tool}(spec)\` rules are outside the closed interpretation list`;
}

/** Look up a not-interpreted item by id. */
export function findNotInterpreted(id: string): NotInterpreted | null {
  return NOT_INTERPRETED.find((item) => item.id === id) ?? null;
}

/**
 * Run every detector on `entry`. Returns one `unresolved` classification
 * naming each detected item (duplicates collapsed), or `null` when nothing
 * matched. Pure.
 */
export function detectNotInterpreted(entry: Entry): { classification: Classification; ids: string[] } | null {
  const notes: string[] = [];
  const ids: string[] = [];
  for (const item of NOT_INTERPRETED) {
    const note = item.detect?.(entry) ?? null;
    if (note !== null) {
      ids.push(item.id);
      if (!notes.includes(note)) {
        notes.push(note);
      }
    }
  }
  if (ids.length === 0) {
    return null;
  }
  return { classification: { tier: "unresolved", flags: [], notes: notes.map((note) => `not interpreted: ${note}`) }, ids };
}
