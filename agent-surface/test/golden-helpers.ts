/**
 * Golden fixture suite helpers (JG-158, plan §3.10).
 *
 * Layout: `fixtures/golden/<case>/{base,head}/` plus, per variant,
 * `expected.json` (the exact `check --json` output), `expected.txt` (the
 * exact text output) and `expected.exit` (the exit code). A `case.json`
 * may list extra variants: `{"variants": [{"name": "<n>", "args": [...]}]}`;
 * a variant's files are `expected.<n>.json`, `expected.<n>.txt` and
 * `expected.<n>.exit`.
 *
 * Placeholder rule: the harness builds a temporary git repository (commit
 * `base/`, then `head/`), runs `check --base <baseSha> --head <headSha>`,
 * and replaces every occurrence of the base commit SHA with `<base-sha>`
 * and of the head commit SHA with `<head-sha>` before comparing. Those
 * are the only volatile bytes: they appear as `base.sha`, `head.sha`,
 * `origin.sha`, `origin.spec`, `sources[].sha` and the deltas' entries'
 * `source_sha`. Blob ids are content-addressed and therefore stable.
 *
 * `scripts/update-golden.mjs` regenerates the expected files with the same
 * functions; the tests only ever compare.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { run } from "../src/cli.js";
import { makePairRepo, type DiffRepo } from "./diff-helpers.js";
import { FIXTURES, removeDir, runCli } from "./helpers.js";

export const GOLDEN_FIXTURES = path.join(FIXTURES, "golden");
export const BASE_SHA_PLACEHOLDER = "<base-sha>";
export const HEAD_SHA_PLACEHOLDER = "<head-sha>";

export interface GoldenVariant {
  name: string;
  args: string[];
  jsonFile: string;
  textFile: string;
  exitFile: string;
}

export interface GoldenCase {
  name: string;
  dir: string;
  variants: GoldenVariant[];
}

interface CaseJson {
  variants?: Array<{ name: string; args: string[] }>;
}

function variantsOf(dir: string): GoldenVariant[] {
  const variants: GoldenVariant[] = [{ name: "default", args: [], jsonFile: "expected.json", textFile: "expected.txt", exitFile: "expected.exit" }];
  const caseFile = path.join(dir, "case.json");
  if (fs.existsSync(caseFile)) {
    const parsed = JSON.parse(fs.readFileSync(caseFile, "utf8")) as CaseJson;
    for (const variant of parsed.variants ?? []) {
      variants.push({
        name: variant.name,
        args: variant.args,
        jsonFile: `expected.${variant.name}.json`,
        textFile: `expected.${variant.name}.txt`,
        exitFile: `expected.${variant.name}.exit`,
      });
    }
  }
  return variants;
}

/** Every case under `fixtures/golden`, sorted by name. */
export function goldenCases(): GoldenCase[] {
  return fs
    .readdirSync(GOLDEN_FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const dir = path.join(GOLDEN_FIXTURES, name);
      return { name, dir, variants: variantsOf(dir) };
    });
}

/** Replace the volatile commit SHAs with the documented placeholders. */
export function stabilize(text: string, repo: DiffRepo): string {
  return text.split(repo.baseSha).join(BASE_SHA_PLACEHOLDER).split(repo.headSha).join(HEAD_SHA_PLACEHOLDER);
}

export interface GoldenRun {
  json: string;
  text: string;
  exit: number;
  stderr: string;
}

function checkArgs(repo: DiffRepo, variant: GoldenVariant, json: boolean): string[] {
  return ["check", "--base", repo.baseSha, "--head", repo.headSha, ...(json ? ["--json"] : []), ...variant.args];
}

/** Run one variant through the compiled CLI as a child process. */
export function runGoldenCli(repo: DiffRepo, variant: GoldenVariant): GoldenRun {
  const json = runCli(checkArgs(repo, variant, true), repo.dir);
  const text = runCli(checkArgs(repo, variant, false), repo.dir);
  if (json.status !== text.status) {
    throw new Error(`exit codes differ between --json (${json.status}) and text (${text.status})`);
  }
  return { json: stabilize(json.stdout, repo), text: stabilize(text.stdout, repo), exit: json.status ?? -1, stderr: json.stderr };
}

/** Run one variant in-process through the exported `run(argv)` (no child process). */
export function runGoldenInProcess(repo: DiffRepo, variant: GoldenVariant): GoldenRun {
  const capture = (): { io: { stdout(text: string): void; stderr(text: string): void }; out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, out, err };
  };
  const json = capture();
  const jsonExit = run(checkArgs(repo, variant, true), json.io, { cwd: repo.dir });
  const text = capture();
  const textExit = run(checkArgs(repo, variant, false), text.io, { cwd: repo.dir });
  if (jsonExit !== textExit) {
    throw new Error(`exit codes differ between --json (${jsonExit}) and text (${textExit})`);
  }
  return { json: stabilize(json.out.join(""), repo), text: stabilize(text.out.join(""), repo), exit: jsonExit, stderr: json.err.join("") };
}

/** Read the expected files of a variant. */
export function expectedOf(goldenCase: GoldenCase, variant: GoldenVariant): { json: string; text: string; exit: number } {
  const read = (name: string): string => fs.readFileSync(path.join(goldenCase.dir, name), "utf8");
  return { json: read(variant.jsonFile), text: read(variant.textFile), exit: Number.parseInt(read(variant.exitFile).trim(), 10) };
}

/** Cache of repositories per golden case so a suite builds each case once. */
export class GoldenRepos {
  private readonly repos = new Map<string, DiffRepo>();

  repo(goldenCase: GoldenCase): DiffRepo {
    let repo = this.repos.get(goldenCase.name);
    if (repo === undefined) {
      repo = makePairRepo(goldenCase.dir);
      this.repos.set(goldenCase.name, repo);
    }
    return repo;
  }

  cleanup(): void {
    for (const repo of this.repos.values()) {
      removeDir(repo.dir);
    }
    this.repos.clear();
  }
}
