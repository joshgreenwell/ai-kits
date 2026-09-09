import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalJson } from "../src/canonical.js";
import { discover, type Document, type FileRole } from "../src/discover.js";
import {
  compareEntries,
  extractEntries,
  HELPER_KEYS,
  PLUGIN_FLAG_KEYS,
  PLUGINS_ENABLED_NOTE,
  semanticEntry,
  sha256Hex,
  sortEntries,
} from "../src/entries.js";
import { parseJsonc } from "../src/jsonc.js";
import { CREDENTIAL_PRESENT, REDACTED, redactString, redactTree } from "../src/redact.js";
import type { Entry, JsonObject, Source } from "../src/types.js";
import { makeRepo, readFixture, removeDir, tempDir } from "./helpers.js";

function doc(pathName: string, role: FileRole, text: string, sha = "worktree"): Document {
  const parsed = parseJsonc(text, { path: pathName });
  const source: Source = { path: pathName, sha, blob: null, parsed: parsed.value !== undefined, status: "read", tracked: null, note: null };
  return { path: pathName, role, text, parsed, source };
}

function settings(text: string): Document {
  return doc(".claude/settings.json", "settings", text);
}

function mcp(text: string): Document {
  return doc(".mcp.json", "mcp", text);
}

function keys(entries: readonly Entry[]): string[] {
  return entries.map((entry) => entry.key);
}

