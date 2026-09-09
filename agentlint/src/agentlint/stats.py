"""Run statistics for the ``analyze`` output (plan §2.8): numbers, never findings.

The stats block describes a run in counts and distributions: how many
events of each kind and status, how long they took (min / p50 / p90 / max
per kind, plus the slowest event's ID), and token totals per basis (never
summed across bases, via :func:`agentlint.tokens.token_totals_by_basis`).
The slowest event per kind is exactly the kind of "latency outlier" value
the plan keeps as a statistic: it is reported here as a number with an
identifier, and no rule ever turns it into a finding.

What this module never does:

* never turns an absent duration into ``0`` — a kind with no measurable
  event reports ``null`` for every percentile;
* never emits a finding, a score or a judgement;
* never reads content or ``Event.scope``.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from agentlint.model import EVENT_KINDS, EVENT_STATUSES, Event, Run
from agentlint.tokens import DEFAULT_TOKEN_CONFIG, TokenConfig, token_totals_by_basis

PERCENTILES: tuple[int, ...] = (50, 90)


def event_duration_ms(event: Event) -> int | None:
    """``duration_ms`` when recorded, else ``end_ms - start_ms`` when both exist, else ``None``."""
    if event.duration_ms is not None:
        return event.duration_ms
    if event.start_ms is not None and event.end_ms is not None:
        return event.end_ms - event.start_ms
    return None


def percentile(values: Sequence[int], p: int) -> int | None:
    """Nearest-rank percentile of integer ``values`` (``None`` for an empty sequence).

    Deterministic and interpolation-free: the result is always one of the
    input values, so it can be traced back to an event.
    """
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[rank - 1]


@dataclass(frozen=True, slots=True)
class LatencyStats:
    """Duration distribution over the events of one kind that have a duration."""

    kind: str
    events: int
    measured: int
    min_ms: int | None = None
    p50_ms: int | None = None
    p90_ms: int | None = None
    max_ms: int | None = None
    slowest_event_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "events": self.events,
            "measured": self.measured,
            "min_ms": self.min_ms,
            "p50_ms": self.p50_ms,
            "p90_ms": self.p90_ms,
            "max_ms": self.max_ms,
            "slowest_event_id": self.slowest_event_id,
        }


def latency_stats(events: Iterable[Event]) -> list[LatencyStats]:
    """One :class:`LatencyStats` per event kind present, in kind-name order."""
    events = list(events)
    result: list[LatencyStats] = []
    for kind in sorted(EVENT_KINDS):
        of_kind = [e for e in events if e.kind == kind]
        if not of_kind:
            continue
        measured = [(event_duration_ms(e), e.id) for e in of_kind]
        measured = [(d, i) for d, i in measured if d is not None]
        durations = [d for d, _ in measured]
        slowest = max(measured, key=lambda m: (m[0], m[1]))[1] if measured else None
        result.append(
            LatencyStats(
                kind=kind,
                events=len(of_kind),
                measured=len(measured),
                min_ms=min(durations) if durations else None,
                p50_ms=percentile(durations, 50),
                p90_ms=percentile(durations, 90),
                max_ms=max(durations) if durations else None,
                slowest_event_id=slowest,
            )
        )
    return result


@dataclass(frozen=True, slots=True)
class RunStats:
    """Counts, latency distribution and per-basis token totals for one run."""

    events_total: int | None
    events_dropped_dedup: int | None
    by_kind: dict[str, int] = field(default_factory=dict)
    by_status: dict[str, int] = field(default_factory=dict)
    errors: int = 0
    latency: list[LatencyStats] = field(default_factory=list)
    tokens_by_basis: list[dict[str, Any]] = field(default_factory=list)
    calls_without_token_basis: int = 0
    span_ms: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "events_total": self.events_total,
            "events_dropped_dedup": self.events_dropped_dedup,
            "by_kind": {k: self.by_kind[k] for k in sorted(self.by_kind)},
            "by_status": {k: self.by_status[k] for k in sorted(self.by_status)},
            "errors": self.errors,
            "latency": [s.to_dict() for s in self.latency],
            "tokens_by_basis": list(self.tokens_by_basis),
            "calls_without_token_basis": self.calls_without_token_basis,
            "span_ms": self.span_ms,
        }


def run_stats(run: Run, config: TokenConfig = DEFAULT_TOKEN_CONFIG) -> RunStats:
    """Compute the stats block for ``run``; pure, deterministic, content-free.

    ``by_kind`` / ``by_status`` count events over the closed vocabularies
    (kinds and statuses that do not occur are omitted). ``span_ms`` is
    ``ended_at - started_at`` when both are known. Token totals are per basis
    only; model calls without a basis are counted, never summed.
    """
    events = run.sorted_events()
    by_kind = {k: sum(1 for e in events if e.kind == k) for k in sorted(EVENT_KINDS)}
    by_status = {s: sum(1 for e in events if e.status == s) for s in sorted(EVENT_STATUSES)}
    totals = token_totals_by_basis(run, config)
    without_basis = sum(1 for e in events if e.kind == "model_call" and e.token_basis is None)
    span = (
        run.ended_at - run.started_at
        if run.started_at is not None and run.ended_at is not None
        else None
    )
    return RunStats(
        events_total=run.coverage.events_total,
        events_dropped_dedup=run.coverage.events_dropped_dedup,
        by_kind={k: v for k, v in by_kind.items() if v},
        by_status={k: v for k, v in by_status.items() if v},
        errors=by_status.get("error", 0),
        latency=latency_stats(events),
        tokens_by_basis=[totals[b].to_dict() for b in sorted(totals)],
        calls_without_token_basis=without_basis,
        span_ms=span,
    )
