/**
 * §3.9 security requirements enforced in the suite (JG-159).
 *
 * Every test here runs the tool in-process through the exported `run()`
 * so that monkeypatched `node:child_process` / network modules are the
 * ones the tool actually calls. Temp repositories are built *before* a
 * guard is installed (the fixture helper legitimately runs `git init` and
 * `git commit`, which the tool itself never does).
 */

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as net from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * ESM namespace objects are frozen, so the guards mutate the underlying
 * CommonJS module objects (obtained through `createRequire`) and then call
 * `syncBuiltinESMExports()` so every `import { spawnSync } from
 * "node:child_process"` binding in the package (git.ts) sees the patch.
 */
const requireCjs = createRequire(import.meta.url);

import { EXIT_EXPANDS, EXIT_INCOMPLETE, EXIT_OK, run, type CliDeps } from "../src/cli.js";
import { GIT_SUBCOMMANDS, defaultFs, type FsAdapter } from "../src/git.js";
import { CREDENTIAL_PRESENT } from "../src/redact.js";
import { makePairRepo, type DiffRepo } from "./diff-helpers.js";
import { GoldenRepos, expectedOf, goldenCases, runGoldenInProcess } from "./golden-helpers.js";
import { FIXTURES, makeRepo, removeDir, runCli, tempDir } from "./helpers.js";

const SECURITY_FIXTURES = path.join(FIXTURES, "security");
const CANARY = "/tmp/agent-surface-canary-a3f9c2e7";

interface Captured {
  status: number;
  stdout: string;
  stderr: string;
}

function inProcess(args: string[], cwd: string, deps: Partial<CliDeps> = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const status = run(args, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, { cwd, ...deps });
  return { status, stdout: out.join(""), stderr: err.join("") };
}

// ---- guards ----------------------------------------------------------------

type Mutable = Record<string, unknown>;

interface Guard {
  violations: string[];
  allowed: string[];
  restore(): void;
}

const ALLOWED_GIT = new Set(GIT_SUBCOMMANDS);

function describeCall(name: string, args: unknown[]): string {
  return `${name}(${args.map((arg) => (typeof arg === "string" ? JSON.stringify(arg) : Array.isArray(arg) ? JSON.stringify(arg) : typeof arg)).join(", ")})`;
}

/** Block every child_process entry point except `git show|rev-parse|ls-files` as an argument array without a shell. */
function installExecGuard(): Guard {
  const cp = requireCjs("node:child_process") as Mutable;
  const names = ["spawnSync", "spawn", "exec", "execFile", "execSync", "execFileSync", "fork"] as const;
  const originals = Object.fromEntries(names.map((name) => [name, cp[name]])) as Record<(typeof names)[number], unknown>;
  const guard: Guard = {
    violations: [],
    allowed: [],
    restore() {
      Object.assign(cp, originals);
      syncBuiltinESMExports();
    },
  };
  const realSpawnSync = originals.spawnSync as typeof childProcess.spawnSync;
  cp["spawnSync"] = (command: unknown, args: unknown, options: unknown): unknown => {
    const list = Array.isArray(args) ? args : null;
    const first = list?.[0];
    const shell = typeof options === "object" && options !== null ? (options as { shell?: unknown }).shell : undefined;
    if (command === "git" && list !== null && typeof first === "string" && ALLOWED_GIT.has(first) && (shell === false || shell === undefined)) {
      guard.allowed.push(describeCall("spawnSync", [command, list]));
      return realSpawnSync(command, list as string[], options as Parameters<typeof childProcess.spawnSync>[2]);
    }
    guard.violations.push(describeCall("spawnSync", [command, args]));
    throw new Error(`blocked by test guard: ${describeCall("spawnSync", [command, args])}`);
  };
  for (const name of names) {
    if (name === "spawnSync") {
      continue;
    }
    cp[name] = (...args: unknown[]): never => {
      guard.violations.push(describeCall(name, args));
      throw new Error(`blocked by test guard: child_process.${name}`);
    };
  }
  syncBuiltinESMExports();
  return guard;
}

