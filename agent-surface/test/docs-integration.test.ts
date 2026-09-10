/**
 * `docs/integration.md` is kept honest by this test.
 *
 * The guide shows command lines and exit codes. Both are checked against the
 * real CLI surface rather than against prose:
 *
 *  - every CLI invocation the guide shows is parsed the way the CLI parses it
 *    (subcommand, flags, `--fail-on` names, `explain` IDs) and must match
 *    `SUBCOMMANDS`, the flags listed in `USAGE`, `FAIL_ON_NAMES` and
 *    `explainIds()`;
 *  - the one deliberately-broken invocation the guide documents must really be
 *    rejected by `run()` with exit 64;
 *  - the exit-code table must state exactly the codes `verdict.ts` defines
 *    (plus the CLI's 64), and each must appear in the CLI's own usage text.
 *
 * Extraction is anchored on stable markers so it cannot drift silently:
 * `<!-- verify:cli -->` before a block whose invocations must be valid,
 * `<!-- verify:cli-invalid -->` before the block whose invocation must fail,
 * and `<!-- verify:exit-codes:start -->` / `<!-- verify:exit-codes:end -->`
 * around the exit-code table. A missing marker fails with a message naming it,
 * and any invocation line found in an unmarked block fails too, so adding a
 * command to the guide without a marker cannot slip past this file.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { EXIT_ANNOTATE, EXIT_EXPANDS, EXIT_INCOMPLETE, EXIT_OK, EXIT_USAGE, SUBCOMMANDS, USAGE, run } from "../src/cli.js";
import { explainIds } from "../src/explain.js";
import { FAIL_ON_NAMES } from "../src/verdict.js";

const DOC_PATH = fileURLToPath(new URL("../../docs/integration.md", import.meta.url));
const DOC = fs.readFileSync(DOC_PATH, "utf8");

const MARKER_CLI = "<!-- verify:cli -->";
const MARKER_CLI_INVALID = "<!-- verify:cli-invalid -->";
const MARKER_EXIT_START = "<!-- verify:exit-codes:start -->";
const MARKER_EXIT_END = "<!-- verify:exit-codes:end -->";

/** Subcommand names the CLI dispatches on. */
const SUBCOMMAND_NAMES = SUBCOMMANDS.map((cmd) => cmd.name);

/** Every `--flag` the CLI's own usage text mentions. */
const KNOWN_FLAGS = new Set(Array.from(USAGE.matchAll(/--([a-z][a-z0-9-]*)/g), (match) => match[1] as string));

/** Flags that consume the next argument, per the usage text (`--base <ref>`, `--fail-on <c,…>`, …). */
const VALUE_FLAGS = new Set(Array.from(USAGE.matchAll(/--([a-z][a-z0-9-]*) </g), (match) => match[1] as string));

/** Exit codes the package defines, plus the CLI's usage code. */
const KNOWN_EXIT_CODES = [EXIT_OK, EXIT_EXPANDS, EXIT_ANNOTATE, EXIT_INCOMPLETE, EXIT_USAGE];

interface FencedBlock {
  info: string;
  lines: string[];
  marker: string | null;
  startLine: number;
}

