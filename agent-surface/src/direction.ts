/**
 * Direction classification (JG-153, plan §3.5 step 4).
 *
 * Applies the direction table per kind and list to one keyed delta and
 * names the rule that fired (`D-…`), so `explain <D-id>` and
 * `docs/interpretations.md` can cite it. Pure: never reads files, never
 * executes or expands anything, never mutates its inputs. Anything the
 * table does not cover is `D-unknown` (direction `unknown`, tier
 * `unresolved`); the interpretations may refine the result afterwards.
 */

import { NON_WIDENING_MODES, WIDENING_MODES } from "./interpretations/i5-default-mode.js";
import { isObject, permList as permListOf } from "./interpretations/shared.js";
import type { ChangeKind, Direction, Entry, EntryKind, JsonValue, Tier } from "./types.js";

export interface DirectionRule {
  /** `D-…` identifier used in `Delta.rule` and by `explain`. */
  id: string;
  title: string;
  direction: Direction;
  tier: Tier;
  explain: string;
}

/** The direction table (JG-153) plus the rules needed to cover every delta shape. */
export const DIRECTION_RULES: readonly DirectionRule[] = [
  {
    id: "D-allow-added",
    title: "allow rule added",
    direction: "widens",
    tier: "proven",
    explain:
      "A permissions.allow rule was added. Once the workspace is trusted, a matching allow rule lets the tool run without asking. Breadth (whole tool, exact, prefix, glob) comes from I2/I3/I4 and decides between the whole-tool-allow and scoped-allow categories; I1 may downgrade the delta to neutral when the same string is denied or asked.",
  },
  {
    id: "D-ask-added",
    title: "ask rule added",
    direction: "neutral",
    tier: "proven",
    explain: "A permissions.ask rule was added. It makes Claude Code prompt for the match; it grants nothing by itself, so the delta is annotated as neutral.",
  },
  {
    id: "D-deny-added",
    title: "deny rule added",
    direction: "narrows",
    tier: "proven",
    explain: "A permissions.deny rule was added. Deny is checked first, so the match can no longer run: the control surface narrows.",
  },
  {
    id: "D-allow-removed",
    title: "allow rule removed",
    direction: "narrows",
    tier: "proven",
    explain: "A permissions.allow rule was removed; whatever it allowed without asking now falls back to the default mode.",
  },
  {
    id: "D-ask-removed",
    title: "ask rule removed",
    direction: "neutral",
    tier: "proven",
    explain: "A permissions.ask rule was removed. Symmetric to D-ask-added: the prompt is gone but nothing is granted by the removal itself; annotated as neutral.",
  },
  {
    id: "D-deny-removed",
    title: "deny rule removed",
    direction: "widens",
    tier: "proven",
    explain: "A permissions.deny rule was removed; whatever it blocked is no longer blocked by the repository (category deny-removed). Proven from the list semantics regardless of the rule's breadth.",
  },
  {
    id: "D-hook-added",
    title: "hook added",
    direction: "widens",
    tier: "proven",
    explain: "A hook entry (event, matcher, sha256 of the command) was added; Claude Code will run the command automatically (category hook, I6).",
  },
  {
    id: "D-hook-removed",
    title: "hook removed",
    direction: "narrows",
    tier: "proven",
    explain: "A hook entry was removed; the command no longer runs automatically.",
  },
  {
    id: "D-hook-changed",
    title: "hook command changed",
    direction: "widens",
    tier: "proven",
    explain:
      "The command behind an existing event and matcher changed (one removed key and one added key with the same hook:<event>:<matcher>: prefix in the same file are paired). A different command runs automatically: treated as a new hook (category hook).",
  },
  {
    id: "D-hook-attrs-changed",
    title: "hook attributes changed",
    direction: "neutral",
    tier: "proven",
    explain: "The hook's command is unchanged (same key) but type, timeout or prompt text differs. Annotated as neutral.",
  },
  {
    id: "D-mcp-added",
    title: "MCP server added",
    direction: "widens",
    tier: "proven",
    explain: "A server was added to .mcp.json; once approved it exposes new tools to the agent (category mcp, I7).",
  },
  {
    id: "D-mcp-removed",
    title: "MCP server removed",
    direction: "narrows",
    tier: "proven",
    explain: "A server was removed from .mcp.json.",
  },
  {
    id: "D-mcp-changed",
    title: "MCP transport, command, args or url changed",
    direction: "widens",
    tier: "proven",
    explain: "The server keeps its name but what runs or where it connects changed; treated like a new server (category mcp).",
  },
  {
    id: "D-mcp-attrs-changed",
    title: "MCP env/header key names or extra fields changed",
    direction: "unknown",
    tier: "unresolved",
    explain: "Only env or header key names, or fields outside the documented set, changed. The effect is not modeled; unresolved.",
  },
  {
    id: "D-enable-all-mcp",
    title: "enableAllProjectMcpServers set to true",
    direction: "widens",
    tier: "proven",
    explain: "enableAllProjectMcpServers became true: every server in .mcp.json is auto-approved (category mcp).",
  },
  {
    id: "D-enable-all-mcp-off",
    title: "enableAllProjectMcpServers no longer true",
    direction: "narrows",
    tier: "proven",
    explain: "enableAllProjectMcpServers went from true to false or was removed while true; servers need approval again.",
  },
  {
    id: "D-mode-widened",
    title: "defaultMode moved to bypassPermissions, auto or dontAsk",
    direction: "widens",
    tier: "proven",
    explain: "permissions.defaultMode was set to a widening mode from an absent or non-widening one (category mode, I5).",
  },
  {
    id: "D-mode-narrowed",
    title: "defaultMode left a widening mode",
    direction: "narrows",
    tier: "proven",
    explain: "permissions.defaultMode moved from bypassPermissions, auto or dontAsk to plan, default or acceptEdits, or was removed while widening (the effective mode then comes from settings V0 does not read).",
  },
  {
    id: "D-mode-neutral",
    title: "defaultMode set, removed or changed within one class",
    direction: "neutral",
    tier: "proven",
    explain: "defaultMode changed between two widening modes, between two non-widening modes, or was set to / removed from a non-widening value. Annotated as neutral.",
  },
  {
    id: "D-mode-unknown",
    title: "defaultMode value not documented",
    direction: "unknown",
    tier: "unresolved",
    explain: "A defaultMode value outside the documented set is involved; never treated as widening (I5).",
  },
  {
    id: "D-hooks-disabled",
    title: "disableAllHooks set to true",
    direction: "narrows",
    tier: "proven",
    explain: "disableAllHooks went false → true (or was added as true); no configured hook runs.",
  },
  {
    id: "D-hooks-reenabled",
    title: "disableAllHooks no longer true",
    direction: "widens",
    tier: "proven",
    explain: "disableAllHooks went true → false or was removed while true; every configured hook runs again (category hooks-reenabled).",
  },
  {
    id: "D-dir-added",
    title: "additionalDirectories entry added",
    direction: "widens",
    tier: "proven",
    explain: "permissions.additionalDirectories gained a path that Claude Code treats like the working directory (category directory). The path is recorded as written; anchoring is not interpreted.",
  },
  {
    id: "D-dir-removed",
    title: "additionalDirectories entry removed",
    direction: "narrows",
    tier: "proven",
    explain: "permissions.additionalDirectories lost a path.",
  },
  {
    id: "D-flag-default",
    title: "boolean flag set to or removed at its default",
    direction: "neutral",
    tier: "proven",
    explain: "enableAllProjectMcpServers or disableAllHooks was written as false or removed while false; the effective value did not change.",
  },
  {
    id: "D-moved",
    title: "same key and value, different file",
    direction: "neutral",
    tier: "proven",
    explain:
      "The key exists on both sides with an identical value but its location changed, e.g. from .claude/settings.json to the tracked .claude/settings.local.json. Reported once as changed (moved), never as removed plus added.",
  },
  {
    id: "D-unknown",
    title: "shape not in the direction table",
    direction: "unknown",
    tier: "unresolved",
    explain:
      "sandbox, env, helper commands, plugin lists, disableBypassPermissionsMode, unknown keys and credential-like literals have no direction rule. The delta is reported as unresolved so it is never rendered as clean.",
  },
];