/** JSON round trip: parsed objects are prototype-less, and strict deepEqual compares prototypes. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function byKey(entries: readonly Entry[], key: string): Entry {
  const found = entries.filter((entry) => entry.key === key);
  assert.equal(found.length, 1, `expected exactly one entry for ${key}, got ${found.length}`);
  return plain(found[0] as Entry);
}

describe("entries: every entry carries file, line, json_pointer, source_sha (JG-150)", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("rich");
  });
  after(() => removeDir(repo.dir));

  it("extracts the rich fixture at a ref with the commit SHA on every entry", () => {
    const discovery = discover({ kind: "git", spec: "HEAD", sha: repo.sha, cwd: repo.dir });
    assert.deepEqual(discovery.incomplete, []);
    const { entries, incomplete } = extractEntries(discovery.documents, discovery.sources);
    assert.deepEqual(incomplete, []);
    assert.ok(entries.length >= 36, `got ${entries.length} entries`);
    for (const entry of entries) {
      assert.equal(typeof entry.file, "string", entry.key);
      assert.ok([".claude/settings.json", ".claude/settings.local.json", ".mcp.json"].includes(entry.file), entry.key);
      assert.equal(typeof entry.line, "number", `${entry.key} has no line`);
      assert.ok((entry.line ?? 0) >= 5, `${entry.key} line ${entry.line} is inside the header comment`);
      assert.ok(entry.json_pointer?.startsWith("/"), `${entry.key} has no pointer`);
      assert.equal(entry.source_sha, repo.sha, entry.key);
      assert.equal(entry.direction, "unknown");
      assert.equal(entry.tier, "unresolved");
      assert.equal(entry.breadth, entry.kind === "perm" ? "unknown" : null);
    }
    assert.equal(byKey(entries, "perm:deny:Bash(curl *)").line, 10);
    assert.equal(byKey(entries, "perm:deny:Bash(curl *)").json_pointer, "/permissions/deny/0");
    assert.equal(byKey(entries, "mode:defaultMode").line, 12);
    assert.deepEqual(byKey(entries, "mode:defaultMode").value, { raw: "acceptEdits" });
    assert.deepEqual(byKey(entries, "mode:disableBypassPermissionsMode").value, { raw: "disable" });
  });

  it("keeps same-key entries from settings.json and the tracked settings.local.json, sorted by file", () => {
    const discovery = discover({ kind: "git", spec: "HEAD", sha: repo.sha, cwd: repo.dir });
    const { entries } = extractEntries(discovery.documents, discovery.sources);
    const shared = entries.filter((entry) => entry.key === "perm:allow:Bash(npm test)");
    assert.deepEqual(
      shared.map((entry) => entry.file),
      [".claude/settings.json", ".claude/settings.local.json"],
    );
    assert.equal(byKey(entries, "perm:allow:Bash(ls *)").file, ".claude/settings.local.json");
    assert.deepEqual(keys(entries), keys(sortEntries(entries)), "already sorted");
    assert.deepEqual(keys(sortEntries([...entries].reverse())), keys(entries), "sort is stable and total");
    assert.ok(discovery.sources.find((source) => source.path === ".claude/settings.local.json")?.tracked);
  });

  it("uses null source_sha for a worktree read", () => {
    const discovery = discover({ kind: "worktree", spec: repo.dir, root: repo.dir });
    const { entries } = extractEntries(discovery.documents, discovery.sources);
    assert.ok(entries.length > 0);
    assert.ok(entries.every((entry) => entry.source_sha === null));
  });
});

describe("entries: permissions, mode, dirs", () => {
  it("produces perm entries with canonical keys and raw text, per list", () => {
    const { entries, incomplete } = extractEntries([
      settings('{"permissions": {"allow": ["Bash(npm run:*)", " Read "], "ask": ["Bash(git push *)"], "deny": ["WebFetch"]}}'),
    ]);
    assert.deepEqual(incomplete, []);
    assert.deepEqual(keys(entries), ["perm:allow:Bash(npm run *)", "perm:allow:Read", "perm:ask:Bash(git push *)", "perm:deny:WebFetch"]);
    const run = byKey(entries, "perm:allow:Bash(npm run *)");
    assert.deepEqual(run.value, { raw: "Bash(npm run:*)", rule: "Bash(npm run *)", tool: "Bash", spec: "npm run *", wildcard: "trailing" });
    assert.equal(run.breadth, "unknown");
    assert.deepEqual(byKey(entries, "perm:allow:Read").value, { raw: " Read ", rule: "Read", tool: "Read", spec: null, wildcard: null });
  });

  it("negative case: a non-string allow element is incomplete for that pointer; other entries are still extracted", () => {
    const text = new TextDecoder().decode(readFixture("repos/non-string-allow/.claude/settings.json"));
    const { entries, incomplete } = extractEntries([settings(text)]);
    assert.deepEqual(incomplete, [
      {
        path: ".claude/settings.json",
        reason: "permissions.allow element is number, expected a rule string at /permissions/allow/1",
        lines: [7],
      },
    ]);
    assert.deepEqual(keys(entries), ["perm:allow:Bash(npm test)", "perm:allow:Read", "perm:deny:Bash(curl *)"]);
    assert.equal(byKey(entries, "perm:allow:Read").json_pointer, "/permissions/allow/2");
  });

  it("reports an empty rule, a non-array list and a non-object permissions block as incomplete", () => {
    const empty = extractEntries([settings('{"permissions": {"allow": ["", "Read"]}}')]);
    assert.deepEqual(keys(empty.entries), ["perm:allow:Read"]);
    assert.match(empty.incomplete[0]?.reason ?? "", /empty rule string at \/permissions\/allow\/0/);
    const notArray = extractEntries([settings('{"permissions": {"deny": "Bash"}}')]);
    assert.deepEqual(notArray.entries, []);
    assert.match(notArray.incomplete[0]?.reason ?? "", /permissions\.deny is string, expected an array/);
    const notObject = extractEntries([settings('{"permissions": ["Read"], "disableAllHooks": true}')]);
    assert.deepEqual(keys(notObject.entries), ["plugin_flag:disableAllHooks"]);
    assert.match(notObject.incomplete[0]?.reason ?? "", /permissions is array, expected an object at \/permissions/);
  });

  it("turns additionalDirectories into dir entries with trimmed paths and a non-string defaultMode into incomplete", () => {
    const { entries, incomplete } = extractEntries([
      settings('{"permissions": {"additionalDirectories": ["../shared-lib", "/srv/data ", 7], "defaultMode": 3}}'),
    ]);
    assert.deepEqual(keys(entries), ["dir:../shared-lib", "dir:/srv/data"]);
    assert.deepEqual(byKey(entries, "dir:/srv/data").value, { raw: "/srv/data ", path: "/srv/data" });
    assert.deepEqual(
      incomplete.map((item) => item.reason),
      [
        "permissions.additionalDirectories element is number, expected a path string at /permissions/additionalDirectories/2",
        "defaultMode is number, expected a string at /permissions/defaultMode",
      ],
    );
  });

  it("surfaces an unknown key nested under permissions instead of dropping it", () => {
    const { entries } = extractEntries([settings('{"permissions": {"allowAll": true}}')]);
    assert.deepEqual(keys(entries), ["unknown:/permissions/allowAll"]);
    assert.equal(entries[0]?.kind, "unknown");
    assert.equal(entries[0]?.value, true);
  });
});

describe("entries: hooks are recorded and hashed, never executed", () => {
  it("puts sha256(command) in the key so a changed command is a changed entry", () => {
    const before = extractEntries([settings('{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo one"}]}]}}')]);
    const after = extractEntries([settings('{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo two"}]}]}}')]);
    assert.deepEqual(keys(before.entries), [`hook:PreToolUse:Bash:${sha256Hex("echo one")}`]);
    assert.deepEqual(keys(after.entries), [`hook:PreToolUse:Bash:${sha256Hex("echo two")}`]);
    assert.notEqual(before.entries[0]?.key, after.entries[0]?.key);
    assert.deepEqual(before.entries[0]?.value, { event: "PreToolUse", matcher: "Bash", type: "command", command: "echo one", prompt: null, timeout: null });
    assert.equal(before.entries[0]?.json_pointer, "/hooks/PreToolUse/0/hooks/0");
  });

  it("uses an empty matcher segment when the matcher is absent or empty, and hashes prompt hooks", () => {
    const { entries } = extractEntries([
      settings(
        '{"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "echo any", "timeout": 5}]}], "Stop": [{"matcher": "", "hooks": [{"type": "prompt", "prompt": "Summarize"}]}]}}',
      ),
    ]);
    assert.deepEqual(keys(entries), [`hook:PreToolUse::${sha256Hex("echo any")}`, `hook:Stop::${sha256Hex("Summarize")}`]);
    assert.equal((entries[0]?.value as JsonObject)["matcher"], null);
    assert.equal((entries[0]?.value as JsonObject)["timeout"], 5);
    assert.equal((entries[1]?.value as JsonObject)["matcher"], "");
    assert.equal((entries[1]?.value as JsonObject)["prompt"], "Summarize");
    assert.equal((entries[1]?.value as JsonObject)["command"], null);
  });

  it("does not execute a hook command (a marker file the command would create never appears)", () => {
    const dir = tempDir();
    try {
      const marker = path.join(dir, "executed-marker");
      const command = `touch ${marker}`;
      const { entries } = extractEntries([settings(JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }))]);
      assert.deepEqual(keys(entries), [`hook:SessionStart::${sha256Hex(command)}`]);
      assert.equal((entries[0]?.value as JsonObject)["command"], command);
      assert.ok(!fs.existsSync(marker));
    } finally {
      removeDir(dir);
    }
  });

  it("reports malformed hook shapes as incomplete per pointer while extracting the rest", () => {
    const { entries, incomplete } = extractEntries([
      settings(
        '{"hooks": {"PreToolUse": "nope", "PostToolUse": [{"matcher": 3, "hooks": []}, {"hooks": [{"type": "command"}, {"type": "command", "command": "echo ok"}]}, 5]}}',
      ),
    ]);
    assert.deepEqual(keys(entries), [`hook:PostToolUse::${sha256Hex("echo ok")}`]);
    assert.deepEqual(
      incomplete.map((item) => item.reason),
      [
        "hooks.PreToolUse is string, expected an array of matcher groups at /hooks/PreToolUse",
        "matcher is number, expected a string at /hooks/PostToolUse/0/matcher",
        "hook has no string command or prompt (command is absent) at /hooks/PostToolUse/1/hooks/0",
        "hooks.PostToolUse group is number, expected an object at /hooks/PostToolUse/2",
      ],
    );
  });
});

describe("entries: MCP servers", () => {
  const richMcp = () => new TextDecoder().decode(readFixture("repos/rich/.mcp.json"));

  it("records transport, literal command or URL, env key names and header key names only", () => {
    const { entries, incomplete } = extractEntries([mcp(richMcp())]);
    assert.deepEqual(incomplete, []);
    assert.deepEqual(keys(entries), ["mcp:build", "mcp:docs", "mcp:events", "mcp:odd", "unknown:/extraTopLevel"]);
    assert.deepEqual(byKey(entries, "mcp:docs").value, {
      name: "docs",
      transport: "stdio",
      type_raw: null,
      command: "npx",
      args: ["-y", "example-docs-server"],
      url: null,
      env_keys: ["DOCS_ROOT", "DOCS_TOKEN"],
      header_keys: null,
      extra: null,
    });
    assert.deepEqual(byKey(entries, "mcp:build").value, {
      name: "build",
      transport: "http",
      type_raw: "http",
      command: null,
      args: null,
      url: "http://example.invalid/mcp",
      env_keys: null,
      header_keys: ["Authorization", "X-Example"],
      extra: null,
    });
    assert.equal((byKey(entries, "mcp:events").value as JsonObject)["transport"], "sse");
    assert.equal((byKey(entries, "mcp:events").value as JsonObject)["url"], "http://${MCP_HOST}/sse");
    const odd = byKey(entries, "mcp:odd").value as JsonObject;
    assert.equal(odd["transport"], null);
    assert.equal(odd["type_raw"], "websocket");
    assert.deepEqual(odd["extra"], { cwd: "/srv/odd" });
    assert.equal(byKey(entries, "mcp:docs").line, 7);
    assert.equal(byKey(entries, "mcp:docs").json_pointer, "/mcpServers/docs");
  });

  it("never carries env or header values into the output", () => {
    const { entries } = extractEntries([mcp(richMcp())]);
    const text = canonicalJson(entries);
    assert.ok(!text.includes("synthetic-not-a-real-token"), "env value leaked");
    assert.ok(!text.includes("./docs"), "env value leaked");
    assert.ok(!text.includes("${BUILD_TOKEN}"), "header value leaked");
    assert.ok(text.includes("DOCS_TOKEN"), "env key name kept");
  });

  it("reports a non-object server, a non-object mcpServers and bad args/env/headers as incomplete", () => {
    const bad = extractEntries([mcp('{"mcpServers": {"a": "npx", "b": {"command": "x", "args": "y", "env": [], "headers": 1}}}')]);
    assert.deepEqual(keys(bad.entries), ["mcp:b"]);
    assert.deepEqual(
      bad.incomplete.map((item) => item.reason),
      [
        "mcpServers.a is string, expected an object at /mcpServers/a",
        "mcpServers.b.args is not an array of strings at /mcpServers/b/args",
        "mcpServers.b.env is array, expected an object at /mcpServers/b/env",
        "mcpServers.b.headers is number, expected an object at /mcpServers/b/headers",
      ],
    );
    const list = extractEntries([mcp('{"mcpServers": []}')]);
    assert.deepEqual(list.entries, []);
    assert.match(list.incomplete[0]?.reason ?? "", /mcpServers is array, expected an object keyed by server name/);
  });
});

describe("entries: env keys, sandbox, helpers, plugin flags, unknown keys", () => {
  it("emits env_key entries whose value is always <redacted>", () => {
    const { entries, incomplete } = extractEntries([settings('{"env": {"EXAMPLE_FLAG": "1", "EXAMPLE_NUM": 2}}')]);
    assert.deepEqual(keys(entries), ["env_key:EXAMPLE_FLAG"]);
    assert.equal(entries[0]?.value, REDACTED);
    assert.deepEqual(
      incomplete.map((item) => item.reason),
      ["env.EXAMPLE_NUM is number, expected a string at /env/EXAMPLE_NUM"],
    );
    assert.ok(!canonicalJson(entries).includes('"1"'));
  });

  it("emits one sandbox entry per sandbox key with the value as written", () => {
    const { entries } = extractEntries([settings('{"sandbox": {"enabled": true, "network": {"allowedDomains": ["example.invalid"]}}}')]);
    assert.deepEqual(keys(entries), ["sandbox:enabled", "sandbox:network"]);
    assert.equal(byKey(entries, "sandbox:enabled").value, true);
    assert.deepEqual(byKey(entries, "sandbox:network").value, { allowedDomains: ["example.invalid"] });
    assert.equal(byKey(entries, "sandbox:network").json_pointer, "/sandbox/network");
  });

  it("emits helper entries for every documented helper key and rejects non-string helpers", () => {
    const object: Record<string, unknown> = {};
    for (const key of HELPER_KEYS) {
      object[key] = `/usr/local/bin/${key}`;
    }
    const { entries } = extractEntries([settings(JSON.stringify(object))]);
    assert.deepEqual(keys(entries), HELPER_KEYS.map((key) => `helper:${key}`).sort());
    assert.deepEqual(byKey(entries, "helper:apiKeyHelper").value, { command: "/usr/local/bin/apiKeyHelper" });
    const bad = extractEntries([settings('{"apiKeyHelper": ["x"]}')]);
    assert.deepEqual(bad.entries, []);
    assert.match(bad.incomplete[0]?.reason ?? "", /apiKeyHelper is array, expected a command string/);
  });

  it("emits plugin_flag entries, sorts MCP allow/deny names and flags a non-empty enabledPlugins", () => {
    const { entries, notes } = extractEntries([
      settings(
        '{"enabledPlugins": {"p@m": true}, "enableAllProjectMcpServers": true, "disableAllHooks": false, "enabledMcpjsonServers": ["z", "a", "z"], "disabledMcpjsonServers": []}',
      ),
    ]);
    assert.deepEqual(keys(entries), PLUGIN_FLAG_KEYS.map((key) => `plugin_flag:${key}`).sort());
    assert.deepEqual(byKey(entries, "plugin_flag:enabledMcpjsonServers").value, { raw: ["z", "a", "z"], names: ["a", "z"] });
    assert.deepEqual(byKey(entries, "plugin_flag:disabledMcpjsonServers").value, { raw: [], names: [] });
    assert.equal(byKey(entries, "plugin_flag:enableAllProjectMcpServers").value, true);
    assert.equal(byKey(entries, "plugin_flag:disableAllHooks").value, false);
    assert.deepEqual(byKey(entries, "plugin_flag:enabledPlugins").value, { "p@m": true });
    assert.deepEqual(notes, [`${PLUGINS_ENABLED_NOTE} (.claude/settings.json)`]);
    const empty = extractEntries([settings('{"enabledPlugins": {}, "enabledMcpjsonServers": ["a", 1]}')]);
    assert.deepEqual(empty.notes, []);
    assert.deepEqual(keys(empty.entries), ["plugin_flag:enabledPlugins"]);
    assert.match(empty.incomplete[0]?.reason ?? "", /enabledMcpjsonServers element is number/);
  });

  it("surfaces unknown top-level keys as kind unknown with direction unknown and tier unresolved", () => {
    const { entries } = extractEntries([settings('{"model": "example-model", "statusLine": {"type": "command", "command": "echo s"}, "$schema": "x"}')]);
    assert.deepEqual(keys(entries), ["unknown:/$schema", "unknown:/model", "unknown:/statusLine"]);
    for (const entry of entries) {
      assert.equal(entry.kind, "unknown");
      assert.equal(entry.direction, "unknown");
      assert.equal(entry.tier, "unresolved");
      assert.equal(entry.breadth, null);
    }
    assert.equal(byKey(entries, "unknown:/model").value, "example-model");
    assert.deepEqual(byKey(entries, "unknown:/statusLine").value, { type: "command", command: "echo s" });
  });

  it("reports a non-object document root as incomplete and extracts nothing from it", () => {
    const { entries, incomplete } = extractEntries([settings("[1, 2]")]);
    assert.deepEqual(entries, []);
    assert.deepEqual(incomplete, [{ path: ".claude/settings.json", reason: "top level is array, expected an object at /", lines: [1] }]);
  });

  it("skips a document whose parse already failed (discovery reported it)", () => {
    const { entries, incomplete } = extractEntries([settings("{ broken")]);
    assert.deepEqual(entries, []);
    assert.deepEqual(incomplete, []);
  });
});

describe("entries: credential-like literals are redacted everywhere (JG-150, JG-145)", () => {
  const settingsText = () => new TextDecoder().decode(readFixture("repos/credential/.claude/settings.json"));
  const mcpText = () => new TextDecoder().decode(readFixture("repos/credential/.mcp.json"));

  it("produces a credential:<pointer> entry per literal with the fixed value", () => {
    const { entries, incomplete } = extractEntries([settings(settingsText()), mcp(mcpText())]);
    assert.deepEqual(incomplete, []);
    const credentials = entries.filter((entry) => entry.kind === "credential");
    assert.deepEqual(keys(credentials), [
      "credential:/awsAccessKeyId",
      "credential:/env/EXAMPLE_API_KEY",
      "credential:/hooks/PostToolUse/0/hooks/0/command",
      "credential:/mcpServers/chat/headers/Authorization",
      "credential:/mcpServers/chat/url",
      "credential:/mcpServers/gh/args/3",
      "credential:/mcpServers/gh/env/GITHUB_TOKEN",
      "credential:/permissions/allow/0",
      "credential:/signingKey",
      "credential:/webhookSecret",
    ]);
    for (const entry of credentials) {
      assert.equal(entry.value, CREDENTIAL_PRESENT);
      assert.equal(typeof entry.line, "number");
    }
    assert.equal(byKey(entries, "credential:/webhookSecret").line, 18);
    assert.equal(byKey(entries, "credential:/mcpServers/gh/args/3").file, ".mcp.json");
  });

  it("never lets the literal reach any value or key", () => {
    const { entries } = extractEntries([settings(settingsText()), mcp(mcpText())]);
    const text = canonicalJson(entries);
    for (const literal of [
      "sk-synthetic",
      "synthetic0000token",
      "synthetic0000000000000000",
      "0123456789abcdef0123456789abcdef",
      "AKIA0000000000SYNTHE",
      "BEGIN PRIVATE KEY",
      "SYNTHETIC0000000000000000000000000000",
      "github_pat_",
      "xoxb-",
      "synthetic-literal-header-token",
    ]) {
      assert.ok(!text.includes(literal), `literal leaked: ${literal}`);
    }
    assert.equal(byKey(entries, "perm:allow:Bash(curl -H 'Authorization: Bearer <redacted>' *)").kind, "perm");
    assert.equal((byKey(entries, "unknown:/awsAccessKeyId").value as string), REDACTED);
    assert.equal((byKey(entries, "unknown:/signingKey").value as string), REDACTED);
    const hook = entries.find((entry) => entry.kind === "hook");
    assert.equal((hook?.value as JsonObject)["command"], `notify --token=${REDACTED}`);
    assert.equal(hook?.key, `hook:PostToolUse::${sha256Hex(`notify --token=${REDACTED}`)}`);
    const gh = byKey(entries, "mcp:gh").value as JsonObject;
    assert.deepEqual(gh["args"], ["-y", "example-github-server", "--token", REDACTED]);
    assert.deepEqual(gh["env_keys"], ["GITHUB_TOKEN"]);
    assert.equal((byKey(entries, "mcp:chat").value as JsonObject)["url"], `https://example.invalid/mcp?token=${REDACTED}`);
  });

  it("redactString: patterns, variable references and short values", () => {
    assert.deepEqual(redactString("Bearer ${TOKEN}"), { text: "Bearer ${TOKEN}", patterns: [] });
    assert.deepEqual(redactString("Bearer abcdefgh12345678"), { text: "Bearer <redacted>", patterns: ["bearer-token"] });
    assert.deepEqual(redactString("sk-short"), { text: "sk-short", patterns: [] });
    assert.deepEqual(redactString("abc", "apiKey"), { text: "abc", patterns: [] });
    assert.deepEqual(redactString("/usr/local/bin/print-key-helper-with-a-long-name-here", "apiKeyHelper"), {
      text: "/usr/local/bin/print-key-helper-with-a-long-name-here",
      patterns: [],
    });
    assert.deepEqual(redactString("0123456789abcdef0123456789abcdef", "unrelated"), {
      text: "0123456789abcdef0123456789abcdef",
      patterns: [],
    });
    assert.deepEqual(redactString("0123456789abcdef0123456789abcdef", "webhookSecret"), {
      text: REDACTED,
      patterns: ["opaque-value-under-sensitive-key"],
    });
    assert.deepEqual(redactString("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\ntrailer"), {
      text: "<redacted>\ntrailer",
      patterns: ["private-key-block"],
    });
  });

  it("redactTree records pointers, inherits the sensitive key into arrays and never mutates its input", () => {
    const input = parseJsonc('{"tokens": ["0123456789abcdef0123456789abcdef", "short"], "a/b": {"x": "ghp_SYNTHETIC0000000000000000000000000000"}}').value;
    assert.ok(input !== undefined);
    const before = canonicalJson(input);
    const { value, findings } = redactTree(input);
    assert.equal(canonicalJson(input), before, "input mutated");
    assert.deepEqual(findings, [
      { pointer: "/tokens/0", patterns: ["opaque-value-under-sensitive-key"] },
      { pointer: "/a~1b/x", patterns: ["github-token"] },
    ]);
    assert.deepEqual(plain(value), { tokens: [REDACTED, "short"], "a/b": { x: REDACTED } });
  });
});

describe("entries: ordering and semantic projection", () => {
  it("compareEntries orders by key, then file, then json_pointer", () => {
    const base: Entry = {
      kind: "perm",
      key: "perm:allow:Read",
      value: null,
      breadth: "unknown",
      direction: "unknown",
      tier: "unresolved",
      file: ".claude/settings.json",
      line: null,
      json_pointer: "/permissions/allow/0",
      source_sha: null,
    };
    const local = { ...base, file: ".claude/settings.local.json" };
    const later = { ...base, json_pointer: "/permissions/allow/3" };
    const other = { ...base, key: "perm:allow:Bash" };
    assert.deepEqual(sortEntries([later, local, base, other]), [other, base, later, local]);
    assert.equal(compareEntries(base, { ...base }), 0);
  });

  it("semanticEntry drops raw and the evidence fields so a reformat compares equal", () => {
    const a = extractEntries([settings('{"permissions": {"allow": ["Bash(npm run:*)"]}}')]).entries[0] as Entry;
    const b = extractEntries([settings('  {\n "permissions" : { "allow" : [ " Bash( npm run  * ) " , ] , } , }\n')]).entries[0] as Entry;
    assert.notEqual(canonicalJson(a), canonicalJson(b), "raw text and line differ");
    assert.equal(canonicalJson(semanticEntry(a)), canonicalJson(semanticEntry(b)));
    assert.deepEqual(plain(semanticEntry(a)), {
      kind: "perm",
      key: "perm:allow:Bash(npm run *)",
      file: ".claude/settings.json",
      value: { rule: "Bash(npm run *)", tool: "Bash", spec: "npm run *", wildcard: "trailing" },
    });
    assert.equal((a.value as JsonObject)["raw"], "Bash(npm run:*)", "the original is not mutated");
  });

  it("key order, indentation, comments and trailing commas have no effect on entries", () => {
    const compact = extractEntries([settings('{"permissions":{"deny":["WebFetch"],"allow":["Read"]},"disableAllHooks":true}')]).entries;
    const expanded = extractEntries([
      settings('// header\n{\n  "disableAllHooks": true, /* c */\n  "permissions": {\n    "allow": ["Read",],\n    "deny": ["WebFetch",],\n  },\n}\n'),
    ]).entries;
    assert.equal(canonicalJson(compact.map(semanticEntry)), canonicalJson(expanded.map(semanticEntry)));
    assert.deepEqual(keys(compact), keys(expanded));
  });
});