/** Make every network entry point throw. */
function installNetworkGuard(): Guard {
  const netCjs = requireCjs("node:net") as Mutable;
  const httpCjs = requireCjs("node:http") as Mutable;
  const httpsCjs = requireCjs("node:https") as Mutable;
  const dnsCjs = requireCjs("node:dns") as Mutable & { promises: Mutable };
  const targets: Array<[Mutable, string]> = [
    [netCjs, "connect"],
    [netCjs, "createConnection"],
    [httpCjs, "request"],
    [httpCjs, "get"],
    [httpsCjs, "request"],
    [httpsCjs, "get"],
    [dnsCjs, "lookup"],
    [dnsCjs, "resolve"],
    [dnsCjs.promises, "lookup"],
    [globalThis as unknown as Mutable, "fetch"],
  ];
  const originals = targets.map(([target, name]) => [target, name, target[name]] as const);
  const guard: Guard = {
    violations: [],
    allowed: [],
    restore() {
      for (const [target, name, original] of originals) {
        target[name] = original;
      }
      syncBuiltinESMExports();
    },
  };
  for (const [target, name] of targets) {
    target[name] = (...args: unknown[]): never => {
      guard.violations.push(describeCall(name, args));
      throw new Error(`blocked by test guard: network ${name}`);
    };
  }
  syncBuiltinESMExports();
  return guard;
}

// ---- suites ----------------------------------------------------------------