/** Look up a direction rule by id. */
export function findDirectionRule(id: string): DirectionRule | null {
  return DIRECTION_RULES.find((rule) => rule.id === id) ?? null;
}

export interface DirectionResult {
  rule: string;
  direction: Direction;
  tier: Tier;
  notes: string[];
}

function result(id: string, notes: string[] = []): DirectionResult {
  const rule = findDirectionRule(id);
  if (rule === null) {
    throw new Error(`unknown direction rule ${id}`);
  }
  return { rule: id, direction: rule.direction, tier: rule.tier, notes };
}

function rawString(entry: Entry | null): string | null {
  if (entry === null || !isObject(entry.value)) {
    return null;
  }
  const raw = entry.value["raw"];
  return typeof raw === "string" ? raw : null;
}

function boolValue(entry: Entry | null): boolean | null {
  return entry !== null && typeof entry.value === "boolean" ? entry.value : null;
}

const MCP_TRANSPORT_FIELDS = ["transport", "command", "args", "url"] as const;

function field(entry: Entry, name: string): JsonValue | null {
  return isObject(entry.value) ? (entry.value[name] ?? null) : null;
}

/** Top-level value fields whose canonical JSON differs between two object values. */
export function changedFields(base: Entry, head: Entry): string[] {
  const names = new Set<string>();
  for (const entry of [base, head]) {
    if (isObject(entry.value)) {
      for (const name of Object.keys(entry.value)) {
        names.add(name);
      }
    }
  }
  return [...names].sort().filter((name) => JSON.stringify(field(base, name)) !== JSON.stringify(field(head, name)) && name !== "raw");
}

