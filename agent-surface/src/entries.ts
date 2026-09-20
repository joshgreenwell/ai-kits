/**
 * Entry extraction (JG-150, plan §3.4).
 *
 * Turns the parsed `.claude/settings.json`, tracked `.claude/settings.local.json`
 * and `.mcp.json` into `Entry[]` with stable keys:
 *
 *   perm:<allow|ask|deny>:<canonical rule>      value {raw, rule, tool, spec, wildcard}
 *   mode:defaultMode | mode:disableBypassPermissionsMode   value {raw, mode} (mode duplicates raw so a mode change survives the raw-free semantic comparison)
 *   hook:<event>:<matcher>:<sha256(raw command)>   value {event, matcher, type, command, prompt, timeout}
 *   mcp:<server-name>                           value {transport, type_raw, command, args, url, env, headers, extra}
 *                                               (env / headers map each name to {redacted: true, length, sha256} of the raw value)
 *   dir:<path>                                  value {raw, path}
 *   sandbox:<key>                               value = the JSON value as written
 *   env_key:<NAME>                              value {redacted: true, length, sha256} of the raw value (never the value)
 *   helper:<apiKeyHelper|awsAuthRefresh|awsCredentialExport|otelHeadersHelper>   value {command}
 *   plugin_flag:<enabledPlugins|enableAllProjectMcpServers|disableAllHooks
 *               |enabledMcpjsonServers|disabledMcpjsonServers>                     value as written / {raw, names}
 *   unknown:<json_pointer>                      value = the JSON value as written (redacted)
 *   credential:<json_pointer>                   value {note: "credential-like value present", patterns, sha256(raw string)}
 *
 * Every entry carries `file`, `line`, `json_pointer` and `source_sha`.
 * `breadth`, `direction` and `tier` are left `unknown` / `unknown` /
 * `unresolved` here; the interpretations (CS-C) set them.
 *
 * Guarantees:
 *  - hook commands, helper commands and MCP commands are recorded as
 *    strings and never executed;
 *  - `env` values and MCP `env` / `headers` values never reach an entry;
 *    each is represented by its length and sha256 so that a changed value
 *    is a changed entry (SRF-3) while the value stays unprintable;
 *  - credential-like literals are redacted before any value is copied, so
 *    no entry (and no key) carries one. Identity is still computed over the
 *    raw text: the hook key hashes the raw command, a redacted `command`,
 *    `args`, `url` or helper field gets a sibling `<field>_sha256` of the
 *    raw text, and a credential entry carries the sha256 of the raw string
 *    it was found in. A sha256 of a whole command reveals nothing, and
 *    without it two commands that differ only inside a redacted span would
 *    compare equal (SRF-2);
 *  - unknown keys are surfaced as `unknown` entries, never dropped;
 *  - a shape the extractor cannot use (non-string rule, non-object server,
 *    …) is reported as `incomplete` for that pointer while every other
 *    entry is still extracted.
 */

import { createHash } from "node:crypto";

import type { Document, FileRole } from "./discover.js";
import { escapePointerToken } from "./jsonc.js";
import { normalizeRule } from "./normalize.js";
import { CREDENTIAL_PRESENT, redactTree } from "./redact.js";
import type { Entry, EntryKind, Incomplete, JsonObject, JsonValue, Source } from "./types.js";

/** Result of extracting one side's documents. */
export interface Extraction {
  /** Sorted with `sortEntries`. */
  entries: Entry[];
  incomplete: Incomplete[];
  /** Extra assumption lines (e.g. the non-empty `enabledPlugins` flag). */
  notes: string[];
}

/** Permission lists that produce `perm:` entries, in key order. */
export const PERMISSION_LISTS = ["allow", "ask", "deny"] as const;

/** Top-level settings keys that produce `helper:` entries (commands run by Claude Code). */
export const HELPER_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper"] as const;

/** Top-level settings keys that produce `plugin_flag:` entries. */
export const PLUGIN_FLAG_KEYS = [
  "enabledPlugins",
  "enableAllProjectMcpServers",
  "disableAllHooks",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
] as const;