/** Every fenced block in the document, with the marker comment (if any) that precedes it. */
function fencedBlocks(text: string): FencedBlock[] {
  const lines = text.split("\n");
  const blocks: FencedBlock[] = [];
  let lastComment: string | null = null;
  let open: FencedBlock | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    // CommonMark: a fence may be indented at most three spaces, so the deeply
    // indented ``` inside the CI job's heredoc-free summary step is content.
    const fence = /^ {0,3}```(.*)$/.exec(line);
    if (open === null && fence !== null) {
      open = { info: (fence[1] ?? "").trim(), lines: [], marker: lastComment, startLine: index + 1 };
      continue;
    }
    if (open !== null) {
      if (fence !== null) {
        blocks.push(open);
        open = null;
        lastComment = null;
        continue;
      }
      open.lines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("<!--")) {
      lastComment = trimmed;
    } else if (trimmed !== "") {
      lastComment = null;
    }
  }
  assert.equal(open, null, `${DOC_PATH}: unterminated fenced code block`);
  return blocks;
}

/** Join `\`-continued lines inside one block. */
function joinContinuations(lines: readonly string[]): string[] {
  const joined: string[] = [];
  let pending: string | null = null;
  for (const line of lines) {
    const current: string = pending === null ? line.trim() : `${pending} ${line.trim()}`;
    if (current.endsWith("\\")) {
      pending = current.slice(0, -1).trim();
      continue;
    }
    pending = null;
    joined.push(current);
  }
  if (pending !== null) {
    joined.push(pending);
  }
  return joined;
}

const ENTRY_LEADERS = new Set(["node", "npx", "agent-surface"]);

/**
 * Split a shell line into tokens, dropping redirects, pipes and `${{ … }}`
 * expressions. Quotes are kept, so a quoted word in pasted output (such as
 * `'agent-surface snapshot --json'` inside an error message) is never mistaken
 * for a command.
 */
function tokenize(line: string): string[] {
  const withoutExpressions = line.replace(/\$\{\{[^}]*\}\}/g, "EXPR");
  const head = withoutExpressions.split(/\s(?:\||>>?|&&|;)\s/)[0] ?? "";
  return head.split(/\s+/).filter((token) => token !== "");
}

const unquote = (token: string): string => token.replace(/^["']|["']$/g, "");

interface Invocation {
  line: string;
  subcommand: string | null;
  flags: Array<{ name: string; value: string | null }>;
  positionals: string[];
}

/**
 * Parse a documented CLI invocation the way the CLI itself would, after
 * stripping the launcher (`node <path>/cli.js`, `npx [--yes] [-p] <spec>`).
 * Returns `null` when the line does not invoke the CLI at all.
 */
function parseInvocation(line: string): Invocation | null {
  let tokens = tokenize(line);
  if (tokens[0] === "exec") {
    tokens = tokens.slice(1);
  }
  const leader = tokens[0];
  if (leader === undefined || !ENTRY_LEADERS.has(leader)) {
    return null;
  }
  let rest = tokens.slice(1);
  if (leader === "node") {
    const entry = rest[0];
    if (entry === undefined || !entry.includes("cli.js")) {
      return null;
    }
    rest = rest.slice(1);
  } else if (leader === "npx") {
    let named = false;
    while (rest.length > 0 && (rest[0] as string).startsWith("-")) {
      const flag = rest[0] as string;
      rest = rest.slice(1);
      if (flag === "-p" || flag === "--package") {
        named = true;
        rest = rest.slice(1);
      }
    }
    if (named) {
      const bin = rest[0];
      assert.equal(bin, "agent-surface", `${line}: 'npx -p <spec> <bin>' must name the agent-surface binary`);
      rest = rest.slice(1);
    } else {
      const spec = rest[0];
      assert.ok(
        spec !== undefined && (spec === "agent-surface" || spec.endsWith(".tgz") || spec.startsWith("agent-surface@")),
        `${line}: the token after npx must be the agent-surface package spec, got ${String(spec)}`,
      );
      rest = rest.slice(1);
    }
  }

  const flags: Array<{ name: string; value: string | null }> = [];
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (token === "--") {
      positionals.push(...rest.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
      let value = equals === -1 ? null : token.slice(equals + 1);
      if (value === null && VALUE_FLAGS.has(name)) {
        value = rest[index + 1] ?? null;
        index += 1;
      }
      flags.push({ name, value });
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      flags.push({ name: token.slice(1), value: null });
      continue;
    }
    positionals.push(token);
  }
  return { line, subcommand: positionals[0] ?? null, flags, positionals };
}

/** Every CLI invocation inside a block, in order. */
function invocationsIn(block: FencedBlock): Invocation[] {
  return joinContinuations(block.lines)
    .map((line) => parseInvocation(line))
    .filter((parsed): parsed is Invocation => parsed !== null);
}

const BLOCKS = fencedBlocks(DOC);
const CLI_BLOCKS = BLOCKS.filter((block) => block.marker === MARKER_CLI);
const INVALID_BLOCKS = BLOCKS.filter((block) => block.marker === MARKER_CLI_INVALID);

describe("docs/integration.md: markers", () => {
  it(`marks its command blocks with ${MARKER_CLI}`, () => {
    assert.ok(
      CLI_BLOCKS.length >= 8,
      `docs/integration.md must precede each command block with ${MARKER_CLI}; found ${CLI_BLOCKS.length}. ` +
        `Add the marker line immediately above the fence, or this test cannot check the commands.`,
    );
  });

  it(`marks the deliberately-broken invocation with ${MARKER_CLI_INVALID}`, () => {
    assert.equal(
      INVALID_BLOCKS.length,
      1,
      `docs/integration.md must contain exactly one block preceded by ${MARKER_CLI_INVALID} (the npx gotcha); found ${INVALID_BLOCKS.length}.`,
    );
  });

  it(`wraps the exit-code table in ${MARKER_EXIT_START} … ${MARKER_EXIT_END}`, () => {
    assert.ok(DOC.includes(MARKER_EXIT_START), `docs/integration.md is missing the marker ${MARKER_EXIT_START}`);
    assert.ok(DOC.includes(MARKER_EXIT_END), `docs/integration.md is missing the marker ${MARKER_EXIT_END}`);
    assert.ok(
      DOC.indexOf(MARKER_EXIT_START) < DOC.indexOf(MARKER_EXIT_END),
      `docs/integration.md: ${MARKER_EXIT_START} must come before ${MARKER_EXIT_END}`,
    );
  });

  it("has no CLI invocation outside a marked block", () => {
    const marked = new Set([...CLI_BLOCKS, ...INVALID_BLOCKS]);
    for (const block of BLOCKS) {
      if (marked.has(block)) {
        continue;
      }
      const stray = invocationsIn(block);
      assert.deepEqual(
        stray.map((invocation) => invocation.line),
        [],
        `docs/integration.md: the block at line ${block.startLine} invokes the CLI but is not preceded by ${MARKER_CLI} ` +
          `(or ${MARKER_CLI_INVALID} for an invocation that must fail).`,
      );
    }
  });
});

describe("docs/integration.md: every documented command matches the CLI surface", () => {
  const invocations = CLI_BLOCKS.flatMap((block) => invocationsIn(block));

  it("uses only real subcommands", () => {
    assert.ok(invocations.length >= 10, `expected the guide to show at least 10 CLI invocations, found ${invocations.length}`);
    for (const invocation of invocations) {
      if (invocation.subcommand === null) {
        const names = invocation.flags.map((flag) => flag.name);
        assert.ok(
          names.includes("version") || names.includes("help") || names.includes("h"),
          `${invocation.line}: no subcommand and no --version/--help`,
        );
        continue;
      }
      assert.ok(
        SUBCOMMAND_NAMES.includes(invocation.subcommand),
        `${invocation.line}: '${invocation.subcommand}' is not a subcommand; the CLI has ${SUBCOMMAND_NAMES.join(", ")}`,
      );
    }
  });

  it("uses only flags the CLI's usage text lists", () => {
    for (const invocation of invocations) {
      for (const flag of invocation.flags) {
        assert.ok(
          KNOWN_FLAGS.has(flag.name),
          `${invocation.line}: --${flag.name} is not a CLI flag; usage lists ${[...KNOWN_FLAGS].sort().join(", ")}`,
        );
      }
    }
  });

  it("gives diff and check both --base and --head", () => {
    for (const invocation of invocations) {
      if (invocation.subcommand !== "diff" && invocation.subcommand !== "check") {
        continue;
      }
      const names = invocation.flags.map((flag) => flag.name);
      assert.ok(names.includes("base") && names.includes("head"), `${invocation.line}: ${invocation.subcommand} requires --base and --head`);
    }
  });

  it("names only real --fail-on categories", () => {
    let seen = 0;
    for (const invocation of invocations) {
      for (const flag of invocation.flags) {
        if (flag.name !== "fail-on") {
          continue;
        }
        assert.ok(typeof flag.value === "string" && flag.value !== "", `${invocation.line}: --fail-on has no value`);
        for (const name of unquote(flag.value as string).split(",").map((item) => item.trim())) {
          assert.ok(FAIL_ON_NAMES.includes(name), `${invocation.line}: '${name}' is not a --fail-on name; valid: ${FAIL_ON_NAMES.join(", ")}`);
          seen += 1;
        }
      }
    }
    assert.ok(seen > 0, "the guide should show at least one --fail-on value");
  });

  it("passes explain only IDs the registry knows", () => {
    const ids = explainIds();
    let seen = 0;
    for (const invocation of invocations) {
      if (invocation.subcommand !== "explain") {
        continue;
      }
      const id = invocation.positionals[1];
      assert.ok(id !== undefined, `${invocation.line}: explain needs exactly one ID`);
      assert.ok(ids.includes(id as string), `${invocation.line}: '${String(id)}' is not an explain ID`);
      seen += 1;
    }
    assert.ok(seen > 0, "the guide should show at least one explain invocation");
  });

  it("only cites explain IDs that exist", () => {
    const ids = explainIds();
    const cited = new Set(
      Array.from(DOC.matchAll(/`(I\d|[DN]-[a-z][a-z0-9-]*)`/g), (match) => match[1] as string),
    );
    assert.ok(cited.size > 0, "the guide should cite at least one interpretation or rule ID");
    for (const id of cited) {
      assert.ok(ids.includes(id), `docs/integration.md cites '${id}', which agent-surface explain does not know`);
    }
  });
});

describe("docs/integration.md: the documented gotcha really fails", () => {
  it("exits 64 for `npx --yes ./<tarball> agent-surface check …`", () => {
    const invocations = INVALID_BLOCKS.flatMap((block) => invocationsIn(block));
    assert.equal(invocations.length, 1, "the gotcha block should show exactly one invocation");
    const invocation = invocations[0] as Invocation;
    assert.equal(invocation.subcommand, "agent-surface", `${invocation.line}: the gotcha is that the bin name lands where a subcommand belongs`);
    assert.ok(!SUBCOMMAND_NAMES.includes(invocation.subcommand), "the gotcha token must not be a real subcommand");
    const argv = ["agent-surface", ...invocation.positionals.slice(1)].concat(
      invocation.flags.flatMap((flag) => (flag.value === null ? [`--${flag.name}`] : [`--${flag.name}`, flag.value])),
    );
    const out: string[] = [];
    const err: string[] = [];
    const code = run(argv, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, { cwd: process.cwd() });
    assert.equal(code, EXIT_USAGE, `expected exit ${EXIT_USAGE}, got ${code}`);
    assert.match(err.join(""), /unknown subcommand 'agent-surface'/);
    assert.ok(DOC.includes("exits 64"), "the guide must say that this form exits 64");
  });

  it("the flag surface is closed, so an undocumented flag is a usage error", () => {
    const code = run(["check", "--not-a-flag"], { stdout: () => {}, stderr: () => {} }, { cwd: process.cwd() });
    assert.equal(code, EXIT_USAGE);
  });
});

describe("docs/integration.md: exit codes", () => {
  const region = DOC.slice(DOC.indexOf(MARKER_EXIT_START), DOC.indexOf(MARKER_EXIT_END));

  it("states exactly the codes verdict.ts and the CLI define", () => {
    const rows = region
      .split("\n")
      .filter((line) => /^\|\s*\d+\s*\|/.test(line))
      .map((line) => line.split("|").map((cell) => cell.trim()));
    const codes = rows.map((cells) => Number.parseInt(cells[1] as string, 10));
    assert.deepEqual(
      [...codes].sort((a, b) => a - b),
      [...KNOWN_EXIT_CODES].sort((a, b) => a - b),
      "the exit-code table must list exactly EXIT_OK, EXIT_EXPANDS, EXIT_ANNOTATE, EXIT_INCOMPLETE and EXIT_USAGE",
    );
    for (const code of codes) {
      assert.match(USAGE, new RegExp(`^ {2}${code}\\s`, "m"), `the CLI's usage text does not document exit ${code}`);
    }
    const meaning = new Map(rows.map((cells) => [Number.parseInt(cells[1] as string, 10), (cells[2] ?? "").toLowerCase()]));
    assert.match(meaning.get(EXIT_OK) ?? "", /no change/);
    assert.match(meaning.get(EXIT_EXPANDS) ?? "", /proven expansion/);
    assert.match(meaning.get(EXIT_ANNOTATE) ?? "", /undecided/);
    assert.match(meaning.get(EXIT_INCOMPLETE) ?? "", /incomplete/);
    assert.match(meaning.get(EXIT_USAGE) ?? "", /usage error/);
  });

  it("mentions no exit code the package does not define", () => {
    const mentioned = new Set(Array.from(DOC.matchAll(/\bexits? (\d+)\b/g), (match) => Number.parseInt(match[1] as string, 10)));
    assert.ok(mentioned.size > 0, "the guide should mention exit codes in prose");
    for (const code of mentioned) {
      assert.ok(KNOWN_EXIT_CODES.includes(code), `docs/integration.md mentions exit ${code}, which agent-surface never returns`);
    }
  });
});

describe("docs/integration.md: scope statements", () => {
  it("names the three V0 input files and the machine-state commands", () => {
    for (const needle of [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", "/permissions", "/doctor", "/status"]) {
      assert.ok(DOC.includes(needle), `docs/integration.md must name ${needle}`);
    }
  });

  it("is linked from the package README", () => {
    const readme = fs.readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
    assert.ok(readme.includes("docs/integration.md"), "README.md must link docs/integration.md");
  });
});
