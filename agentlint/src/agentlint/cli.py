"""Command-line interface (plan §2.8, §2.9).

::

    agentlint analyze <file|dir>... [--format text|json|md] [--run <id>] [--rules a,b,c]
                                    [--rules-module path]... [--config agentlint.toml]
                                    [--experimental-claude-session] [--include-snippets]
                                    [--loader <label>] [--output <path>]
    agentlint rules [--format text|json] [--rules-module path]...
    agentlint explain <RULE_ID> [--rules-module path]...
    agentlint --version

Exit codes: ``0`` analysis complete; ``2`` incomplete coverage (output still
printed); ``3`` unparseable input; ``1`` usage or configuration error
(unknown flag, rule ID, loader label, bad ``agentlint.toml`` or rules module).
Findings never change the exit code, and neither do rule errors.

What the CLI never does:

* never touches the network, sends telemetry, checks for updates or keeps
  state between invocations;
* never writes a file except the ``--output`` target the user named;
* never prints content: hashes, counts, sizes and identifiers only, plus
  redacted 200-character snippets when ``--include-snippets`` is given;
* never lets a finding, however severe, change the exit code.
"""

from __future__ import annotations

import argparse
import sys
import tomllib
from collections.abc import Sequence
from dataclasses import replace
from functools import partial
from pathlib import Path
from typing import Any, TextIO

from agentlint import __version__
from agentlint.analysis import EXIT_USAGE, AnalyzeOptions, analyze
from agentlint.loaders import claude_session
from agentlint.loaders.registry import (
    LOADER_LABELS,
    LoaderOptions,
    loader_by_label,
    options_from_mapping,
)
from agentlint.render import FORMATS, render
from agentlint.render.json import render_json
from agentlint.rules.base import Rule, render_rule_doc
from agentlint.rules.config import DEFAULT_RULES_CONFIG, RulesConfig, parse_config
from agentlint.rules.loader import RuleLoadError, all_rules

PROG = "agentlint"


class UsageError(Exception):
    """A problem with the invocation or configuration; exit code 1."""


class _Parser(argparse.ArgumentParser):
    """``argparse`` parser whose usage errors exit 1 (2 means incomplete coverage here).

    ``--version`` and ``--help`` text goes to the streams given to :func:`main`,
    never straight to the process streams, so the CLI is testable in-process.
    """

    def __init__(self, *args: Any, out: TextIO | None = None, err: TextIO | None = None, **kw):
        super().__init__(*args, **kw)
        self._out = out or sys.stdout
        self._err = err or sys.stderr

    def error(self, message: str) -> Any:
        raise UsageError(f"{self.prog}: error: {message}\n{self.format_usage().rstrip()}")

    def _print_message(self, message: str, file: Any = None) -> None:
        if not message:
            return
        if file is None or file is sys.stdout:
            self._out.write(message)
        elif file is sys.stderr:
            self._err.write(message)
        else:
            file.write(message)


def _add_rules_module(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--rules-module",
        action="append",
        default=[],
        metavar="PATH",
        help="Python file exposing app rules (RULES list or META/run); repeatable",
    )


def build_parser(out: TextIO | None = None, err: TextIO | None = None) -> argparse.ArgumentParser:
    """The ``agentlint`` argument parser (``argparse`` only)."""
    parser = _Parser(
        prog=PROG,
        description="Local, offline, deterministic agent trace linter.",
        out=out,
        err=err,
    )
    parser.add_argument("--version", action="version", version=f"{PROG} {__version__}")
    sub = parser.add_subparsers(
        dest="command", metavar="<command>", parser_class=partial(_Parser, out=out, err=err)
    )

    analyze_p = sub.add_parser(
        "analyze",
        help="load traces, print coverage, findings and stats",
        description=(
            "Load one or more trace files or directories, run the rules, and print "
            "coverage first, then findings, then run stats."
        ),
    )
    analyze_p.add_argument("inputs", nargs="+", metavar="<file|dir>")
    analyze_p.add_argument("--format", choices=FORMATS, default="text", dest="output_format")
    analyze_p.add_argument("--run", metavar="ID", help="analyse only the run with this ID")
    analyze_p.add_argument(
        "--rules", metavar="A,B,C", help="comma-separated rule IDs to run (default: all)"
    )
    _add_rules_module(analyze_p)
    analyze_p.add_argument("--config", metavar="agentlint.toml", help="thresholds and options")
    analyze_p.add_argument(
        claude_session.CLI_FLAG,
        action="store_true",
        dest="experimental_claude_session",
        help="enable the experimental Claude Code session loader",
    )
    analyze_p.add_argument(
        "--include-snippets",
        action="store_true",
        help="show redacted 200-character snippets of cited raw records",
    )
    analyze_p.add_argument(
        "--loader",
        choices=LOADER_LABELS,
        help="force this loader for every input instead of detecting by shape",
    )
    analyze_p.add_argument(
        "--output", metavar="PATH", help="write the report here instead of stdout"
    )

    rules_p = sub.add_parser("rules", help="list every generic and loaded app rule")
    rules_p.add_argument("--format", choices=("text", "json"), default="text", dest="output_format")
    _add_rules_module(rules_p)

    explain_p = sub.add_parser("explain", help="render one rule's documentation")
    explain_p.add_argument("rule_id", metavar="RULE_ID")
    _add_rules_module(explain_p)
    return parser


# --- Helpers ---------------------------------------------------------------


def load_rules(modules: Sequence[str]) -> list[Rule]:
    """Built-in rules plus ``--rules-module`` files and entry points; usage error on failure."""
    try:
        return all_rules(extra_modules=modules)
    except RuleLoadError as exc:
        raise UsageError(f"cannot load rules: {exc}") from exc


