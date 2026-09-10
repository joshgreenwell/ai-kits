"""The ``analyze`` pipeline: load → rules → stats → one plain document (plan §2.8).

:func:`analyze` turns command-line inputs into the *analysis document*: a
JSON-shaped ``dict`` holding the input manifest, everything that could not be
loaded (``incomplete``), and per run the model (events, coverage), the rule
report (findings, abstentions, errors, thresholds), the stats block and the
token-selection exclusions. Every renderer (text, JSON, Markdown) reads this
one document, so the three formats can never disagree about what was found.

Exit codes are decided here from the document (:func:`exit_code`):

* ``0`` — every input loaded, every run is ``complete`` and every rule ran fully;
* ``2`` — analysis ran but coverage is incomplete: a run is ``incomplete``, a
  file could not be loaded, or a rule abstained / ran partially. Output is
  still printed in full;
* ``3`` — unparseable input: at least one input yielded no run, or nothing
  was loadable at all.

Findings never change the exit code. Rule *errors* (a rule that raised or
produced unusable evidence) are printed but do not change it either.

What this module never does:

* never includes ``Run.raw_records`` in the document — only their count, and
  redacted snippets when explicitly asked for;
* never writes a file, touches the network or keeps state;
* never renders — see :mod:`agentlint.render`.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from agentlint import __version__
from agentlint.loaders.registry import (
    DEFAULT_LOADER_OPTIONS,
    InputManifest,
    LoaderOptions,
    load_inputs,
)
from agentlint.model import Run
from agentlint.redact import snippet_for
from agentlint.rules.base import Rule
from agentlint.rules.config import DEFAULT_RULES_CONFIG, RulesConfig
from agentlint.rules.engine import RuleReport, run_rules
from agentlint.stats import run_stats
from agentlint.tokens import select_comparable

EXIT_COMPLETE = 0
EXIT_USAGE = 1
EXIT_INCOMPLETE = 2
EXIT_UNPARSEABLE = 3

EXIT_MEANINGS: dict[int, str] = {
    EXIT_COMPLETE: "analysis complete",
    EXIT_USAGE: "usage or configuration error",
    EXIT_INCOMPLETE: "analysis ran with incomplete coverage",
    EXIT_UNPARSEABLE: "unparseable input",
}


@dataclass(frozen=True, slots=True)
class AnalyzeOptions:
    """What the user asked ``analyze`` to do (recorded in the document under ``options``)."""

    inputs: Sequence[str]
    output_format: str = "text"
    run_id: str | None = None
    rule_ids: Sequence[str] | None = None
    rules_modules: Sequence[str] = ()
    config_path: str | None = None
    include_snippets: bool = False
    loader: LoaderOptions = DEFAULT_LOADER_OPTIONS

    def to_dict(self) -> dict[str, Any]:
        return {
            "inputs": list(self.inputs),
            "format": self.output_format,
            "run": self.run_id,
            "rules": None if self.rule_ids is None else sorted(self.rule_ids),
            "rules_modules": list(self.rules_modules),
            "config": self.config_path,
            "include_snippets": self.include_snippets,
            **self.loader.to_dict(),
        }


@dataclass(slots=True)
class RunAnalysis:
    """One run with its rule report, stats and exclusions; ``to_dict`` is the JSON shape."""

    run: Run
    report: RuleReport
    stats: dict[str, Any]
    exclusions: dict[str, Any]
    snippets: dict[str, str] | None = None

    @property
    def rules_incomplete(self) -> bool:
        """True when any rule abstained or ran partially (errors do not count)."""
        return bool(self.report.abstentions)

    def to_dict(self) -> dict[str, Any]:
        run = self.run.to_dict()
        coverage = run.pop("coverage")
        raw_count = len(run.pop("raw_records"))
        run["raw_records_retained"] = raw_count
        report = self.report.to_dict()
        document = {
            "run": run,
            "coverage": coverage,
            "findings": report["findings"],
            "abstentions": report["abstentions"],
            "errors": report["errors"],
            "incomplete_for_rules": report["incomplete_for_rules"],
            "rules_run": report["rules_run"],
            "summary": report["summary"],
            "thresholds": report["thresholds"],
            "stats": self.stats,
            "exclusions": self.exclusions,
        }
        if self.snippets is not None:
            document["snippets"] = {k: self.snippets[k] for k in sorted(self.snippets)}
        return document


def evidence_key(event_id: str, source_locator: str) -> str:
    """Key under which a snippet is stored: ``<event_id>@<source_locator>``."""
    return f"{event_id}@{source_locator}"


def _snippets(run: Run, report: RuleReport) -> dict[str, str]:
    snippets: dict[str, str] = {}
    for finding in report.findings:
        for item in finding.evidence:
            key = evidence_key(item.event_id, item.source_locator)
            if key in snippets:
                continue
            text = snippet_for(run, item)
            if text is not None:
                snippets[key] = text
    return snippets


def analyze_run(
    run: Run,
    rules: Iterable[Rule],
    rules_config: RulesConfig = DEFAULT_RULES_CONFIG,
    include_snippets: bool = False,
) -> RunAnalysis:
    """Rules, stats and exclusions for one already-loaded run."""
    report = run_rules(run, rules, rules_config)
    selection = select_comparable(run, rules_config.token)
    exclusions = {
        "config": rules_config.token.to_dict(),
        "excluded": {k: selection.excluded[k] for k in sorted(selection.excluded)},
        "series": [s.to_dict() for s in selection.series],
    }
    return RunAnalysis(
        run=run,
        report=report,
        stats=run_stats(run, rules_config.token).to_dict(),
        exclusions=exclusions,
        snippets=_snippets(run, report) if include_snippets else None,
    )


@dataclass(slots=True)
class Analysis:
    """The full result of one ``analyze`` invocation."""

    options: AnalyzeOptions
    manifest: InputManifest
    runs: list[RunAnalysis] = field(default_factory=list)
    unknown_run_id: str | None = None

    @property
    def coverage_incomplete(self) -> bool:
        return (
            bool(self.manifest.incomplete)
            or any(r.run.coverage.completeness == "incomplete" for r in self.runs)
            or any(r.rules_incomplete for r in self.runs)
        )

    @property
    def exit_code(self) -> int:
        return exit_code(self)

    def to_dict(self) -> dict[str, Any]:
        code = self.exit_code
        manifest = self.manifest.to_dict()
        return {
            "agentlint_version": __version__,
            "options": self.options.to_dict(),
            "inputs": manifest["inputs"],
            "incomplete": manifest["incomplete"],
            "runs": [r.to_dict() for r in self.runs],
            "summary": {
                "runs": len(self.runs),
                "runs_loaded": len(self.manifest.runs),
                "findings": sum(len(r.report.findings) for r in self.runs),
                "incomplete": self.coverage_incomplete,
                "incomplete_inputs": len(self.manifest.incomplete),
                "inputs_without_runs": list(self.manifest.inputs_without_runs),
                "unknown_run_id": self.unknown_run_id,
                "exit_code": code,
                "exit_meaning": EXIT_MEANINGS[code],
            },
        }


def exit_code(analysis: Analysis) -> int:
    """Map an :class:`Analysis` to 0 / 2 / 3 (see the module docstring)."""
    if not analysis.manifest.runs or analysis.manifest.inputs_without_runs:
        return EXIT_UNPARSEABLE
    if analysis.unknown_run_id is not None:
        return EXIT_UNPARSEABLE
    if analysis.coverage_incomplete:
        return EXIT_INCOMPLETE
    return EXIT_COMPLETE


def analyze(
    options: AnalyzeOptions,
    rules: Sequence[Rule],
    rules_config: RulesConfig = DEFAULT_RULES_CONFIG,
) -> Analysis:
    """Load every input, run ``rules`` on every (selected) run, compute stats.

    ``options.run_id`` narrows the analysis to one run; an ID that matches no
    loaded run leaves ``unknown_run_id`` set (exit code 3) and analyses
    nothing. Pure apart from reading the input files.
    """
    manifest = load_inputs(options.inputs, options.loader)
    selected = manifest.runs
    unknown: str | None = None
    if options.run_id is not None:
        selected = [r for r in manifest.runs if r.id == options.run_id]
        if not selected:
            unknown = options.run_id
    analysed = [analyze_run(run, rules, rules_config, options.include_snippets) for run in selected]
    return Analysis(options=options, manifest=manifest, runs=analysed, unknown_run_id=unknown)
