"""Deduplication by source identity and ``tool_call_id`` (plan §2.5 rule 1).

A streamed event, a durable row and a resumed report may all describe one
operation. This module collapses them into one :class:`Event`, keeps the
richer field set, records conflicts as coverage notes and counts what was
dropped. Multi-file input is merged by run ID *before* dedup.

What this module never does:

* never merges two events with different ``tool_call_id`` values, however
  similar their arguments — they may be legitimate fan-out;
* never merges events of different kinds that share a ``tool_call_id`` (an
  approval and the tool call it approved are two events);
* never invents an ID: the surviving event keeps its own ``id``; the dropped
  IDs are cited in a coverage note;
* never drops ``raw_records``.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import fields as dataclass_fields
from typing import Any

from agentlint.model import Coverage, CoverageNote, Event, Run, field_coverage, sort_events
from agentlint.tokens import DEFAULT_TOKEN_CONFIG, TokenConfig, token_basis_notes

_IDENTITY_FIELDS = frozenset({"id", "source_locator", "kind", "scope", "included_result_ids"})
_MERGEABLE_FIELDS: tuple[str, ...] = tuple(
    f.name for f in dataclass_fields(Event) if f.name not in _IDENTITY_FIELDS
)


def richness(event: Event) -> int:
    """Number of informative fields: non-``None`` attributes plus ``unknown``-free status."""
    score = sum(1 for name in _MERGEABLE_FIELDS if getattr(event, name) is not None)
    if event.status == "unknown":
        score -= 1
    return score + len(event.scope) + len(event.included_result_ids)


def merge_events(a: Event, b: Event) -> tuple[Event, list[str]]:
    """Merge two records of one operation; the richer wins, the other fills gaps.

    Returns the merged event and the names of fields where both records had a
    value and the values disagreed (the richer record's value is kept).
    """
    base, other = (a, b) if richness(a) >= richness(b) else (b, a)
    values: dict[str, Any] = {}
    conflicts: list[str] = []
    for name in _MERGEABLE_FIELDS:
        bv, ov = getattr(base, name), getattr(other, name)
        if name == "status":
            values[name] = bv if bv != "unknown" else ov
            if bv != "unknown" and ov != "unknown" and bv != ov:
                conflicts.append(name)
            continue
        if bv is None:
            values[name] = ov
        else:
            values[name] = bv
            if ov is not None and ov != bv:
                conflicts.append(name)
    scope: dict[str, dict[str, Any]] = {ns: dict(v) for ns, v in other.scope.items()}
    for ns, v in base.scope.items():
        scope[ns] = {**scope.get(ns, {}), **v}
    included = list(base.included_result_ids)
    included.extend(x for x in other.included_result_ids if x not in included)
    merged = Event(
        id=base.id,
        source_locator=base.source_locator,
        kind=base.kind,
        scope=scope,
        included_result_ids=included,
        **values,
    )
    return merged, sorted(conflicts)


def _find(parent: dict[str, str], x: str) -> str:
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def dedup_events(events: Iterable[Event]) -> tuple[list[Event], int, list[CoverageNote]]:
    """Collapse records that share source identity or ``(kind, tool_call_id)``.

    Returns the surviving events in canonical order, the number of dropped
    duplicates, and coverage notes citing merged IDs and conflicting fields.
    Two events with different ``tool_call_id`` values are never merged.
    """
    ordered = sort_events(events)
    parent = {i: i for i in range(len(ordered))}
    by_id: dict[str, int] = {}
    by_call: dict[tuple[str, str], int] = {}
    for i, e in enumerate(ordered):
        if e.id in by_id:
            parent[_find(parent, i)] = _find(parent, by_id[e.id])
        else:
            by_id[e.id] = i
        if e.tool_call_id is not None:
            key = (e.kind, e.tool_call_id)
            if key in by_call:
                parent[_find(parent, i)] = _find(parent, by_call[key])
            else:
                by_call[key] = i

    groups: dict[int, list[Event]] = {}
    for i, e in enumerate(ordered):
        groups.setdefault(_find(parent, i), []).append(e)

    survivors: list[Event] = []
    notes: list[CoverageNote] = []
    dropped = 0
    for root in sorted(groups):
        members = groups[root]
        merged = members[0]
        conflicts: set[str] = set()
        for other in members[1:]:
            merged, found = merge_events(merged, other)
            conflicts.update(found)
        survivors.append(merged)
        if len(members) > 1:
            dropped += len(members) - 1
            merged_ids = sorted(m.id for m in members if m.id != merged.id)
            same_id = len(members) - 1 - len(merged_ids)
            parts = []
            if merged_ids:
                parts.append("merged " + ", ".join(merged_ids))
            if same_id:
                parts.append(f"collapsed {same_id} record(s) with the same id")
            notes.append(
                CoverageNote(
                    code="dedup_merged",
                    message=f"event {merged.id}: " + "; ".join(parts),
                    event_ids=[merged.id, *merged_ids],
                )
            )
            if conflicts:
                notes.append(
                    CoverageNote(
                        code="dedup_conflict",
                        message=(
                            f"event {merged.id}: duplicate records disagree on "
                            + ", ".join(sorted(conflicts))
                            + "; the richer record's values were kept"
                        ),
                        fields=sorted(conflicts),
                        event_ids=[merged.id, *merged_ids],
                    )
                )
    return sort_events(survivors), dropped, notes


def _min_or_none(values: Iterable[int | None]) -> int | None:
    present = [v for v in values if v is not None]
    return min(present) if present else None


def _max_or_none(values: Iterable[int | None]) -> int | None:
    present = [v for v in values if v is not None]
    return max(present) if present else None


def _extend_unique(target: list[str], items: Iterable[str]) -> None:
    for item in items:
        if item not in target:
            target.append(item)


def merge_runs(runs: Iterable[Run]) -> list[Run]:
    """Merge runs that share an ``id`` (multi-file / multi-page input).

    Events, raw records, source refs and coverage notes are concatenated;
    ``started_at`` / ``ended_at`` take the min / max; a disagreement on
    ``conversation_id`` or ``source_format`` keeps the first value and adds a
    coverage note. Runs come back in first-seen order, not yet deduplicated.
    """
    merged: dict[str, Run] = {}
    order: list[str] = []
    for run in runs:
        if run.id not in merged:
            merged[run.id] = run
            order.append(run.id)
            continue
        first = merged[run.id]
        notes = [*first.coverage.notes, *run.coverage.notes]
        reasons = list(first.coverage.reasons)
        _extend_unique(reasons, run.coverage.reasons)
        truncation_notes = list(first.coverage.truncation_notes)
        _extend_unique(truncation_notes, run.coverage.truncation_notes)
        conversation_id = first.conversation_id
        if conversation_id is None:
            conversation_id = run.conversation_id
        elif run.conversation_id is not None and run.conversation_id != conversation_id:
            notes.append(
                CoverageNote(
                    code="merge_conflict",
                    message=f"run {run.id}: sources disagree on conversation_id; kept the first",
                    fields=["conversation_id"],
                )
            )
        if run.source_format != first.source_format:
            notes.append(
                CoverageNote(
                    code="merge_conflict",
                    message=(
                        f"run {run.id}: sources disagree on source_format "
                        f"({first.source_format} vs {run.source_format}); kept the first"
                    ),
                    fields=["source_format"],
                )
            )
        source_refs = list(first.source_refs)
        _extend_unique(source_refs, run.source_refs)
        coverage = Coverage(
            fields={},
            truncated=first.coverage.truncated or run.coverage.truncated,
            truncation_notes=truncation_notes,
            completeness="complete",
            reasons=reasons,
            notes=notes,
        )
        merged[run.id] = Run(
            id=run.id,
            source_format=first.source_format,
            conversation_id=conversation_id,
            source_refs=source_refs,
            started_at=_min_or_none([first.started_at, run.started_at]),
            ended_at=_max_or_none([first.ended_at, run.ended_at]),
            coverage=coverage,
            events=[*first.events, *run.events],
            raw_records=[*first.raw_records, *run.raw_records],
        )
    return [merged[i] for i in order]


def normalize_run(run: Run, config: TokenConfig = DEFAULT_TOKEN_CONFIG) -> Run:
    """Dedup, sort and fill coverage for one run.

    Sets ``events_total``, ``events_dropped_dedup`` and per-field coverage,
    appends dedup and token-basis notes, and derives ``completeness`` from
    ``reasons`` and ``truncated``. Loader-supplied reasons, truncation notes
    and notes are kept. Idempotent: normalizing twice changes nothing.
    """
    events, dropped, dedup_notes = dedup_events(run.events)
    interim = Run(id=run.id, source_format=run.source_format, events=events)
    existing_codes = {(n.code, n.message) for n in run.coverage.notes}
    new_notes = [
        n
        for n in [*dedup_notes, *token_basis_notes(interim, config)]
        if (n.code, n.message) not in existing_codes
    ]
    reasons = list(run.coverage.reasons)
    if run.coverage.truncated and "truncated" not in reasons:
        reasons.append("truncated")
    previous_dropped = run.coverage.events_dropped_dedup or 0
    coverage = Coverage(
        fields=field_coverage(events),
        events_total=len(events),
        events_dropped_dedup=previous_dropped + dropped,
        truncated=run.coverage.truncated,
        truncation_notes=list(run.coverage.truncation_notes),
        completeness="incomplete" if reasons else "complete",
        reasons=reasons,
        notes=[*run.coverage.notes, *new_notes],
    )
    return Run(
        id=run.id,
        source_format=run.source_format,
        conversation_id=run.conversation_id,
        source_refs=list(run.source_refs),
        started_at=run.started_at,
        ended_at=run.ended_at,
        coverage=coverage,
        events=events,
        raw_records=list(run.raw_records),
    )


def normalize_runs(runs: Iterable[Run], config: TokenConfig = DEFAULT_TOKEN_CONFIG) -> list[Run]:
    """Merge multi-file input by run ID, then :func:`normalize_run` each run."""
    return [normalize_run(r, config) for r in merge_runs(runs)]
