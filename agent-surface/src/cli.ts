#!/usr/bin/env node
/**
 * `agent-surface` command line (plan §3.8, JG-147).
 *
 * Subcommands:
 *   snapshot [path] [--json]
 *   diff  --base <ref> --head <ref|path|snapshot.json> [--json]
 *   check --base <ref> --head <ref> [--fail-on <categories>] [--strict] [--json]
 *   explain <ID>
 *
 * Exit codes (JG-155): 0 no change / narrowing only; 1 proven expansion in a
 * failing category; 2 unresolved- or projected-only (fails with --strict);
 * 3 scan incomplete (unparseable, duplicate keys, missing ref). Usage errors
 * exit 64 so they never collide with a verdict.
 *
 * In this version `diff` and `check` resolve both sides and run discovery
 * and parsing, then report the scan as incomplete (exit 3) because entry
 * extraction (CS-B) and the diff (CS-C) are not implemented yet. They never
 * print a "clean" verdict they cannot back.
 *
 * Never executes hooks, helpers or MCP servers; never touches the network;
 * never expands environment variables; never reads outside the repository.
 */

import { pathToFileURL } from "node:url";

import { canonicalJson } from "./canonical.js";
import { defaultFs, defaultSpawner, resolveSide, type FsAdapter, type Side, type Spawner } from "./git.js";
import { takeSnapshot } from "./snapshot.js";
import { SCHEMA_VERSION, type Incomplete, type Snapshot } from "./types.js";
import { VERSION } from "./version.js";

export const EXIT_OK = 0;
export const EXIT_EXPANDS = 1;
export const EXIT_ANNOTATE = 2;
export const EXIT_INCOMPLETE = 3;
export const EXIT_USAGE = 64;

/** Subcommand signatures as listed by `--help` (§3.8). */
export const SUBCOMMANDS: ReadonlyArray<{ name: string; signature: string; summary: string }> = [
  {
    name: "snapshot",
    signature: "snapshot [path] [--json]",
    summary: "parse the repository-controlled configuration at a path, ref, or snapshot.json",
  },
  {
    name: "diff",
    signature: "diff --base <ref> --head <ref|path|snapshot.json> [--json]",
    summary: "list control-surface entries added, removed, or changed between two sides",
  },
  {
    name: "check",
    signature: "check --base <ref> --head <ref> [--fail-on <categories>] [--strict] [--json]",
    summary: "exit non-zero when head expands the control surface relative to base",
  },
  {
    name: "explain",
    signature: "explain <ID>",
    summary: "print the documented interpretation behind a finding ID",
  },
];

export const USAGE = [
  "Usage: agent-surface <subcommand> [options]",
  "",
  "Deterministic, offline diff of repository-controlled Claude Code configuration.",
  "",
  "Subcommands:",
  ...SUBCOMMANDS.map((cmd) => `  ${cmd.signature.padEnd(78)} ${cmd.summary}`),
  "",
  "Options:",
  "  --json          machine-readable output with sorted keys",
  "  --help, -h      show this help",
  "  --version       print the version",
  "",
  "Exit codes:",
  "  0  no change, or narrowing only",
  "  1  proven expansion in a failing category",
  "  2  unresolved-only or projected-only changes (--strict turns this into 1)",
  "  3  scan incomplete (unparseable, duplicate keys, missing ref)",
  "  64 usage error",
  "",
].join("\n");

/** Output sinks; injected in tests. */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Environment the CLI runs against; injected in tests. */
export interface CliDeps {
  cwd: string;
  spawner?: Spawner;
  fs?: FsAdapter;
}

type Flags = Map<string, string | true>;

interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Flags;
}

