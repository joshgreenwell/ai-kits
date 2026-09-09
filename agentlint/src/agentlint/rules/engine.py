"""Rule engine: prerequisites, execution, evidence validation, collapsing (plan §2.6, §2.7).

:func:`run_rules` runs every rule against one run and returns a
:class:`RuleReport`. A rule whose requirements are unmet is not invoked and
leaves a ``rule_abstained`` coverage note naming the missing fields. A rule
that raises is reported under its ID and the other rules still run. A
finding whose evidence does not cite identifiers present in the run is
rejected with a clear error.

What this module never does:

* never invokes a rule whose requirements are unmet;
* never lets one rule's exception stop the others;
* never accepts evidence that cites an identifier the run does not contain;
* never changes a finding's tier, confidence or claims — it only attaches
  thresholds, merges evidence of identical patterns and orders the output.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from agentlint.model import CoverageNote, Evidence, Finding, Run
from agentlint.rules.base import Rule, RuleMeta, check_requirements, partial_coverage_notes
from agentlint.rules.config import DEFAULT_RULES_CONFIG, RulesConfig

EVIDENCE_ERROR_PREFIX = "evidence must cite original identifiers"


@dataclass(frozen=True, slots=True)
class RuleError:
    """A rule that could not be run or produced an unusable finding."""

    rule_id: str
    message: str
    stage: str = "run"
    exception_type: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "message": self.message,
            "stage": self.stage,
            "exception_type": self.exception_type,
        }


@dataclass(slots=True)
class RuleReport:
    """Everything the rules said about one run.

    ``abstentions`` holds ``rule_abstained`` notes (rule not invoked) and
    ``rule_partial`` notes (rule ran but made no claim about some events);
    ``incomplete_for_rules`` lists every rule that abstained, was partial or
    errored, so the summary never reads as clean when it is not.
    ``thresholds`` records each rule's effective values.
    """

    run_id: str
    findings: list[Finding] = field(default_factory=list)
    abstentions: list[CoverageNote] = field(default_factory=list)
    errors: list[RuleError] = field(default_factory=list)
    incomplete_for_rules: list[str] = field(default_factory=list)
    thresholds: dict[str, dict[str, Any]] = field(default_factory=dict)
    rules_run: list[str] = field(default_factory=list)

    def summary_line(self) -> str | None:
        """``incomplete for rules: [A, B]`` or ``None`` when every rule ran fully."""
        if not self.incomplete_for_rules:
            return None
        return "incomplete for rules: [" + ", ".join(self.incomplete_for_rules) + "]"

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "findings": [f.to_dict() for f in self.findings],
            "abstentions": [n.to_dict() for n in self.abstentions],
            "errors": [e.to_dict() for e in self.errors],
            "incomplete_for_rules": list(self.incomplete_for_rules),
            "thresholds": {
                rule_id: {k: values[k] for k in sorted(values)}
                for rule_id, values in sorted(self.thresholds.items())
            },
            "rules_run": list(self.rules_run),
            "summary": self.summary_line(),
        }


class EvidenceError(ValueError):
    """A finding cites an identifier that is not in the run."""


def _raw_record_identifiers(records: Iterable[Any]) -> tuple[set[str], set[str]]:
    ids: set[str] = set()
    locators: set[str] = set()
    for record in records:
        if not isinstance(record, Mapping):
            continue
        for key in ("id", "row_id", "event_id", "span_id"):
            value = record.get(key)
            if isinstance(value, str) and value:
                ids.add(value)
        for key in ("locator", "source_locator"):
            value = record.get(key)
            if isinstance(value, str) and value:
                locators.add(value)
    return ids, locators


def validate_finding(run: Run, finding: Finding, meta: RuleMeta) -> None:
    """Raise :class:`EvidenceError` unless every evidence item cites the run.

    An evidence item is acceptable when its ``(event_id, source_locator)``
    pair matches an event of the run, or when its ``event_id`` or
    ``source_locator`` matches an entry of ``run.raw_records`` (records that
    carry an ``id`` / ``row_id`` or a ``locator`` / ``source_locator``).
    Findings must also carry the rule's own ID and the run's ID, and at least
    one evidence item.
    """
    if finding.rule_id != meta.id:
        raise EvidenceError(
            f"finding rule_id {finding.rule_id!r} does not match rule {meta.id!r}"
        )
    if finding.run_id != run.id:
        raise EvidenceError(f"finding run_id {finding.run_id!r} does not match run {run.id!r}")
    if not finding.evidence:
        raise EvidenceError(f"{EVIDENCE_ERROR_PREFIX}: finding has no evidence")
    pairs = {(e.id, e.source_locator) for e in run.events}
    raw_ids, raw_locators = _raw_record_identifiers(run.raw_records)
    for item in finding.evidence:
        if (item.event_id, item.source_locator) in pairs:
            continue
        if item.event_id in raw_ids or item.source_locator in raw_locators:
            continue
        raise EvidenceError(
            f"{EVIDENCE_ERROR_PREFIX}: evidence locator {item.locator!r} matches no event "
            f"or raw record of run {run.id}"
        )


def _evidence_key(item: Evidence, position: Mapping[str, int]) -> tuple[Any, ...]:
    return (
        position.get(item.event_id, len(position)),
        item.event_id,
        item.source_locator,
        item.field or "",
        item.note or "",
        str(item.value),
    )


def collapse_findings(
    run: Run, findings: Iterable[Finding], thresholds: Mapping[str, Any]
) -> list[Finding]:
    """One finding per pattern, evidence merged and ordered, fingerprint recomputed.

    Findings of the same rule that describe the same pattern — equal
    ``tier``, ``confidence``, ``observed_pattern`` and ``impact`` — are merged
    into one finding carrying the union of their evidence and limitations.
    Evidence is ordered by the cited event's position in the run; findings
    are ordered by the position of their earliest evidence, then by pattern.
    A finding without thresholds receives ``thresholds`` (the effective
    configuration) so the values are always visible.
    """
    position = {e.id: i for i, e in enumerate(run.sorted_events())}
    groups: dict[tuple[str, str, str, str, str, str], list[Finding]] = {}
    order: list[tuple[str, str, str, str, str, str]] = []
    for f in findings:
        key = (f.rule_id, f.title, f.category, f.tier, f.confidence, f.observed_pattern)
        key = (*key[:5], f"{f.observed_pattern}\x00{f.impact or ''}")
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(f)

    collapsed: list[Finding] = []
    for key in order:
        members = groups[key]
        first = members[0]
        seen: dict[tuple[Any, ...], Evidence] = {}
        for m in members:
            for item in m.evidence:
                seen.setdefault(_evidence_key(item, position), item)
        evidence = [seen[k] for k in sorted(seen)]
        limitations: list[str] = []
        for m in members:
            for text in m.limitations:
                if text not in limitations:
                    limitations.append(text)
        effective = dict(first.thresholds) if first.thresholds else dict(thresholds)
        collapsed.append(
            Finding(
                rule_id=first.rule_id,
                title=first.title,
                category=first.category,
                tier=first.tier,
                confidence=first.confidence,
                run_id=first.run_id,
                observed_pattern=first.observed_pattern,
                impact=first.impact,
                evidence=evidence,
                limitations=limitations,
                thresholds={k: effective[k] for k in sorted(effective)},
                fingerprint="",
            )
        )

    def sort_key(f: Finding) -> tuple[Any, ...]:
        earliest = min(
            (position.get(e.event_id, len(position)) for e in f.evidence), default=len(position)
        )
        return (f.rule_id, earliest, f.tier, f.observed_pattern, f.fingerprint)

    return sorted(collapsed, key=sort_key)


def run_rules(
    run: Run, rules: Iterable[Rule], config: RulesConfig = DEFAULT_RULES_CONFIG
) -> RuleReport:
    """Run ``rules`` against ``run`` and report findings, abstentions and errors.

    Rules are processed in ID order. For each rule: resolve its effective
    thresholds (a bad override is a ``config`` error), check requirements
    (unmet → ``rule_abstained`` note, rule not invoked), record partial
    coverage, invoke the rule (an exception → ``run`` error), validate every
    finding's evidence (a bad finding → ``evidence`` error, other findings
    kept), then collapse and order what remains.
    """
    report = RuleReport(run_id=run.id)
    incomplete: set[str] = set()
    for rule in sorted(rules, key=lambda r: r.meta.id):
        rule_id = rule.meta.id
        try:
            rule_config = config.for_rule(rule_id, rule.meta.thresholds)
        except ValueError as exc:
            report.errors.append(RuleError(rule_id=rule_id, message=str(exc), stage="config"))
            incomplete.add(rule_id)
            continue
        report.thresholds[rule_id] = dict(rule_config.thresholds)

        missing = check_requirements(run, rule.meta)
        if missing:
            report.abstentions.append(
                CoverageNote(
                    code="rule_abstained",
                    message=(
                        f"{rule_id} did not run: missing " + ", ".join(missing)
                    ),
                    fields=list(missing),
                    rule_id=rule_id,
                )
            )
            incomplete.add(rule_id)
            continue
        partial = partial_coverage_notes(run, rule.meta)
        if partial:
            report.abstentions.extend(partial)
            incomplete.add(rule_id)

        try:
            produced = list(rule.run(run, rule_config))
        except Exception as exc:
            report.errors.append(
                RuleError(
                    rule_id=rule_id,
                    message=f"{rule_id} raised {type(exc).__name__}: {exc}",
                    stage="run",
                    exception_type=type(exc).__name__,
                )
            )
            incomplete.add(rule_id)
            continue
        report.rules_run.append(rule_id)

        accepted: list[Finding] = []
        for finding in produced:
            try:
                validate_finding(run, finding, rule.meta)
            except EvidenceError as exc:
                report.errors.append(
                    RuleError(
                        rule_id=rule_id,
                        message=f"{rule_id} finding rejected: {exc}",
                        stage="evidence",
                    )
                )
                incomplete.add(rule_id)
                continue
            accepted.append(finding)
        report.findings.extend(collapse_findings(run, accepted, rule_config.thresholds))

    report.incomplete_for_rules = sorted(incomplete)
    return report
