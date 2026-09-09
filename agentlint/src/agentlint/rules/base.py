"""Rule contract: metadata, Appendix A documentation, requirement checks (plan §2.6, §2.7).

A rule is a pure function ``run(run, config) -> list[Finding]`` plus a
:class:`RuleMeta`. The metadata is the single source for everything a reader
sees about a rule: ``agentlint rules``, ``agentlint explain <RULE_ID>`` and
the committed ``docs/rules/<RULE_ID>.md`` are all rendered from it by
:func:`render_rule_doc`, never hand-written.

``requirements`` name the coverage a rule needs before it may run. The
grammar is ``name`` or ``name(qualifier)``:

* ``ordering`` — every event carries ``seq`` or ``start_ms`` with an end
  (``end_ms`` or ``duration_ms``);
* an event kind (``model_call``, ``tool_call``, ...) — at least one event of
  that kind exists;
* an event field (``status``, ``tokens_in``, ``result_bytes``, ...) — the
  field is present on at least one applicable event; ``field(kind)`` narrows
  the applicable events to one kind and ``*_fingerprint(full)`` demands a
  ``full`` non-placeholder fingerprint.

Scope contract: generic rules never read ``Event.scope``. The one neutral
exception is the loader-populated tag list under
``scope["agentlint"]["tags"]`` (see :func:`agentlint.tokens.event_tags`),
which lets a loader declare polling, rereads, retries and deliberate large
reads without the rule knowing anything about the application. App-specific
rules read their own namespace only (see ``examples/rules``).

What this module never does:

* never runs a rule — see :mod:`agentlint.rules.engine`;
* never renders documentation text that is not in the metadata;
* never treats an unknown requirement name as satisfied.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from dataclasses import fields as dataclass_fields
from typing import TYPE_CHECKING, Any

from agentlint.fingerprint import is_placeholder_fingerprint
from agentlint.model import (
    CONFIDENCES,
    COVERED_EVENT_FIELDS,
    EVENT_KINDS,
    REPRESENTATIONS,
    TIERS,
    CoverageNote,
    Event,
    Finding,
    Run,
)
from agentlint.tokens import DEFAULT_TOKEN_CONFIG, TokenConfig, event_tags

if TYPE_CHECKING:  # pragma: no cover
    from agentlint.rules.config import RuleConfig

# --- Neutral loader tags ---------------------------------------------------

TAG_POLLING = "polling"
"""Loader tag: the app declared this call part of a polling loop."""
TAG_REREAD = "reread"
"""Loader tag: the app declared this an explicit, deliberate reread."""
TAG_RETRY = "retry"
"""Loader tag: the app or SDK declared this call an automatic retry."""
TAG_BACKOFF = "backoff"
"""Loader tag: the app declared this call part of a backoff schedule."""
TAG_LARGE_READ = "large_read"
"""Loader tag: the app declared this a deliberately requested large read."""

NEUTRAL_TAGS: tuple[str, ...] = (TAG_POLLING, TAG_REREAD, TAG_RETRY, TAG_BACKOFF, TAG_LARGE_READ)
"""Every tag a generic rule understands; anything else in the list is ignored."""


def has_tag(event: Event, tags: Iterable[str], config: TokenConfig = DEFAULT_TOKEN_CONFIG) -> bool:
    """True when ``event`` carries any of ``tags`` in the neutral tag namespace."""
    wanted = set(tags)
    return any(t in wanted for t in event_tags(event, config))


# --- Documentation (Appendix A) --------------------------------------------

DOC_SECTIONS: tuple[tuple[str, str], ...] = (
    ("problem", "Problem"),
    ("detection", "Detection"),
    ("prerequisites", "Prerequisites"),
    ("evidence", "Evidence"),
    ("exclusions", "Exclusions"),
    ("thresholds", "Thresholds"),
    ("limitations", "Limitations"),
    ("remediation", "Remediation"),
    ("tier_confidence", "Tier / Confidence"),
    ("fixtures", "Fixtures"),
)
"""Appendix A sections in render order: attribute name and heading."""


@dataclass(frozen=True, slots=True)
class RuleDoc:
    """The Appendix A sections of a rule's documentation, as Markdown text."""

    problem: str
    detection: str
    prerequisites: str
    evidence: str
    exclusions: str
    thresholds: str
    limitations: str
    remediation: str
    tier_confidence: str
    fixtures: str

    def to_dict(self) -> dict[str, str]:
        return {name: getattr(self, name) for name, _ in DOC_SECTIONS}

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> RuleDoc:
        return cls(**{name: str(data.get(name, "") or "") for name, _ in DOC_SECTIONS})


EMPTY_DOC = RuleDoc(*([""] * len(DOC_SECTIONS)))
"""A doc with every section empty; fails :func:`validate_meta` on purpose."""

# --- Metadata --------------------------------------------------------------

_RULE_ID = re.compile(r"^[A-Z][A-Z0-9_]*$")
_REQUIREMENT = re.compile(r"^([a-z_]+)(?:\(([a-z_]+)\))?$")