/** Keys under `permissions` that produce `mode:` entries. */
export const MODE_KEYS = ["defaultMode", "disableBypassPermissionsMode"] as const;

/** Recognised MCP transports. Anything else is recorded with `transport: null`. */
export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;

/** Note appended to the assumptions when `enabledPlugins` is non-empty. */
export const PLUGINS_ENABLED_NOTE = "plugins: enabledPlugins is non-empty; plugin-provided hooks and servers are not modeled";

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: JsonValue | undefined): string {
  if (value === undefined) {
    return "absent";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

/** SHA-256 hex digest of a UTF-8 string. Used for entry identity (hook keys, redacted-field digests). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Digest of a raw value that redaction altered: the string itself, or the JSON of a list. */
function rawDigest(value: JsonValue): string {
  return sha256Hex(typeof value === "string" ? value : JSON.stringify(value));
}

/** The value at an RFC 6901 pointer of `root`, or `undefined`. */
function valueAt(root: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  if (pointer === "") {
    return current;
  }
  for (const token of pointer.split("/").slice(1)) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(key);
      current = Number.isInteger(index) && index >= 0 ? current[index] : undefined;
    } else if (isObject(current)) {
      current = current[key];
    } else {
      return undefined;
    }
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

/** Stable order: key, then file, then json_pointer (code-unit comparison). */
export function compareEntries(a: Entry, b: Entry): number {
  if (a.key !== b.key) {
    return a.key < b.key ? -1 : 1;
  }
  if (a.file !== b.file) {
    return a.file < b.file ? -1 : 1;
  }
  const pa = a.json_pointer ?? "";
  const pb = b.json_pointer ?? "";
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/** Return a sorted copy (see `compareEntries`). Never mutates its input. */
export function sortEntries(entries: readonly Entry[]): Entry[] {
  return [...entries].sort(compareEntries);
}

class DocumentExtractor {
  readonly entries: Entry[] = [];
  readonly incomplete: Incomplete[] = [];
  readonly notes: string[] = [];
  /** The parsed document before redaction; read only to compute digests, never copied. */
  private raw: JsonValue = null;

  constructor(
    private readonly doc: Document,
    private readonly sourceSha: string | null,
  ) {}

  line(pointer: string): number | null {
    return this.doc.parsed.pointers.get(pointer)?.line ?? null;
  }

  /** The raw string at `pointer`, or `null` when there is none. */
  rawString(pointer: string): string | null {
    const value = valueAt(this.raw, pointer);
    return typeof value === "string" ? value : null;
  }

  /** `{redacted: true, length, sha256}` for the raw string at `pointer`: comparable, never printable. */
  digestValue(pointer: string): JsonObject | null {
    const raw = this.rawString(pointer);
    if (raw === null) {
      return null;
    }
    const digest = Object.create(null) as JsonObject;
    digest["redacted"] = true;
    digest["length"] = raw.length;
    digest["sha256"] = sha256Hex(raw);
    return digest;
  }

  /**
   * Digest map of an object of string values (`env`, `headers`): name →
   * `{redacted, length, sha256}`, names sorted. A non-string value is
   * reported as incomplete for its pointer and left out. `null` when
   * `value` is not an object.
   */
  digestMap(value: JsonValue | undefined, pointer: string, label: string): JsonObject | null {
    if (!isObject(value)) {
      return null;
    }
    const out = Object.create(null) as JsonObject;
    for (const name of Object.keys(value).sort()) {
      const child = value[name];
      const childPointer = `${pointer}/${escapePointerToken(name)}`;
      const digest = typeof child === "string" ? this.digestValue(childPointer) : null;
      if (digest === null) {
        this.fail(childPointer, `${label}.${name} is ${describe(child)}, expected a string`);
        continue;
      }
      out[name] = digest;
    }
    return out;
  }

  /**
   * Add `<field>_sha256` to `value` for every named field whose displayed
   * (redacted) text differs from the raw text at `<pointer>/<field>`, so a
   * change inside a redacted span is still a change. The digest is of the
   * raw text; the raw text itself is never copied.
   */
  digestRedacted(value: Record<string, JsonValue>, pointer: string, fields: readonly string[]): void {
    for (const field of fields) {
      const shown = value[field];
      const raw = valueAt(this.raw, `${pointer}/${field}`);
      if (shown === undefined || shown === null || raw === undefined || raw === null) {
        continue;
      }
      if (JSON.stringify(shown) !== JSON.stringify(raw)) {
        value[`${field}_sha256`] = rawDigest(raw);
      }
    }
  }

  add(kind: EntryKind, key: string, value: JsonValue, pointer: string): void {
    this.entries.push({
      kind,
      key,
      value,
      breadth: kind === "perm" ? "unknown" : null,
      direction: "unknown",
      tier: "unresolved",
      file: this.doc.path,
      line: this.line(pointer),
      json_pointer: pointer,
      source_sha: this.sourceSha,
    });
  }

  fail(pointer: string, reason: string): void {
    const line = this.line(pointer);
    this.incomplete.push({ path: this.doc.path, reason: `${reason} at ${pointer === "" ? "/" : pointer}`, lines: line === null ? null : [line] });
  }

  run(): void {
    const raw = this.doc.parsed.value;
    if (raw === undefined) {
      return; // discovery already reported the parse failure
    }
    this.raw = raw;
    const redacted = redactTree(raw);
    if (!isObject(redacted.value)) {
      this.fail("", `top level is ${describe(redacted.value)}, expected an object`);
    } else if (this.doc.role === "mcp") {
      this.extractMcpFile(redacted.value);
    } else {
      this.extractSettings(redacted.value);
    }
    for (const finding of redacted.findings) {
      const text = this.rawString(finding.pointer);
      this.add(
        "credential",
        `credential:${finding.pointer}`,
        { note: CREDENTIAL_PRESENT, patterns: [...finding.patterns], sha256: text === null ? null : sha256Hex(text) },
        finding.pointer,
      );
    }
  }

  // ---- settings.json / settings.local.json -------------------------------

  private extractSettings(root: JsonObject): void {
    for (const key of Object.keys(root)) {
      const value = root[key];
      const pointer = `/${escapePointerToken(key)}`;
      if (value === undefined) {
        continue;
      }
      if (key === "permissions") {
        this.extractPermissions(value, pointer);
      } else if (key === "hooks") {
        this.extractHooks(value, pointer);
      } else if (key === "env") {
        this.extractEnv(value, pointer);
      } else if (key === "sandbox") {
        this.extractSandbox(value, pointer);
      } else if ((HELPER_KEYS as readonly string[]).includes(key)) {
        this.extractHelper(key, value, pointer);
      } else if ((PLUGIN_FLAG_KEYS as readonly string[]).includes(key)) {
        this.extractPluginFlag(key, value, pointer);
      } else {
        this.add("unknown", `unknown:${pointer}`, value, pointer);
      }
    }
  }

  private extractPermissions(value: JsonValue, pointer: string): void {
    if (!isObject(value)) {
      this.fail(pointer, `permissions is ${describe(value)}, expected an object`);
      return;
    }
    for (const key of Object.keys(value)) {
      const child = value[key];
      const childPointer = `${pointer}/${escapePointerToken(key)}`;
      if (child === undefined) {
        continue;
      }
      if ((PERMISSION_LISTS as readonly string[]).includes(key)) {
        this.extractRuleList(key, child, childPointer);
      } else if (key === "additionalDirectories") {
        this.extractDirectories(child, childPointer);
      } else if ((MODE_KEYS as readonly string[]).includes(key)) {
        if (typeof child !== "string") {
          this.fail(childPointer, `${key} is ${describe(child)}, expected a string`);
        } else {
          this.add("mode", `mode:${key}`, { raw: child, mode: child }, childPointer);
        }
      } else {
        this.add("unknown", `unknown:${childPointer}`, child, childPointer);
      }
    }
  }

  private extractRuleList(list: string, value: JsonValue, pointer: string): void {
    if (!Array.isArray(value)) {
      this.fail(pointer, `permissions.${list} is ${describe(value)}, expected an array of rule strings`);
      return;
    }
    value.forEach((item, index) => {
      const itemPointer = `${pointer}/${index}`;
      if (typeof item !== "string") {
        this.fail(itemPointer, `permissions.${list} element is ${describe(item)}, expected a rule string`);
        return;
      }
      const parsed = normalizeRule(item);
      if (parsed.tool === "") {
        this.fail(itemPointer, `permissions.${list} element is an empty rule string`);
        return;
      }
      this.add(
        "perm",
        `perm:${list}:${parsed.rule}`,
        { raw: parsed.raw, rule: parsed.rule, tool: parsed.tool, spec: parsed.spec, wildcard: parsed.wildcard },
        itemPointer,
      );
    });
  }

  private extractDirectories(value: JsonValue, pointer: string): void {
    if (!Array.isArray(value)) {
      this.fail(pointer, `permissions.additionalDirectories is ${describe(value)}, expected an array of paths`);
      return;
    }
    value.forEach((item, index) => {
      const itemPointer = `${pointer}/${index}`;
      if (typeof item !== "string") {
        this.fail(itemPointer, `permissions.additionalDirectories element is ${describe(item)}, expected a path string`);
        return;
      }
      const trimmed = item.trim();
      if (trimmed === "") {
        this.fail(itemPointer, "permissions.additionalDirectories element is an empty path");
        return;
      }
      this.add("dir", `dir:${trimmed}`, { raw: item, path: trimmed }, itemPointer);
    });
  }

  private extractHooks(value: JsonValue, pointer: string): void {
    if (!isObject(value)) {
      this.fail(pointer, `hooks is ${describe(value)}, expected an object keyed by event`);
      return;
    }
    for (const event of Object.keys(value)) {
      const groups = value[event];
      const eventPointer = `${pointer}/${escapePointerToken(event)}`;
      if (!Array.isArray(groups)) {
        this.fail(eventPointer, `hooks.${event} is ${describe(groups)}, expected an array of matcher groups`);
        continue;
      }
      groups.forEach((group, groupIndex) => {
        const groupPointer = `${eventPointer}/${groupIndex}`;
        if (!isObject(group)) {
          this.fail(groupPointer, `hooks.${event} group is ${describe(group)}, expected an object`);
          return;
        }
        const matcherRaw = group["matcher"];
        let matcher: string | null = null;
        if (matcherRaw !== undefined) {
          if (typeof matcherRaw !== "string") {
            this.fail(`${groupPointer}/matcher`, `matcher is ${describe(matcherRaw)}, expected a string`);
            return;
          }
          matcher = matcherRaw;
        }
        const hooks = group["hooks"];
        if (!Array.isArray(hooks)) {
          this.fail(`${groupPointer}/hooks`, `hooks is ${describe(hooks)}, expected an array of hook definitions`);
          return;
        }
        hooks.forEach((hook, hookIndex) => {
          this.extractHook(event, matcher, hook, `${groupPointer}/hooks/${hookIndex}`);
        });
      });
    }
  }

  private extractHook(event: string, matcher: string | null, hook: JsonValue, pointer: string): void {
    if (!isObject(hook)) {
      this.fail(pointer, `hook is ${describe(hook)}, expected an object`);
      return;
    }
    const type = hook["type"];
    const command = hook["command"];
    const prompt = hook["prompt"];
    const timeout = hook["timeout"];
    // Identity comes from the raw text (the redacted tree has the same shape and types).
    const text = typeof command === "string" ? this.rawString(`${pointer}/command`) : typeof prompt === "string" ? this.rawString(`${pointer}/prompt`) : null;
    if (text === null) {
      this.fail(pointer, `hook has no string command or prompt (command is ${describe(command)})`);
      return;
    }
    const value: Record<string, JsonValue> = {
      event,
      matcher,
      type: typeof type === "string" ? type : null,
      command: typeof command === "string" ? command : null,
      prompt: typeof prompt === "string" ? prompt : null,
      timeout: typeof timeout === "number" ? timeout : null,
    };
    this.digestRedacted(value, pointer, ["command", "prompt"]);
    this.add("hook", `hook:${event}:${matcher ?? ""}:${sha256Hex(text)}`, value, pointer);
  }

  private extractEnv(value: JsonValue, pointer: string): void {
    if (!isObject(value)) {
      this.fail(pointer, `env is ${describe(value)}, expected an object of NAME: value`);
      return;
    }
    for (const name of Object.keys(value)) {
      const child = value[name];
      const childPointer = `${pointer}/${escapePointerToken(name)}`;
      const digest = typeof child === "string" ? this.digestValue(childPointer) : null;
      if (digest === null) {
        this.fail(childPointer, `env.${name} is ${describe(child)}, expected a string`);
        continue;
      }
      // The value is never carried, credential-like or not; its digest makes a change visible.
      this.add("env_key", `env_key:${name}`, digest, childPointer);
    }
  }

  private extractSandbox(value: JsonValue, pointer: string): void {
    if (!isObject(value)) {
      this.fail(pointer, `sandbox is ${describe(value)}, expected an object`);
      return;
    }
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child !== undefined) {
        const childPointer = `${pointer}/${escapePointerToken(key)}`;
        this.add("sandbox", `sandbox:${key}`, child, childPointer);
      }
    }
  }

  private extractHelper(key: string, value: JsonValue, pointer: string): void {
    if (typeof value !== "string") {
      this.fail(pointer, `${key} is ${describe(value)}, expected a command string`);
      return;
    }
    const helper: Record<string, JsonValue> = { command: value };
    const raw = this.rawString(pointer);
    if (raw !== null && raw !== value) {
      helper["command_sha256"] = sha256Hex(raw);
    }
    this.add("helper", `helper:${key}`, helper, pointer);
  }

  private extractPluginFlag(key: string, value: JsonValue, pointer: string): void {
    if (key === "enabledMcpjsonServers" || key === "disabledMcpjsonServers") {
      if (!Array.isArray(value)) {
        this.fail(pointer, `${key} is ${describe(value)}, expected an array of server names`);
        return;
      }
      const names: string[] = [];
      let usable = true;
      value.forEach((item, index) => {
        if (typeof item !== "string") {
          this.fail(`${pointer}/${index}`, `${key} element is ${describe(item)}, expected a server name`);
          usable = false;
        } else {
          names.push(item);
        }
      });
      if (usable) {
        this.add("plugin_flag", `plugin_flag:${key}`, { raw: value, names: [...new Set(names)].sort() }, pointer);
      }
      return;
    }
    if (key === "enabledPlugins" && isObject(value) && Object.keys(value).length > 0) {
      this.notes.push(`${PLUGINS_ENABLED_NOTE} (${this.doc.path})`);
    }
    this.add("plugin_flag", `plugin_flag:${key}`, value, pointer);
  }

  // ---- .mcp.json ------------------------------------------------------------

  private extractMcpFile(root: JsonObject): void {
    for (const key of Object.keys(root)) {
      const value = root[key];
      const pointer = `/${escapePointerToken(key)}`;
      if (value === undefined) {
        continue;
      }
      if (key !== "mcpServers") {
        this.add("unknown", `unknown:${pointer}`, value, pointer);
        continue;
      }
      if (!isObject(value)) {
        this.fail(pointer, `mcpServers is ${describe(value)}, expected an object keyed by server name`);
        continue;
      }
      for (const name of Object.keys(value)) {
        this.extractMcpServer(name, value[name], `${pointer}/${escapePointerToken(name)}`);
      }
    }
  }

  private extractMcpServer(name: string, server: JsonValue | undefined, pointer: string): void {
    if (!isObject(server)) {
      this.fail(pointer, `mcpServers.${name} is ${describe(server)}, expected an object`);
      return;
    }
    const typeRaw = server["type"];
    const command = server["command"];
    const args = server["args"];
    const url = server["url"];
    const env = server["env"];
    const headers = server["headers"];
    let transport: string | null = null;
    if (typeof typeRaw === "string") {
      transport = (MCP_TRANSPORTS as readonly string[]).includes(typeRaw) ? typeRaw : null;
    } else if (typeRaw === undefined) {
      transport = typeof command === "string" ? "stdio" : null;
    }
    const argList: string[] | null = Array.isArray(args) && args.every((item): item is string => typeof item === "string") ? args : null;
    if (args !== undefined && argList === null) {
      this.fail(`${pointer}/args`, `mcpServers.${name}.args is not an array of strings`);
    }
    if (env !== undefined && !isObject(env)) {
      this.fail(`${pointer}/env`, `mcpServers.${name}.env is ${describe(env)}, expected an object`);
    }
    if (headers !== undefined && !isObject(headers)) {
      this.fail(`${pointer}/headers`, `mcpServers.${name}.headers is ${describe(headers)}, expected an object`);
    }
    // Values are never carried; each is represented by its length and sha256 so a change is visible.
    const envDigests = this.digestMap(env, `${pointer}/env`, `mcpServers.${name}.env`);
    const headerDigests = this.digestMap(headers, `${pointer}/headers`, `mcpServers.${name}.headers`);
    const extra = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(server)) {
      if (!["type", "command", "args", "url", "env", "headers"].includes(key)) {
        const child = server[key];
        if (child !== undefined) {
          extra[key] = child;
        }
      }
    }
    const value: Record<string, JsonValue> = {
      name,
      transport,
      type_raw: typeof typeRaw === "string" ? typeRaw : null,
      command: typeof command === "string" ? command : null,
      args: argList,
      url: typeof url === "string" ? url : null,
      env: envDigests,
      headers: headerDigests,
      extra: Object.keys(extra).length === 0 ? null : extra,
    };
    this.digestRedacted(value, pointer, ["command", "args", "url"]);
    this.add("mcp", `mcp:${name}`, value, pointer);
  }
}