const VALUE_FLAGS = new Set(["base", "head", "fail-on"]);
const BOOLEAN_FLAGS = new Set(["json", "strict", "help", "version"]);

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const flags: Flags = new Map();
  const positionals: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] ?? "";
    i += 1;
    if (arg === "--") {
      positionals.push(...argv.slice(i));
      break;
    }
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (VALUE_FLAGS.has(name)) {
        let value: string | undefined = eq === -1 ? argv[i] : arg.slice(eq + 1);
        if (eq === -1) {
          i += 1;
        }
        if (value === undefined) {
          return { error: `--${name} requires a value` };
        }
        flags.set(name, value);
        value = undefined;
        continue;
      }
      if (BOOLEAN_FLAGS.has(name)) {
        if (eq !== -1) {
          return { error: `--${name} does not take a value` };
        }
        flags.set(name, true);
        continue;
      }
      return { error: `unknown option ${arg}` };
    }
    positionals.push(arg);
  }
  const command = positionals.shift() ?? null;
  return { command, positionals, flags };
}

function renderIncomplete(items: readonly Incomplete[]): string {
  return items
    .map((item) => {
      const lines = item.lines === null ? "" : ` (line${item.lines.length > 1 ? "s" : ""} ${item.lines.join(", ")})`;
      return `incomplete: ${item.path}: ${item.reason}${lines}\n`;
    })
    .join("");
}

function renderSnapshotText(snapshot: Snapshot): string {
  const out: string[] = [];
  const sha = snapshot.origin.sha === null ? "" : ` ${snapshot.origin.sha}`;
  out.push(`agent-surface snapshot: ${snapshot.origin.kind} ${snapshot.origin.spec}${sha}`);
  out.push("assumptions:");
  for (const line of snapshot.assumptions) {
    out.push(`  - ${line}`);
  }
  out.push("sources:");
  for (const source of snapshot.sources) {
    const detail = [source.status, source.blob === null ? null : `blob ${source.blob.slice(0, 12)}`, source.note]
      .filter((item): item is string => item !== null)
      .join("; ");
    out.push(`  ${source.path.padEnd(30)} ${detail}`);
  }
  out.push(`entries: ${snapshot.entries.length}`);
  if (snapshot.incomplete.length === 0) {
    out.push("incomplete: none");
  } else {
    out.push("incomplete:");
    for (const item of snapshot.incomplete) {
      const lines = item.lines === null ? "" : ` (line${item.lines.length > 1 ? "s" : ""} ${item.lines.join(", ")})`;
      out.push(`  - ${item.path}: ${item.reason}${lines}`);
    }
  }
  return `${out.join("\n")}\n`;
}

function resolveOrReport(spec: string, deps: CliDeps): { side: Side } | { incomplete: Incomplete } {
  const resolved = resolveSide(spec, { cwd: deps.cwd, spawner: deps.spawner ?? defaultSpawner, fs: deps.fs ?? defaultFs });
  return resolved.ok ? { side: resolved.side } : { incomplete: resolved.incomplete };
}

function snapshotDeps(deps: CliDeps): { spawner: Spawner; fs: FsAdapter } {
  return { spawner: deps.spawner ?? defaultSpawner, fs: deps.fs ?? defaultFs };
}