def select_rules(rules: Sequence[Rule], spec: str | None) -> list[Rule]:
    """Restrict ``rules`` to the comma-separated IDs in ``spec`` (``None`` keeps all)."""
    if spec is None:
        return list(rules)
    wanted = [item.strip() for item in spec.split(",") if item.strip()]
    if not wanted:
        raise UsageError("--rules needs at least one rule ID")
    known = {r.meta.id: r for r in rules}
    unknown = [w for w in wanted if w not in known]
    if unknown:
        raise UsageError(
            f"unknown rule ID(s) {', '.join(unknown)}; valid IDs: {', '.join(sorted(known))}"
        )
    return [known[w] for w in dict.fromkeys(wanted)]


def load_configuration(path: str | None) -> tuple[RulesConfig, LoaderOptions]:
    """Read ``agentlint.toml``: ``[rules.<ID>]`` thresholds and the ``[loaders]`` table."""
    if path is None:
        return DEFAULT_RULES_CONFIG, LoaderOptions()
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise UsageError(f"cannot read config {path}: {exc}") from exc
    try:
        rules_config = parse_config(text, source=path)
        loaders_table = tomllib.loads(text).get("loaders", {})
        if not isinstance(loaders_table, dict):
            raise ValueError(f"[loaders] in {path} must be a table")
        loader_options = options_from_mapping(loaders_table, source=path)
    except ValueError as exc:
        raise UsageError(str(exc)) from exc
    return rules_config, loader_options


def check_threshold_overrides(rules: Sequence[Rule], config: RulesConfig) -> None:
    """Usage error when ``agentlint.toml`` names a threshold a loaded rule does not declare.

    Overrides for rule IDs that are not loaded are left alone (they may belong
    to an optional rule pack); a typo in a loaded rule's section is reported
    before any analysis runs, never silently ignored.
    """
    problems: list[str] = []
    for rule in rules:
        try:
            config.for_rule(rule.meta.id, rule.meta.thresholds)
        except ValueError as exc:
            problems.append(str(exc))
    if problems:
        raise UsageError(f"bad thresholds in {config.source or 'config'}: " + "; ".join(problems))


def rules_table(rules: Sequence[Rule]) -> str:
    """The ``agentlint rules`` listing: ID, category, tier, confidence, requirements, source."""
    header = ("ID", "CATEGORY", "TIER", "CONFIDENCE", "REQUIREMENTS", "SOURCE")
    rows = [
        (
            r.meta.id,
            r.meta.category,
            r.meta.tier,
            r.meta.confidence,
            ", ".join(r.meta.requirements) or "none",
            r.source,
        )
        for r in rules
    ]
    widths = [max(len(row[i]) for row in (header, *rows)) for i in range(len(header))]
    lines = ["  ".join(h.ljust(widths[i]) for i, h in enumerate(header)).rstrip()]
    lines.extend(
        "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip() for row in rows
    )
    return "\n".join(lines) + "\n"


# --- Commands --------------------------------------------------------------


def cmd_analyze(args: argparse.Namespace, out: TextIO) -> int:
    rules_config, loader_options = load_configuration(args.config)
    if args.experimental_claude_session:
        loader_options = replace(loader_options, experimental_claude_session=True)
    if args.loader is not None:
        loader_by_label(args.loader)
        loader_options = replace(loader_options, loader=args.loader)
    loader_options = replace(loader_options, token=rules_config.token)
    rules = select_rules(load_rules(args.rules_module), args.rules)
    check_threshold_overrides(rules, rules_config)
    options = AnalyzeOptions(
        inputs=list(args.inputs),
        output_format=args.output_format,
        run_id=args.run,
        rule_ids=[r.meta.id for r in rules] if args.rules is not None else None,
        rules_modules=list(args.rules_module),
        config_path=args.config,
        include_snippets=args.include_snippets,
        loader=loader_options,
    )
    analysis = analyze(options, rules, rules_config)
    text = render(analysis.to_dict(), args.output_format)
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
    else:
        out.write(text)
    return analysis.exit_code


def cmd_rules(args: argparse.Namespace, out: TextIO) -> int:
    rules = load_rules(args.rules_module)
    if args.output_format == "json":
        out.write(render_json([r.to_dict() for r in rules]))
    else:
        out.write(rules_table(rules))
    return 0


def cmd_explain(args: argparse.Namespace, out: TextIO) -> int:
    rules = load_rules(args.rules_module)
    for rule in rules:
        if rule.meta.id == args.rule_id:
            out.write(render_rule_doc(rule.meta))
            return 0
    valid = ", ".join(r.meta.id for r in rules)
    raise UsageError(f"unknown rule ID {args.rule_id!r}; valid IDs: {valid}")


COMMANDS = {"analyze": cmd_analyze, "rules": cmd_rules, "explain": cmd_explain}


def main(
    argv: Sequence[str] | None = None, out: TextIO | None = None, err: TextIO | None = None
) -> int:
    """Run the CLI and return its exit status (never raises for user errors)."""
    out = out or sys.stdout
    err = err or sys.stderr
    parser = build_parser(out, err)
    try:
        args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))
    except UsageError as exc:
        err.write(f"{exc}\n")
        return EXIT_USAGE
    except SystemExit as exc:  # --version / --help print and exit through argparse
        return int(exc.code or 0)
    if args.command is None:
        parser.print_help(err)
        return EXIT_USAGE
    try:
        return COMMANDS[args.command](args, out)
    except UsageError as exc:
        err.write(f"{PROG}: {exc}\n")
        return EXIT_USAGE


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