type ModeClass = "absent" | "widening" | "non-widening" | "unknown";

function modeClass(entry: Entry | null): ModeClass {
  if (entry === null) {
    return "absent";
  }
  const raw = rawString(entry);
  if (raw === null) {
    return "unknown";
  }
  return WIDENING_MODES.includes(raw) ? "widening" : NON_WIDENING_MODES.includes(raw) ? "non-widening" : "unknown";
}

function classifyMode(change: ChangeKind, base: Entry | null, head: Entry | null): DirectionResult {
  const from = modeClass(base);
  const to = modeClass(head);
  const note = `defaultMode ${rawString(base) ?? "(absent)"} → ${rawString(head) ?? "(absent)"}`;
  if (from === "unknown" || to === "unknown") {
    return result("D-mode-unknown", [note]);
  }
  if (change === "added") {
    return result(to === "widening" ? "D-mode-widened" : "D-mode-neutral", [note]);
  }
  if (change === "removed") {
    return result(from === "widening" ? "D-mode-narrowed" : "D-mode-neutral", [note]);
  }
  if (to === "widening" && from !== "widening") {
    return result("D-mode-widened", [note]);
  }
  if (from === "widening" && to !== "widening") {
    return result("D-mode-narrowed", [note]);
  }
  return result("D-mode-neutral", [note]);
}

function classifyBooleanFlag(change: ChangeKind, base: Entry | null, head: Entry | null, onTrue: string, offTrue: string): DirectionResult {
  const from = boolValue(base);
  const to = boolValue(head);
  if ((base !== null && from === null) || (head !== null && to === null)) {
    return result("D-unknown", ["flag value is not a boolean"]);
  }
  const note = `${String(from ?? "(absent)")} → ${String(to ?? "(absent)")}`;
  if (change === "added") {
    return result(to === true ? onTrue : "D-flag-default", [note]);
  }
  if (change === "removed") {
    return result(from === true ? offTrue : "D-flag-default", [note]);
  }
  return result(to === true ? onTrue : offTrue, [note]);
}

/**
 * Apply the direction table to one delta. `base` / `head` are the subject
 * entries (`null` on the side where the key is absent). For `moved`
 * deltas the answer is always `D-moved`.
 */
export function classifyDirection(change: ChangeKind, kind: EntryKind, key: string, base: Entry | null, head: Entry | null): DirectionResult {
  if (change === "moved") {
    return result("D-moved");
  }
  switch (kind) {
    case "perm": {
      const subject = head ?? base;
      const list = subject === null ? null : permListOf(subject);
      if (list === null) {
        return result("D-unknown");
      }
      if (change === "changed") {
        return result("D-moved");
      }
      const table = {
        added: { allow: "D-allow-added", ask: "D-ask-added", deny: "D-deny-added" },
        removed: { allow: "D-allow-removed", ask: "D-ask-removed", deny: "D-deny-removed" },
      } as const;
      return result(table[change][list]);
    }
    case "hook":
      if (change === "added") {
        return result("D-hook-added");
      }
      if (change === "removed") {
        return result("D-hook-removed");
      }
      if (base !== null && head !== null && base.key !== head.key) {
        return result("D-hook-changed", [`hook command changed; previous key ${base.key}`]);
      }
      return result("D-hook-attrs-changed", base !== null && head !== null ? [`changed fields: ${changedFields(base, head).join(", ")}`] : []);
    case "mcp": {
      if (change === "added") {
        return result("D-mcp-added");
      }
      if (change === "removed") {
        return result("D-mcp-removed");
      }
      const fields = base !== null && head !== null ? changedFields(base, head) : [];
      const note = `changed fields: ${fields.join(", ")}`;
      return fields.some((name) => (MCP_TRANSPORT_FIELDS as readonly string[]).includes(name)) ? result("D-mcp-changed", [note]) : result("D-mcp-attrs-changed", [note]);
    }
    case "dir":
      return result(change === "added" ? "D-dir-added" : change === "removed" ? "D-dir-removed" : "D-moved");
    case "mode":
      return key === "mode:defaultMode" ? classifyMode(change, base, head) : result("D-unknown");
    case "plugin_flag":
      if (key === "plugin_flag:enableAllProjectMcpServers") {
        return classifyBooleanFlag(change, base, head, "D-enable-all-mcp", "D-enable-all-mcp-off");
      }
      if (key === "plugin_flag:disableAllHooks") {
        return classifyBooleanFlag(change, base, head, "D-hooks-disabled", "D-hooks-reenabled");
      }
      return result("D-unknown");
    default:
      return result("D-unknown");
  }
}
