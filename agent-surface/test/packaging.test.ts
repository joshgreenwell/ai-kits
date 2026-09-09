/**
 * npm publish preparation (JG-160): `npm pack` produces a tarball whose bin
 * runs from a fresh clone of a fixture repository with no install step.
 *
 * The tarball is invoked with `npx --yes <tarball> …`, which is how the
 * published package will be run (`npx agent-surface check …`); the npm
 * cache is pointed at a temp directory so a stale npx cache can never
 * mask a change.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { EXIT_EXPANDS, EXIT_OK } from "../src/cli.js";
import { VERSION } from "../src/version.js";
import { makePairRepo } from "./diff-helpers.js";
import { FIXTURES, git, removeDir, tempDir } from "./helpers.js";

const PACKAGE_DIR = fileURLToPath(new URL("../../", import.meta.url));

interface PackEntry {
  filename: string;
  files: Array<{ path: string }>;
}

describe("npm pack and npx smoke (JG-160)", () => {
  let work: string;
  let tarball: string;
  let files: string[];
  before(() => {
    work = tempDir();
    const result = spawnSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: PACKAGE_DIR, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const entries = JSON.parse(result.stdout) as PackEntry[];
    const entry = entries[0];
    assert.ok(entry !== undefined);
    tarball = path.join(work, entry.filename);
    files = entry.files.map((file) => file.path).sort();
  });
  after(() => removeDir(work));

  it("produces agent-surface-<version>.tgz with dist/, README, LICENSE, CHANGELOG and SECURITY only", () => {
    assert.equal(path.basename(tarball), `agent-surface-${VERSION}.tgz`);
    assert.ok(fs.existsSync(tarball));
    for (const required of ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", "dist/src/cli.js", "dist/src/index.js", "dist/src/render/text.js"]) {
      assert.ok(files.includes(required), `${required} is packed`);
    }
    for (const file of files) {
      assert.ok(!file.startsWith("dist/test/"), `${file} must not be packed`);
      assert.ok(!/^(src|test|fixtures|scripts|docs)\//.test(file), `${file} must not be packed`);
      assert.ok(!file.includes("node_modules"), file);
    }
  });

  it("npx --yes <tarball> agent-surface check --base HEAD~1 --head HEAD works in a fresh clone with no install step", () => {
    const origin = makePairRepo(path.join(FIXTURES, "golden", "add-allow-whole-tool"));
    const clone = path.join(work, "fresh-clone");
    git(work, "clone", "-q", origin.dir, clone);
    removeDir(origin.dir);
    const env = {
      npm_config_cache: path.join(work, "npm-cache"),
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_loglevel: "error",
    };
    // A bare absolute path is executed as a command by npx; the story's `./agent-surface-<version>.tgz` (relative) or `file:` form names a package.
    const spec = path.relative(clone, tarball);
    assert.match(spec, /^\.\.\/agent-surface-.*\.tgz$/);
    const npx = (...args: string[]): ReturnType<typeof spawnSync> =>
      spawnSync("npx", ["--yes", spec, ...args], { cwd: clone, encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000 });
    const check = npx("check", "--base", "HEAD~1", "--head", "HEAD");
    assert.equal(check.status, EXIT_EXPANDS, `stdout: ${String(check.stdout)}\nstderr: ${String(check.stderr)}`);
    const stdout = String(check.stdout);
    assert.match(stdout, /^CONTROL-SURFACE DIFF {2}base=[0-9a-f]{40} head=[0-9a-f]{40}\nAssumptions\n/);
    assert.match(stdout, /\nEXPANDED\n {2}permissions\n {4}added {3}perm {8}perm:allow:Bash {2}widens proven whole_tool/);
    assert.match(stdout, /\nverdict: expands \(exit 1\)/);
    const version = npx("--version");
    assert.equal(version.status, EXIT_OK, String(version.stderr));
    assert.equal(String(version.stdout).trim(), VERSION);
    // The `-p <pkg> agent-surface …` spelling names the bin explicitly, as `npx agent-surface check …` will after publish.
    const named = spawnSync("npx", ["--yes", "-p", spec, "agent-surface", "check", "--base", "HEAD~1", "--head", "HEAD", "--json"], {
      cwd: clone,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    assert.equal(named.status, EXIT_EXPANDS, String(named.stderr));
    const parsed = JSON.parse(String(named.stdout)) as { command: string; summary: { exit_code: number } };
    assert.equal(parsed.command, "check");
    assert.equal(parsed.summary.exit_code, 1);
    assert.equal(fs.existsSync(path.join(clone, "node_modules")), false, "no install step in the clone");
  });
});