function shaFor(doc: Document, sources: readonly Source[]): string | null {
  const source = sources.find((item) => item.path === doc.path) ?? doc.source;
  return /^[0-9a-f]{40,64}$/.test(source.sha) ? source.sha : null;
}

/**
 * Extract entries from every parsed document of one side.
 *
 * `sources` is the side's `sources[]`; it supplies `source_sha` (the commit
 * SHA the file was read at, or `null` for worktree reads). Entries come
 * back sorted by key, file, json_pointer; `incomplete` and `notes` keep
 * document order (documents are already sorted by path).
 *
 * Never executes anything, never expands variables, never reads a file.
 */
export function extractEntries(documents: readonly Document[], sources: readonly Source[] = []): Extraction {
  const entries: Entry[] = [];
  const incomplete: Incomplete[] = [];
  const notes: string[] = [];
  for (const doc of documents) {
    const extractor = new DocumentExtractor(doc, shaFor(doc, sources));
    extractor.run();
    entries.push(...extractor.entries);
    incomplete.push(...extractor.incomplete);
    notes.push(...extractor.notes);
  }
  return { entries: sortEntries(entries), incomplete, notes };
}

/** Roles handled by the extractor; exported for documentation tests. */
export const EXTRACTED_ROLES: readonly FileRole[] = ["settings", "settings_local", "mcp"];

/**
 * The part of an entry that carries meaning for a comparison: kind, key,
 * file and the value without its `raw` text. Evidence fields (`line`,
 * `json_pointer`, `source_sha`) and the as-written `raw` are deliberately
 * excluded so that a reformat-only change (whitespace, comments, key order,
 * `:*` vs ` *`) compares equal. The diff (CS-C) compares these.
 */
export interface SemanticEntry {
  kind: EntryKind;
  key: string;
  file: string;
  value: JsonValue;
}

/** Project `entry` to its `SemanticEntry` (see the type). Never mutates its input. */
export function semanticEntry(entry: Entry): SemanticEntry {
  let value: JsonValue = entry.value;
  if (isObject(value) && "raw" in value) {
    const copy = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (key !== "raw" && child !== undefined) {
        copy[key] = child;
      }
    }
    value = copy;
  }
  return { kind: entry.kind, key: entry.key, file: entry.file, value };
}