describe("no-exec: child_process monkeypatched (JG-159)", () => {
  const golden = new GoldenRepos();
  let rich: { dir: string; sha: string };
  before(() => {
    for (const item of goldenCases()) {
      golden.repo(item);
    }
    rich = makeRepo("rich");
  });
  after(() => {
    golden.cleanup();
    removeDir(rich.dir);
  });

  it("the guard intercepts the tool's own git calls and blocks everything else", () => {
    const guard = installExecGuard();
    try {
      assert.throws(() => childProcess.spawnSync("echo", ["hi"]), /blocked by test guard/);
      assert.throws(() => childProcess.execSync("echo hi"), /blocked by test guard/);
      assert.throws(() => childProcess.spawnSync("git", ["status"]), /blocked by test guard/);
      assert.throws(() => childProcess.spawnSync("git", ["show", "HEAD"], { shell: true }), /blocked by test guard/);
      assert.equal(guard.violations.length, 4);
      const item = goldenCases()[0];
      assert.ok(item !== undefined);
      const before = guard.allowed.length;
      const result = runGoldenInProcess(golden.repo(item), item.variants[0] as NonNullable<(typeof item.variants)[0]>);
      assert.equal(result.exit, expectedOf(item, item.variants[0] as NonNullable<(typeof item.variants)[0]>).exit);
      assert.ok(guard.allowed.length > before, "the patched spawnSync is the one git.ts calls");
      assert.ok(guard.allowed.every((call) => /^spawnSync\("git", \["(show|rev-parse|ls-files)"/.test(call)), guard.allowed.join("\n"));
    } finally {
      guard.restore();
    }
    assert.equal(childProcess.spawnSync("git", ["--version"]).status, 0, "restored");
  });

  it("the full golden suite passes under the guard with zero violations, through the exported run(argv)", () => {
    const guard = installExecGuard();
    try {
      for (const item of goldenCases()) {
        const repo = golden.repo(item);
        for (const variant of item.variants) {
          const expected = expectedOf(item, variant);
          const result = runGoldenInProcess(repo, variant);
          assert.equal(result.exit, expected.exit, `${item.name} [${variant.name}]`);
          assert.equal(result.json, expected.json, `${item.name} [${variant.name}] json`);
          assert.equal(result.text, expected.text, `${item.name} [${variant.name}] text`);
        }
      }
      assert.equal(inProcess(["snapshot", "HEAD", "--json"], rich.dir).status, EXIT_OK);
      assert.equal(inProcess(["snapshot", ".", "--json"], rich.dir).status, EXIT_OK);
      assert.equal(inProcess(["check", "--base", "HEAD", "--head", "."], rich.dir).status, EXIT_OK);
      assert.equal(inProcess(["explain", "I6"], rich.dir).status, EXIT_OK);
    } finally {
      guard.restore();
    }
    assert.deepEqual(guard.violations, []);
    assert.ok(guard.allowed.length > 100);
    const subcommands = new Set(guard.allowed.map((call) => /\["([a-z-]+)"/.exec(call)?.[1]));
    assert.deepEqual([...subcommands].sort(), ["ls-files", "rev-parse", "show"]);
  });
});

describe("no-network: net, http, https, dns and fetch monkeypatched (JG-159)", () => {
  const golden = new GoldenRepos();
  before(() => {
    for (const item of goldenCases()) {
      golden.repo(item);
    }
  });
  after(() => golden.cleanup());

  it("the guard throws on every entry point", () => {
    const guard = installNetworkGuard();
    try {
      assert.throws(() => http.request("http://127.0.0.1:9/"), /blocked by test guard/);
      assert.throws(() => https.get("https://127.0.0.1:9/"), /blocked by test guard/);
      assert.throws(() => net.connect(9, "127.0.0.1"), /blocked by test guard/);
      assert.throws(() => dns.lookup("localhost", () => undefined), /blocked by test guard/);
      assert.throws(() => (globalThis.fetch as (input: string) => unknown)("http://127.0.0.1:9/"), /blocked by test guard/);
      assert.equal(guard.violations.length, 5);
    } finally {
      guard.restore();
    }
  });

  it("the full golden suite passes under the guard with zero violations", () => {
    const exec = installExecGuard();
    const network = installNetworkGuard();
    try {
      for (const item of goldenCases()) {
        const repo = golden.repo(item);
        for (const variant of item.variants) {
          const expected = expectedOf(item, variant);
          const result = runGoldenInProcess(repo, variant);
          assert.equal(result.exit, expected.exit, `${item.name} [${variant.name}]`);
          assert.equal(result.json, expected.json, `${item.name} [${variant.name}]`);
        }
      }
    } finally {
      network.restore();
      exec.restore();
    }
    assert.deepEqual(network.violations, []);
    assert.deepEqual(exec.violations, []);
  });
});

describe("environment variables are never expanded; hook commands never run (JG-159)", () => {
  let repo: DiffRepo;
  before(() => {
    fs.rmSync(CANARY, { force: true });
    repo = makePairRepo(path.join(SECURITY_FIXTURES, "canary-env"));
  });
  after(() => removeDir(repo.dir));

  it("${HOME} and $SECRET in hook commands, MCP command/args/url and env are rendered literally in text and JSON", () => {
    const secret = "expanded-secret-value-9c1d5e";
    const home = "/tmp/agent-surface-fake-home-9c1d5e";
    const env = { HOME: home, SECRET: secret, MCP_HOST: "expanded-host.invalid" };
    const saved = { HOME: process.env["HOME"], SECRET: process.env["SECRET"], MCP_HOST: process.env["MCP_HOST"] };
    Object.assign(process.env, env);
    try {
      const outputs = [
        runCli(["check", "--base", repo.baseSha, "--head", repo.headSha], repo.dir, env).stdout,
        runCli(["check", "--base", repo.baseSha, "--head", repo.headSha, "--json"], repo.dir, env).stdout,
        runCli(["snapshot", repo.headSha], repo.dir, env).stdout,
        runCli(["snapshot", repo.headSha, "--json"], repo.dir, env).stdout,
        inProcess(["check", "--base", repo.baseSha, "--head", repo.headSha], repo.dir).stdout,
        inProcess(["check", "--base", repo.baseSha, "--head", repo.headSha, "--json"], repo.dir).stdout,
      ];
      for (const output of outputs) {
        assert.ok(!output.includes(secret), "SECRET was expanded");
        assert.ok(!output.includes(home), "HOME was expanded");
        assert.ok(!output.includes("expanded-host.invalid"), "MCP_HOST was expanded");
      }
      for (const json of [outputs[1], outputs[3], outputs[5]]) {
        assert.ok(json?.includes("${HOME}"), "literal ${HOME} present in JSON");
        assert.ok(json?.includes("$SECRET"), "literal $SECRET present in JSON");
        assert.ok(json?.includes("http://${MCP_HOST}/mcp?home=${HOME}"), "literal URL present in JSON");
      }
      // MCP env: key names only, never values (the literal "$SECRET" that does appear is the args element and the hook command).
      interface McpValue {
        args: string[];
        command: string;
        env_keys: string[];
        env?: unknown;
      }
      type McpDelta = { key: string; head: { value: McpValue } | null };
      const checkJson = JSON.parse(outputs[1] ?? "") as { added: McpDelta[]; unresolved: McpDelta[] };
      // The ${HOME} command makes the server a variable reference (I7), so it is listed under unresolved.
      const homeServer = [...checkJson.added, ...checkJson.unresolved].find((delta) => delta.key === "mcp:home");
      assert.ok(checkJson.unresolved.some((delta) => delta.key === "mcp:home"), "mcp:home is unresolved (variable reference), never expanded");
      assert.ok(homeServer?.head !== null && homeServer?.head !== undefined, "mcp:home delta");
      assert.deepEqual(homeServer.head.value.env_keys, ["EXAMPLE_HOME_REF", "EXAMPLE_TOKEN_REF"]);
      assert.equal("env" in homeServer.head.value, false, "no env values carried");
      assert.deepEqual(homeServer.head.value.args, ["--secret", "$SECRET", "--touch", "/tmp/agent-surface-canary-a3f9c2e7"]);
      assert.equal(homeServer.head.value.command, "${HOME}/bin/example-server");
      const snapshotJson = JSON.parse(outputs[3] ?? "") as { entries: Array<{ key: string; value: McpValue | string }> };
      const snapshotHome = snapshotJson.entries.find((entry) => entry.key === "mcp:home");
      assert.ok(snapshotHome !== undefined && typeof snapshotHome.value === "object");
      assert.deepEqual(snapshotHome.value.env_keys, ["EXAMPLE_HOME_REF", "EXAMPLE_TOKEN_REF"]);
      assert.equal(snapshotJson.entries.find((entry) => entry.key === "env_key:EXAMPLE_SECRET")?.value, "<redacted>");
      const check = runCli(["check", "--base", repo.baseSha, "--head", repo.headSha], repo.dir, env);
      assert.equal(check.status, EXIT_EXPANDS);
      assert.match(check.stdout, /hook:PreToolUse:Bash:[0-9a-f]{64}/);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it("canary: the hook command `touch /tmp/agent-surface-canary-…` never creates the file", () => {
    for (const args of [
      ["check", "--base", repo.baseSha, "--head", repo.headSha],
      ["diff", "--base", repo.baseSha, "--head", repo.headSha, "--json"],
      ["snapshot", repo.headSha],
    ]) {
      runCli(args, repo.dir);
      inProcess(args, repo.dir);
    }
    const goldenHook = fs.readFileSync(path.join(FIXTURES, "golden", "add-hook", "head", ".claude", "settings.json"), "utf8");
    assert.ok(goldenHook.includes(`touch ${CANARY}`), "the golden add-hook case carries the canary");
    const item = goldenCases().find((candidate) => candidate.name === "add-hook");
    assert.ok(item !== undefined);
    const golden = makePairRepo(item.dir);
    try {
      runGoldenInProcess(golden, item.variants[0] as NonNullable<(typeof item.variants)[0]>);
    } finally {
      removeDir(golden.dir);
    }
    assert.equal(fs.existsSync(CANARY), false, `${CANARY} must never appear`);
  });
});

describe("redaction in every renderer (JG-159)", () => {
  let repo: DiffRepo;
  before(() => {
    repo = makePairRepo(path.join(SECURITY_FIXTURES, "credentials"));
  });
  after(() => removeDir(repo.dir));

  const LITERALS = [
    "sk-SYNTHETIC",
    "AKIASYNTHETIC",
    "ghp_SYNTHETIC",
    "SYNTHETIC-bearer-token",
    "SYNTHETIC-header-token",
    "BEGIN PRIVATE KEY",
    "END PRIVATE KEY",
    "xoxb-",
  ];

  it("sk-, AKIA, ghp_, Bearer and private-key literals are absent from text and JSON; the finding says credential-like value present", () => {
    const outputs = [
      runCli(["check", "--base", repo.baseSha, "--head", repo.headSha], repo.dir),
      runCli(["check", "--base", repo.baseSha, "--head", repo.headSha, "--json"], repo.dir),
      runCli(["diff", "--base", repo.baseSha, "--head", repo.headSha], repo.dir),
      runCli(["snapshot", repo.headSha], repo.dir),
      runCli(["snapshot", repo.headSha, "--json"], repo.dir),
      inProcess(["check", "--base", repo.baseSha, "--head", repo.headSha], repo.dir),
      inProcess(["check", "--base", repo.baseSha, "--head", repo.headSha, "--json"], repo.dir),
    ];
    for (const output of outputs) {
      const text = output.stdout + output.stderr;
      for (const literal of LITERALS) {
        assert.ok(!text.includes(literal), `literal ${literal} leaked`);
      }
      assert.ok(text.includes(CREDENTIAL_PRESENT), "finding reported");
      assert.ok(text.includes("<redacted>"), "value redacted");
    }
    const json = JSON.parse(outputs[1]?.stdout ?? "") as { unresolved: Array<{ kind: string; key: string }> };
    const credentialKeys = json.unresolved.filter((delta) => delta.kind === "credential").map((delta) => delta.key).sort();
    assert.ok(credentialKeys.includes("credential:/env/EXAMPLE_API_KEY"), credentialKeys.join(", "));
    assert.ok(credentialKeys.includes("credential:/env/EXAMPLE_AWS_KEY"));
    assert.ok(credentialKeys.includes("credential:/hooks/PostToolUse/0/hooks/0/command"));
    assert.ok(credentialKeys.includes("credential:/privateKeyMaterial"));
    assert.ok(credentialKeys.includes("credential:/mcpServers/chat/headers/Authorization"));
    assert.ok(credentialKeys.includes("credential:/mcpServers/gh/args/3"));
    assert.ok(credentialKeys.some((key) => key.startsWith("credential:/permissions/allow/")), "bearer literal inside an allow rule");
    assert.ok(credentialKeys.length >= 9, `${credentialKeys.length} credential findings`);
  });
});

describe("unreadable inputs are incomplete, never a stack trace (JG-159)", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) {
      removeDir(dir);
    }
  });

  function assertNoStackTrace(result: Captured): void {
    assert.ok(!/\n\s+at /.test(result.stderr) && !/\n\s+at /.test(result.stdout), "no stack trace");
    assert.ok(!/Error:/.test(result.stderr), "no raw error object");
  }

  it("permission-denied read (injected EACCES) → incomplete with reason, exit 3", () => {
    const repo = makeRepo("basic");
    dirs.push(repo.dir);
    const denied: FsAdapter = {
      ...defaultFs,
      readFileSync: (target) => {
        if (target.endsWith(path.join(".claude", "settings.json"))) {
          const err = new Error("EACCES: permission denied") as Error & { code: string };
          err.code = "EACCES";
          throw err;
        }
        return defaultFs.readFileSync(target);
      },
    };
    for (const args of [
      ["check", "--base", "HEAD", "--head", "."],
      ["snapshot", "."],
      ["diff", "--base", "HEAD", "--head", ".", "--json"],
    ]) {
      const result = inProcess(args, repo.dir, { fs: denied });
      assert.equal(result.status, EXIT_INCOMPLETE, args.join(" "));
      assert.match(result.stderr, /^incomplete: \.claude\/settings\.json: read failed: permission denied \(EACCES\)\n/);
      assertNoStackTrace(result);
      if (args.includes("--json")) {
        const parsed = JSON.parse(result.stdout) as { incomplete: Array<{ path: string; reason: string }> };
        assert.equal(parsed.incomplete[0]?.reason, "read failed: permission denied (EACCES)");
      } else {
        assert.match(result.stdout, /\nINCOMPLETE\n {2}\.claude\/settings\.json: read failed: permission denied \(EACCES\)\n/);
        assert.ok(!/no changes/.test(result.stdout));
      }
    }
  });

  it("permission-denied read on the real filesystem → incomplete with reason, exit 3 (mechanism depends on uid)", (t) => {
    const repo = makeRepo("basic");
    dirs.push(repo.dir);
    const target = path.join(repo.dir, ".claude", "settings.json");
    let reason: RegExp;
    if (process.getuid?.() === 0) {
      t.diagnostic("running as root: chmod 000 does not deny reads, using a directory in place of the file instead");
      fs.rmSync(target);
      fs.mkdirSync(target);
      reason = /^incomplete: \.claude\/settings\.json: not a regular file\n/;
    } else {
      fs.chmodSync(target, 0o000);
      reason = /^incomplete: \.claude\/settings\.json: read failed: permission denied \(EACCES\)\n/;
    }
    try {
      const cli = runCli(["check", "--base", "HEAD", "--head", "."], repo.dir);
      assert.equal(cli.status, EXIT_INCOMPLETE);
      assert.match(cli.stderr, reason);
      assertNoStackTrace(cli as Captured);
      assert.ok(cli.stdout.includes("\nINCOMPLETE\n"));
    } finally {
      if (process.getuid?.() !== 0) {
        fs.chmodSync(target, 0o644);
      }
    }
  });

  it("negative case: a symlink inside .claude/ pointing outside the repository is refused → incomplete with reason", () => {
    const repo = makeRepo("basic");
    dirs.push(repo.dir);
    const outside = tempDir();
    dirs.push(outside);
    const secret = path.join(outside, "settings.json");
    fs.writeFileSync(secret, '{"permissions":{"allow":["Bash(outside-marker-7f3e *)"]}}');
    const target = path.join(repo.dir, ".claude", "settings.json");
    fs.rmSync(target);
    fs.symlinkSync(secret, target);
    for (const args of [
      ["check", "--base", "HEAD", "--head", "."],
      ["snapshot", "."],
    ]) {
      const cli = runCli(args, repo.dir);
      assert.equal(cli.status, EXIT_INCOMPLETE, args.join(" "));
      assert.match(cli.stderr, /^incomplete: \.claude\/settings\.json: symlink resolves outside the repository root \(\.claude\/settings\.json -> /);
      assertNoStackTrace(cli as Captured);
      assert.ok(!cli.stdout.includes("outside-marker-7f3e"), "the link target was never read");
      const inproc = inProcess(args, repo.dir);
      assert.equal(inproc.status, EXIT_INCOMPLETE);
      assert.match(inproc.stderr, /symlink resolves outside the repository root/);
    }
  });
});