_EVENT_FIELD_NAMES: frozenset[str] = frozenset(
    f.name
    for f in dataclass_fields(Event)
    if f.name not in {"id", "source_locator", "kind", "scope", "included_result_ids"}
)
KNOWN_REQUIREMENT_NAMES: frozenset[str] = frozenset({"ordering"}) | EVENT_KINDS | _EVENT_FIELD_NAMES
"""Every bare name the requirement grammar accepts."""


@dataclass(frozen=True, slots=True)
class RuleMeta:
    """Everything a reader may know about a rule without running it.

    ``requirements`` follow the grammar in the module docstring;
    ``thresholds`` are the rule's provisional defaults (a config file may
    override them, see :mod:`agentlint.rules.config`); ``doc`` holds the
    Appendix A sections.
    """

    id: str
    title: str
    category: str
    requirements: list[str] = field(default_factory=list)
    tier: str = "unresolved"
    confidence: str = "low"
    thresholds: dict[str, Any] = field(default_factory=dict)
    doc: RuleDoc = EMPTY_DOC

    def __post_init__(self) -> None:
        if not self.id:
            raise ValueError("RuleMeta.id must be non-empty")
        if self.tier not in TIERS:
            raise ValueError(f"RuleMeta.tier must be one of {sorted(TIERS)}, got {self.tier!r}")
        if self.confidence not in CONFIDENCES:
            raise ValueError(
                f"RuleMeta.confidence must be one of {sorted(CONFIDENCES)}, got {self.confidence!r}"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "category": self.category,
            "requirements": list(self.requirements),
            "tier": self.tier,
            "confidence": self.confidence,
            "thresholds": {k: self.thresholds[k] for k in sorted(self.thresholds)},
            "doc": self.doc.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> RuleMeta:
        return cls(
            id=data["id"],
            title=data["title"],
            category=data["category"],
            requirements=list(data.get("requirements") or []),
            tier=data.get("tier", "unresolved"),
            confidence=data.get("confidence", "low"),
            thresholds=dict(data.get("thresholds") or {}),
            doc=RuleDoc.from_dict(data.get("doc") or {}),
        )


RunFunction = Callable[[Run, "RuleConfig"], list[Finding]]
"""Signature of a rule body: pure, deterministic, returns findings only."""


@dataclass(frozen=True, slots=True)
class Rule:
    """A rule: its metadata, its pure ``run`` function and where it was loaded from.

    ``source`` is ``builtin``, ``module:<path>`` or ``entry-point:<name>``.
    """

    meta: RuleMeta
    run: RunFunction
    source: str = "builtin"

    def to_dict(self) -> dict[str, Any]:
        return {"source": self.source, **self.meta.to_dict()}


class RuleMetaError(ValueError):
    """Raised by :func:`validate_meta` when metadata is incomplete or malformed."""


def parse_requirement(requirement: str) -> tuple[str, str | None]:
    """Split ``name`` / ``name(qualifier)``; raises ``ValueError`` on bad syntax or names."""
    match = _REQUIREMENT.match(requirement)
    if match is None:
        raise ValueError(f"malformed requirement {requirement!r}")
    name, qualifier = match.group(1), match.group(2)
    if name not in KNOWN_REQUIREMENT_NAMES:
        raise ValueError(f"unknown requirement name {name!r} in {requirement!r}")
    if qualifier is None:
        return name, None
    if name in EVENT_KINDS or name == "ordering":
        raise ValueError(f"requirement {name!r} takes no qualifier ({requirement!r})")
    if qualifier in EVENT_KINDS:
        return name, qualifier
    if qualifier in REPRESENTATIONS and name.endswith("_fingerprint"):
        return name, qualifier
    raise ValueError(f"unknown qualifier {qualifier!r} in requirement {requirement!r}")


def validate_meta(meta: RuleMeta) -> None:
    """Fail loudly when ``meta`` could not be documented or checked.

    Raises :class:`RuleMetaError` naming every problem: a malformed ID, an
    empty title or category, a malformed or unknown requirement, or any
    Appendix A section that is missing or blank. This is the metadata test
    ``agentlint explain`` relies on.
    """
    problems: list[str] = []
    if not _RULE_ID.match(meta.id):
        problems.append(f"id {meta.id!r} must be UPPER_SNAKE_CASE")
    if not meta.title.strip():
        problems.append("title is empty")
    if not meta.category.strip():
        problems.append("category is empty")
    for requirement in meta.requirements:
        try:
            parse_requirement(requirement)
        except ValueError as exc:
            problems.append(str(exc))
    for name, heading in DOC_SECTIONS:
        if not getattr(meta.doc, name).strip():
            problems.append(f"doc section {heading!r} ({name}) is missing or empty")
    if problems:
        raise RuleMetaError(f"rule {meta.id}: " + "; ".join(problems))


def render_rule_doc(meta: RuleMeta) -> str:
    """Render the Appendix A page for ``meta`` as Markdown, sections in fixed order.

    The Thresholds section is followed by the default values taken from
    ``meta.thresholds`` so the numbers can never drift from the code.
    """
    lines = [
        f"# {meta.id} — {meta.title}",
        "",
        f"Category: `{meta.category}` · Tier: `{meta.tier}` · Confidence: `{meta.confidence}`",
        "",
        "Requirements: "
        + (", ".join(f"`{r}`" for r in meta.requirements) if meta.requirements else "none"),
        "",
    ]
    for name, heading in DOC_SECTIONS:
        lines.append(f"## {heading}")
        lines.append("")
        lines.append(getattr(meta.doc, name).strip())
        lines.append("")
        if name == "thresholds":
            if meta.thresholds:
                lines.append("Defaults:")
                lines.append("")
                for key in sorted(meta.thresholds):
                    lines.append(f"- `{key}` = {meta.thresholds[key]!r}")
            else:
                lines.append("This rule has no thresholds.")
            lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


# --- Requirement checking --------------------------------------------------


def has_ordering(event: Event) -> bool:
    """True when ``event`` can be placed: it has ``seq`` or ``start_ms`` with an end."""
    if event.seq is not None:
        return True
    return event.start_ms is not None and (
        event.end_ms is not None or event.duration_ms is not None
    )


def _applicable(events: list[Event], name: str, qualifier: str | None) -> list[Event]:
    if qualifier in EVENT_KINDS:
        return [e for e in events if e.kind == qualifier]
    if name == "status":
        return [e for e in events if e.kind == "tool_call"]
    kinds = COVERED_EVENT_FIELDS.get(name)
    if kinds is None:
        return list(events)
    return [e for e in events if e.kind in kinds]


def _satisfies(event: Event, name: str, qualifier: str | None) -> bool:
    if name == "ordering":
        return has_ordering(event)
    if name == "status":
        return event.status != "unknown"
    value = getattr(event, name)
    if value is None:
        return False
    if name.endswith("_fingerprint") and qualifier in REPRESENTATIONS:
        return value.representation == qualifier and not is_placeholder_fingerprint(value)
    return True


@dataclass(frozen=True, slots=True)
class RequirementStatus:
    """How one requirement fares on one run.

    ``met`` is False when no applicable event satisfies it; ``lacking`` lists
    the applicable events that do not satisfy it (partial coverage).
    """

    requirement: str
    met: bool
    lacking: list[str] = field(default_factory=list)


def requirement_status(run: Run, requirement: str) -> RequirementStatus:
    """Evaluate one requirement against ``run``'s events (never against ``scope``).

    An unknown or malformed requirement is reported as unmet so a rule that
    asks for something the checker does not understand never runs.
    """
    try:
        name, qualifier = parse_requirement(requirement)
    except ValueError:
        return RequirementStatus(requirement=requirement, met=False)
    events = run.sorted_events()
    if name in EVENT_KINDS:
        return RequirementStatus(requirement=requirement, met=any(e.kind == name for e in events))
    applicable = _applicable(events, name, qualifier)
    lacking = [e.id for e in applicable if not _satisfies(e, name, qualifier)]
    met = bool(applicable) and len(lacking) < len(applicable)
    return RequirementStatus(requirement=requirement, met=met, lacking=lacking if met else [])


def check_requirements(run: Run, meta: RuleMeta) -> list[str]:
    """The requirements of ``meta`` that ``run`` does not meet, in declaration order.

    Uses ``run.coverage.fields`` as a fast negative (a field the loader
    reported ``absent`` is unmet without scanning) and the events for
    everything else. An empty result means the rule may run.
    """
    unmet: list[str] = []
    for requirement in meta.requirements:
        try:
            name, qualifier = parse_requirement(requirement)
        except ValueError:
            unmet.append(requirement)
            continue
        if (
            qualifier is None
            and name in COVERED_EVENT_FIELDS
            and run.coverage.fields.get(name) == "absent"
        ):
            unmet.append(requirement)
            continue
        if not requirement_status(run, requirement).met:
            unmet.append(requirement)
    return unmet


def partial_coverage_notes(run: Run, meta: RuleMeta) -> list[CoverageNote]:
    """Notes for requirements that are met on some applicable events but not all.

    The rule still runs, but it makes no claim about the lacking events; the
    note (``code="rule_partial"``) cites their IDs so the run summary can
    list the rule as incomplete rather than clean.
    """
    notes: list[CoverageNote] = []
    for requirement in meta.requirements:
        status = requirement_status(run, requirement)
        if status.met and status.lacking:
            notes.append(
                CoverageNote(
                    code="rule_partial",
                    message=(
                        f"{meta.id}: {len(status.lacking)} event(s) lack {requirement}; "
                        "the rule makes no claim about them"
                    ),
                    fields=[requirement],
                    rule_id=meta.id,
                    event_ids=list(status.lacking),
                )
            )
    return notes