function commandSnapshot(args: ParsedArgs, io: CliIo, deps: CliDeps): number {
  if (args.positionals.length > 1) {
    io.stderr(`snapshot: expected at most one path, got ${args.positionals.length}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const spec = args.positionals[0] ?? ".";
  const json = args.flags.get("json") === true;
  const resolved = resolveOrReport(spec, deps);
  if ("incomplete" in resolved) {
    const incomplete = [resolved.incomplete];
    io.stderr(renderIncomplete(incomplete));
    if (json) {
      io.stdout(canonicalJson({ schema_version: SCHEMA_VERSION, incomplete }));
    }
    return EXIT_INCOMPLETE;
  }
  const { snapshot } = takeSnapshot(resolved.side, snapshotDeps(deps));
  if (json) {
    io.stdout(canonicalJson(snapshot));
  } else {
    io.stdout(renderSnapshotText(snapshot));
  }
  if (snapshot.incomplete.length > 0) {
    io.stderr(renderIncomplete(snapshot.incomplete));
    return EXIT_INCOMPLETE;
  }
  return EXIT_OK;
}

const NOT_IMPLEMENTED: Incomplete = {
  path: "<agent-surface>",
  reason: "diff not implemented in this version: entry extraction (CS-B) and diff (CS-C) are pending",
  lines: null,
};

function commandTwoSided(name: "diff" | "check", args: ParsedArgs, io: CliIo, deps: CliDeps): number {
  const base = args.flags.get("base");
  const head = args.flags.get("head");
  if (typeof base !== "string" || typeof head !== "string") {
    io.stderr(`${name}: --base and --head are required\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (args.positionals.length > 0) {
    io.stderr(`${name}: unexpected argument '${args.positionals[0] ?? ""}'\n${USAGE}`);
    return EXIT_USAGE;
  }
  const json = args.flags.get("json") === true;
  const resolutions = { base: resolveOrReport(base, deps), head: resolveOrReport(head, deps) };
  const resolutionIncomplete: Incomplete[] = [];
  for (const resolved of [resolutions.base, resolutions.head]) {
    if ("incomplete" in resolved) {
      resolutionIncomplete.push(resolved.incomplete);
    }
  }
  if (resolutionIncomplete.length > 0) {
    io.stderr(renderIncomplete(resolutionIncomplete));
    if (json) {
      io.stdout(canonicalJson({ schema_version: SCHEMA_VERSION, incomplete: resolutionIncomplete }));
    }
    return EXIT_INCOMPLETE;
  }
  if (!("side" in resolutions.base) || !("side" in resolutions.head)) {
    return EXIT_INCOMPLETE; // unreachable; keeps the type narrowing explicit
  }
  const baseSnapshot = takeSnapshot(resolutions.base.side, snapshotDeps(deps)).snapshot;
  const headSnapshot = takeSnapshot(resolutions.head.side, snapshotDeps(deps)).snapshot;
  const incomplete = [...baseSnapshot.incomplete, ...headSnapshot.incomplete, NOT_IMPLEMENTED];
  if (json) {
    io.stdout(
      canonicalJson({
        schema_version: SCHEMA_VERSION,
        command: name,
        base: baseSnapshot,
        head: headSnapshot,
        changes: null,
        summary: null,
        incomplete,
      }),
    );
  } else {
    io.stdout(`base:\n${renderSnapshotText(baseSnapshot)}head:\n${renderSnapshotText(headSnapshot)}`);
  }
  io.stderr(renderIncomplete(incomplete));
  return EXIT_INCOMPLETE;
}

function commandExplain(args: ParsedArgs, io: CliIo): number {
  const id = args.positionals[0];
  if (id === undefined || args.positionals.length !== 1) {
    io.stderr(`explain: expected exactly one interpretation ID\n${USAGE}`);
    return EXIT_USAGE;
  }
  io.stderr(`explain: unknown interpretation ID '${id}' (no interpretations are registered in this version)\n`);
  return EXIT_USAGE;
}

/**
 * Run the CLI with `argv` (without the node and script entries) and return
 * the exit code. Never calls `process.exit`.
 */
export function run(argv: readonly string[], io: CliIo, deps: CliDeps): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    io.stderr(`${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (parsed.flags.get("version") === true) {
    io.stdout(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (parsed.flags.get("help") === true || parsed.command === null) {
    if (parsed.command === null && parsed.flags.get("help") !== true) {
      io.stderr(USAGE);
      return EXIT_USAGE;
    }
    io.stdout(USAGE);
    return EXIT_OK;
  }
  switch (parsed.command) {
    case "snapshot":
      return commandSnapshot(parsed, io, deps);
    case "diff":
      return commandTwoSided("diff", parsed, io, deps);
    case "check":
      return commandTwoSided("check", parsed, io, deps);
    case "explain":
      return commandExplain(parsed, io);
    default:
      io.stderr(`unknown subcommand '${parsed.command}'\n${USAGE}`);
      return EXIT_USAGE;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  const io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  process.exitCode = run(process.argv.slice(2), io, { cwd: process.cwd() });
}
