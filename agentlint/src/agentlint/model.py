"""Neutral in-memory model for agent run traces (plan §2.4).

Every loader produces a :class:`Run`; every rule reads one. The model is
deliberately plain: frozen dataclasses, JSON-shaped values, and explicit
``None`` for anything the source did not provide.

What this module never does:

* never turns an absent value into ``0``, ``""`` or ``{}`` — absent is ``None``
  in memory and ``null`` in JSON;
* never synthesizes an identifier from another identifier;
* never reorders or drops ``raw_records`` — they are kept verbatim as evidence;
* never reads ``Event.scope`` — that namespace belongs to app-specific rules.

Serialisation is lossless: ``from_dict(to_dict(x)) == x`` for every dataclass
here. Hex identifiers stay strings, large timestamp integers stay integers.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

# --- Closed vocabularies ---------------------------------------------------

EVENT_KINDS: frozenset[str] = frozenset(
    {"model_call", "tool_call", "approval", "aggregate", "other"}
)
"""Values ``Event.kind`` may take."""

EVENT_STATUSES: frozenset[str] = frozenset({"ok", "error", "blocked", "unknown"})
"""Values ``Event.status`` may take. A denied approval is ``blocked``, not ``error``."""

REPRESENTATIONS: frozenset[str] = frozenset({"full", "redacted", "truncated"})
"""How much of the original value a :class:`Fingerprint` was computed over."""

FIELD_COVERAGE_VALUES: frozenset[str] = frozenset({"present", "partial", "absent"})
"""Per-field coverage states in :attr:`Coverage.fields`."""

COMPLETENESS_VALUES: frozenset[str] = frozenset({"complete", "incomplete"})
"""Run-level completeness. ``incomplete`` is a scan state, never rendered as clean."""

TIERS: frozenset[str] = frozenset({"proven", "projected", "unresolved"})
"""Claim tiers for :class:`Finding`."""

CONFIDENCES: frozenset[str] = frozenset({"low", "medium", "high"})
"""Confidence labels for :class:`Finding`."""

TOKEN_BASIS_INPUT_INCLUDES_CACHE_READ = "input_includes_cache_read"
TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ = "input_excludes_cache_read"
KNOWN_TOKEN_BASES: frozenset[str] = frozenset(
    {TOKEN_BASIS_INPUT_INCLUDES_CACHE_READ, TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ}
)
"""Documented ``Event.token_basis`` values. Loaders may emit other strings;
``None`` means the basis is unknown and the counts are comparable to nothing."""

COVERED_EVENT_FIELDS: dict[str, frozenset[str]] = {
    "start_ms": frozenset({"model_call", "tool_call", "approval", "aggregate", "other"}),
    "end_ms": frozenset({"model_call", "tool_call", "approval", "aggregate", "other"}),
    "seq": frozenset({"model_call", "tool_call", "approval", "aggregate", "other"}),
    "parent_id": frozenset({"model_call", "tool_call", "approval", "aggregate", "other"}),
    "model": frozenset({"model_call", "aggregate"}),
    "provider": frozenset({"model_call", "aggregate"}),
    "token_basis": frozenset({"model_call", "aggregate"}),
    "tokens_in": frozenset({"model_call", "aggregate"}),
    "tokens_out": frozenset({"model_call", "aggregate"}),
    "cache_read_tokens": frozenset({"model_call", "aggregate"}),
    "finish_reason": frozenset({"model_call"}),
    "tool_call_id": frozenset({"tool_call", "approval"}),
    "args_fingerprint": frozenset({"tool_call"}),
    "result_fingerprint": frozenset({"tool_call"}),
    "result_bytes": frozenset({"tool_call"}),
    "error_type": frozenset({"model_call", "tool_call"}),
}
"""Event fields whose coverage is tracked, and the kinds they apply to."""


def _check(value: str, allowed: frozenset[str], what: str) -> None:
    if value not in allowed:
        raise ValueError(f"{what} must be one of {sorted(allowed)}, got {value!r}")


def _check_optional_int(value: Any, what: str) -> None:
    if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
        raise TypeError(f"{what} must be an int or None, got {type(value).__name__}")


# --- Fingerprint -----------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Fingerprint:
    """SHA-256 over canonical JSON, labelled by how much of the value it covers.

    ``hash`` is lowercase hex. ``representation`` is ``full`` only when the
    whole model-visible value was hashed; ``redacted`` and ``truncated``
    fingerprints are kept for provenance but never support equality claims
    (see :func:`agentlint.fingerprint.fingerprints_equal`).
    """

    hash: str
    representation: str

    def __post_init__(self) -> None:
        _check(self.representation, REPRESENTATIONS, "Fingerprint.representation")
        if not self.hash or any(c not in "0123456789abcdef" for c in self.hash):
            raise ValueError("Fingerprint.hash must be non-empty lowercase hex")

    def to_dict(self) -> dict[str, Any]:
        return {"hash": self.hash, "representation": self.representation}

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Fingerprint:
        return cls(hash=data["hash"], representation=data["representation"])


def _fingerprint_or_none(data: Mapping[str, Any] | None) -> Fingerprint | None:
    return None if data is None else Fingerprint.from_dict(data)


# --- Event -----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Event:
    """One operation in a run (plan §2.4).

    ``id`` is the *source identity*: the span ID, observation ID or row ID the
    loader found in the export. ``source_locator`` says where in which file it
    came from (evidence). ``tool_call_id`` is the application-level call ID
    while ``native_tool_call_id`` is the provider's ID; they are never merged
    into one another. ``result_bytes`` is the UTF-8 length of the model-visible
    result; ``preview_bytes`` is the length of whatever preview the export kept.
    ``scope`` is a namespaced extension (``{"namespace": {...}}``) that generic
    rules never read.
    """

    id: str
    source_locator: str
    kind: str
    status: str = "unknown"
    parent_id: str | None = None
    seq: int | None = None
    name: str | None = None
    model: str | None = None
    provider: str | None = None
    adapter: str | None = None
    token_basis: str | None = None
    start_ms: int | None = None
    end_ms: int | None = None
    duration_ms: int | None = None
    error_type: str | None = None
    error_code: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    tokens_total: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None
    finish_reason: str | None = None
    tool_call_id: str | None = None
    native_tool_call_id: str | None = None
    args_fingerprint: Fingerprint | None = None
    result_fingerprint: Fingerprint | None = None
    result_bytes: int | None = None
    preview_bytes: int | None = None
    scope: dict[str, dict[str, Any]] = field(default_factory=dict)
    included_result_ids: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.id:
            raise ValueError("Event.id must be non-empty")
        _check(self.kind, EVENT_KINDS, "Event.kind")
        _check(self.status, EVENT_STATUSES, "Event.status")
        for name in (
            "seq",
            "start_ms",
            "end_ms",
            "duration_ms",
            "tokens_in",
            "tokens_out",
            "tokens_total",
            "cache_read_tokens",
            "cache_write_tokens",
            "result_bytes",
            "preview_bytes",
        ):
            _check_optional_int(getattr(self, name), f"Event.{name}")
        for namespace, values in self.scope.items():
            if not isinstance(namespace, str) or not isinstance(values, Mapping):
                raise TypeError("Event.scope must map namespace strings to mappings")

    @property
    def sort_key(self) -> tuple[int, int, int, int, str]:
        """Ordering key ``(start_ms, seq, id)``; absent values sort after present ones."""
        return (
            self.start_ms is None,
            self.start_ms if self.start_ms is not None else 0,
            self.seq is None,
            self.seq if self.seq is not None else 0,
            self.id,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source_locator": self.source_locator,
            "kind": self.kind,
            "status": self.status,
            "parent_id": self.parent_id,
            "seq": self.seq,
            "name": self.name,
            "model": self.model,
            "provider": self.provider,
            "adapter": self.adapter,
            "token_basis": self.token_basis,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "duration_ms": self.duration_ms,
            "error_type": self.error_type,
            "error_code": self.error_code,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "tokens_total": self.tokens_total,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "finish_reason": self.finish_reason,
            "tool_call_id": self.tool_call_id,
            "native_tool_call_id": self.native_tool_call_id,
            "args_fingerprint": (
                None if self.args_fingerprint is None else self.args_fingerprint.to_dict()
            ),
            "result_fingerprint": (
                None if self.result_fingerprint is None else self.result_fingerprint.to_dict()
            ),
            "result_bytes": self.result_bytes,
            "preview_bytes": self.preview_bytes,
            "scope": {ns: dict(values) for ns, values in self.scope.items()},
            "included_result_ids": list(self.included_result_ids),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Event:
        return cls(
            id=data["id"],
            source_locator=data["source_locator"],
            kind=data["kind"],
            status=data.get("status", "unknown"),
            parent_id=data.get("parent_id"),
            seq=data.get("seq"),
            name=data.get("name"),
            model=data.get("model"),
            provider=data.get("provider"),
            adapter=data.get("adapter"),
            token_basis=data.get("token_basis"),
            start_ms=data.get("start_ms"),
            end_ms=data.get("end_ms"),
            duration_ms=data.get("duration_ms"),
            error_type=data.get("error_type"),
            error_code=data.get("error_code"),
            tokens_in=data.get("tokens_in"),
            tokens_out=data.get("tokens_out"),
            tokens_total=data.get("tokens_total"),
            cache_read_tokens=data.get("cache_read_tokens"),
            cache_write_tokens=data.get("cache_write_tokens"),
            finish_reason=data.get("finish_reason"),
            tool_call_id=data.get("tool_call_id"),
            native_tool_call_id=data.get("native_tool_call_id"),
            args_fingerprint=_fingerprint_or_none(data.get("args_fingerprint")),
            result_fingerprint=_fingerprint_or_none(data.get("result_fingerprint")),
            result_bytes=data.get("result_bytes"),
            preview_bytes=data.get("preview_bytes"),
            scope={ns: dict(values) for ns, values in (data.get("scope") or {}).items()},
            included_result_ids=list(data.get("included_result_ids") or []),
        )


def sort_events(events: Iterable[Event]) -> list[Event]:
    """Return events ordered by ``(start_ms, seq, id)``.

    Concurrency is not sequence: two events with equal ``start_ms`` and no
    ``seq`` are ordered by ``id`` only so the output is deterministic; no
    causal order is implied.
    """
    return sorted(events, key=lambda e: e.sort_key)


# --- Coverage --------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CoverageNote:
    """A coverage or abstention note attached to a run.

    ``code`` is a stable machine-readable label (for example
    ``dedup_conflict`` or ``mixed_token_basis``); ``fields`` names the event
    fields involved; ``rule_id`` is set when a rule abstained; ``event_ids``
    cite the original identifiers involved.
    """

    code: str
    message: str
    fields: list[str] = field(default_factory=list)
    rule_id: str | None = None
    event_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "fields": list(self.fields),
            "rule_id": self.rule_id,
            "event_ids": list(self.event_ids),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> CoverageNote:
        return cls(
            code=data["code"],
            message=data["message"],
            fields=list(data.get("fields") or []),
            rule_id=data.get("rule_id"),
            event_ids=list(data.get("event_ids") or []),
        )


@dataclass(frozen=True, slots=True)
class Coverage:
    """What the source provided, per field and per run.

    ``fields`` maps an event field name to ``present`` (every applicable event
    has it), ``partial`` (some do) or ``absent`` (none do). ``events_total``
    counts surviving events after dedup and ``events_dropped_dedup`` counts
    the duplicates that were collapsed; both are ``None`` until normalization
    has run. ``completeness`` is ``incomplete`` whenever ``reasons`` is
    non-empty or ``truncated`` is set.
    """

    fields: dict[str, str] = field(default_factory=dict)
    events_total: int | None = None
    events_dropped_dedup: int | None = None
    truncated: bool = False
    truncation_notes: list[str] = field(default_factory=list)
    completeness: str = "complete"
    reasons: list[str] = field(default_factory=list)
    notes: list[CoverageNote] = field(default_factory=list)

    def __post_init__(self) -> None:
        _check(self.completeness, COMPLETENESS_VALUES, "Coverage.completeness")
        for name, state in self.fields.items():
            _check(state, FIELD_COVERAGE_VALUES, f"Coverage.fields[{name!r}]")
        _check_optional_int(self.events_total, "Coverage.events_total")
        _check_optional_int(self.events_dropped_dedup, "Coverage.events_dropped_dedup")

    def to_dict(self) -> dict[str, Any]:
        return {
            "fields": {k: self.fields[k] for k in sorted(self.fields)},
            "events_total": self.events_total,
            "events_dropped_dedup": self.events_dropped_dedup,
            "truncated": self.truncated,
            "truncation_notes": list(self.truncation_notes),
            "completeness": self.completeness,
            "reasons": list(self.reasons),
            "notes": [n.to_dict() for n in self.notes],
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Coverage:
        return cls(
            fields=dict(data.get("fields") or {}),
            events_total=data.get("events_total"),
            events_dropped_dedup=data.get("events_dropped_dedup"),
            truncated=bool(data.get("truncated", False)),
            truncation_notes=list(data.get("truncation_notes") or []),
            completeness=data.get("completeness", "complete"),
            reasons=list(data.get("reasons") or []),
            notes=[CoverageNote.from_dict(n) for n in data.get("notes") or []],
        )


def field_coverage(events: Iterable[Event]) -> dict[str, str]:
    """Compute per-field ``present|partial|absent`` over the applicable events.

    A field is judged only against events of the kinds it applies to (see
    :data:`COVERED_EVENT_FIELDS`); a run with no applicable events reports the
    field as ``absent``. Never reads ``scope``.
    """
    events = list(events)
    result: dict[str, str] = {}
    for name, kinds in COVERED_EVENT_FIELDS.items():
        applicable = [e for e in events if e.kind in kinds]
        have = sum(1 for e in applicable if getattr(e, name) is not None)
        if not applicable or have == 0:
            result[name] = "absent"
        elif have == len(applicable):
            result[name] = "present"
        else:
            result[name] = "partial"
    return result


# --- Run -------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Run:
    """One agent run as seen through one or more source files.

    ``events`` should be kept sorted by ``(start_ms, seq, id)``; use
    :meth:`sorted_events` or :func:`agentlint.dedup.normalize_run`.
    ``raw_records`` keeps the loader's source records verbatim for evidence.
    """

    id: str
    source_format: str
    conversation_id: str | None = None
    source_refs: list[str] = field(default_factory=list)
    started_at: int | None = None
    ended_at: int | None = None
    coverage: Coverage = field(default_factory=Coverage)
    events: list[Event] = field(default_factory=list)
    raw_records: list[Any] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.id:
            raise ValueError("Run.id must be non-empty")
        _check_optional_int(self.started_at, "Run.started_at")
        _check_optional_int(self.ended_at, "Run.ended_at")

    def sorted_events(self) -> list[Event]:
        """Events ordered by ``(start_ms, seq, id)`` without mutating the run."""
        return sort_events(self.events)

    def with_sorted_events(self) -> Run:
        """A copy of this run whose ``events`` are in canonical order."""
        return replace_run(self, events=self.sorted_events())

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "conversation_id": self.conversation_id,
            "source_format": self.source_format,
            "source_refs": list(self.source_refs),
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "coverage": self.coverage.to_dict(),
            "events": [e.to_dict() for e in self.events],
            "raw_records": list(self.raw_records),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Run:
        return cls(
            id=data["id"],
            source_format=data["source_format"],
            conversation_id=data.get("conversation_id"),
            source_refs=list(data.get("source_refs") or []),
            started_at=data.get("started_at"),
            ended_at=data.get("ended_at"),
            coverage=Coverage.from_dict(data.get("coverage") or {}),
            events=[Event.from_dict(e) for e in data.get("events") or []],
            raw_records=list(data.get("raw_records") or []),
        )


def replace_run(run: Run, **changes: Any) -> Run:
    """``dataclasses.replace`` for :class:`Run` that re-runs validation."""
    values = {
        "id": run.id,
        "source_format": run.source_format,
        "conversation_id": run.conversation_id,
        "source_refs": run.source_refs,
        "started_at": run.started_at,
        "ended_at": run.ended_at,
        "coverage": run.coverage,
        "events": run.events,
        "raw_records": run.raw_records,
    }
    values.update(changes)
    return Run(**values)


# --- Finding ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Evidence:
    """A citation of original identifiers backing a finding.

    ``event_id`` and ``source_locator`` come straight from the event; ``field``
    names the attribute looked at, ``value`` is the value observed (a number
    or short excerpt, never content), ``note`` is free text.
    """

    event_id: str
    source_locator: str
    field: str | None = None
    value: Any = None
    note: str | None = None

    @property
    def locator(self) -> str:
        """The locator used in :func:`finding_fingerprint`."""
        return f"{self.event_id}@{self.source_locator}#{self.field or ''}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "source_locator": self.source_locator,
            "field": self.field,
            "value": self.value,
            "note": self.note,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Evidence:
        return cls(
            event_id=data["event_id"],
            source_locator=data["source_locator"],
            field=data.get("field"),
            value=data.get("value"),
            note=data.get("note"),
        )


def canonical_json(value: Any) -> str:
    """Canonical JSON text: sorted keys, no whitespace, arrays in order, types kept."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def finding_fingerprint(
    rule_id: str, run_id: str, evidence: Iterable[Evidence], thresholds: Mapping[str, Any]
) -> str:
    """Stable SHA-256 over ``(rule_id, run_id, sorted evidence locators, thresholds)``.

    Evidence order does not matter; threshold values do. The result is suitable
    as a dedup / baseline key. It never includes evidence values or content.
    """
    payload = canonical_json(
        {
            "rule_id": rule_id,
            "run_id": run_id,
            "evidence": sorted(e.locator for e in evidence),
            "thresholds": {k: thresholds[k] for k in sorted(thresholds)},
        }
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class Finding:
    """A rule's evidence-backed claim about a run (plan §2.4).

    ``thresholds`` records the configured values the rule used, so a reader
    can tell why something did or did not fire. ``fingerprint`` is computed
    from ``(rule_id, run_id, evidence locators, thresholds)`` when not given.
    """

    rule_id: str
    title: str
    category: str
    tier: str
    confidence: str
    run_id: str
    observed_pattern: str
    impact: str | None = None
    evidence: list[Evidence] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)
    thresholds: dict[str, Any] = field(default_factory=dict)
    fingerprint: str = ""

    def __post_init__(self) -> None:
        _check(self.tier, TIERS, "Finding.tier")
        _check(self.confidence, CONFIDENCES, "Finding.confidence")
        if not self.fingerprint:
            object.__setattr__(
                self,
                "fingerprint",
                finding_fingerprint(self.rule_id, self.run_id, self.evidence, self.thresholds),
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "title": self.title,
            "category": self.category,
            "tier": self.tier,
            "confidence": self.confidence,
            "run_id": self.run_id,
            "observed_pattern": self.observed_pattern,
            "impact": self.impact,
            "evidence": [e.to_dict() for e in self.evidence],
            "limitations": list(self.limitations),
            "thresholds": {k: self.thresholds[k] for k in sorted(self.thresholds)},
            "fingerprint": self.fingerprint,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Finding:
        return cls(
            rule_id=data["rule_id"],
            title=data["title"],
            category=data["category"],
            tier=data["tier"],
            confidence=data["confidence"],
            run_id=data["run_id"],
            observed_pattern=data["observed_pattern"],
            impact=data.get("impact"),
            evidence=[Evidence.from_dict(e) for e in data.get("evidence") or []],
            limitations=list(data.get("limitations") or []),
            thresholds=dict(data.get("thresholds") or {}),
            fingerprint=data.get("fingerprint") or "",
        )


def to_json(value: Run | Event | Coverage | Finding | Mapping[str, Any]) -> str:
    """Deterministic pretty JSON: sorted keys, two-space indent, UTF-8 kept."""
    data = value.to_dict() if hasattr(value, "to_dict") else value
    return json.dumps(data, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
