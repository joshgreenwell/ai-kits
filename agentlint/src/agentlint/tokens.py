"""Token-basis tracking and comparable-call selection (plan §2.5 rule 3).

Token counts from different sources measure different things: one export's
``tokens_in`` includes cache reads, another's excludes them. ``Event.token_basis``
records which; this module only ever compares or sums counts that share a
basis *and* a model.

What this module never does:

* never sums token counts across different bases;
* never adds an aggregate's usage to the usage of its child model calls;
* never compares an event whose ``token_basis`` is ``None`` with anything;
* never reads app-specific scope beyond the configured tag namespace.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from agentlint.model import CoverageNote, Event, Run

DEFAULT_EXCLUDED_OPERATION_NAMES: tuple[str, ...] = (
    "route",
    "router",
    "routing",
    "retrieve",
    "retrieval",
    "retriever",
    "rerank",
    "reranker",
    "embed",
    "embedding",
    "embeddings",
    "compact",
    "compaction",
)
"""Operation-name words that mark a model call as routing / retrieval / compaction."""

DEFAULT_EXCLUDED_TAGS: tuple[str, ...] = ("routing", "retrieval", "compaction")
"""App tags (in ``scope[tag_namespace]["tags"]``) that exclude a model call."""

DEFAULT_TAG_NAMESPACE = "agentlint"
"""Scope namespace whose ``tags`` list loaders populate with neutral app tags."""

_WORD = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True, slots=True)
class TokenConfig:
    """Configuration for comparable-call selection; visible in JSON output."""

    excluded_operation_names: tuple[str, ...] = DEFAULT_EXCLUDED_OPERATION_NAMES
    excluded_tags: tuple[str, ...] = DEFAULT_EXCLUDED_TAGS
    tag_namespace: str = DEFAULT_TAG_NAMESPACE

    def to_dict(self) -> dict[str, Any]:
        """The exclusion lists, sorted, for inclusion in JSON output."""
        return {
            "excluded_operation_names": sorted(self.excluded_operation_names),
            "excluded_tags": sorted(self.excluded_tags),
            "tag_namespace": self.tag_namespace,
        }


DEFAULT_TOKEN_CONFIG = TokenConfig()


def event_tags(event: Event, config: TokenConfig = DEFAULT_TOKEN_CONFIG) -> list[str]:
    """Neutral tags a loader attached under ``scope[config.tag_namespace]["tags"]``."""
    namespace = event.scope.get(config.tag_namespace) or {}
    tags = namespace.get("tags")
    if not isinstance(tags, list):
        return []
    return [str(t) for t in tags]


def exclusion_reason(event: Event, config: TokenConfig = DEFAULT_TOKEN_CONFIG) -> str | None:
    """Why ``event`` is excluded from the main context series, or ``None``.

    Matches whole lowercase words of ``event.name`` against
    ``excluded_operation_names`` and the event's tags against ``excluded_tags``.
    """
    if event.name:
        words = set(_WORD.findall(event.name.lower()))
        hit = sorted(words & set(config.excluded_operation_names))
        if hit:
            return f"operation_name:{hit[0]}"
    tags = set(event_tags(event, config))
    hit = sorted(tags & set(config.excluded_tags))
    if hit:
        return f"tag:{hit[0]}"
    return None


@dataclass(frozen=True, slots=True)
class Series:
    """Consecutive comparable model calls sharing one ``token_basis`` and ``model``."""

    token_basis: str
    model: str | None
    events: list[Event]
    is_aggregate: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "token_basis": self.token_basis,
            "model": self.model,
            "event_ids": [e.id for e in self.events],
            "is_aggregate": self.is_aggregate,
        }


@dataclass(frozen=True, slots=True)
class Selection:
    """Result of :func:`select_comparable`: the series plus what was left out and why."""

    series: list[Series]
    excluded: dict[str, str] = field(default_factory=dict)
    notes: list[CoverageNote] = field(default_factory=list)
    config: TokenConfig = DEFAULT_TOKEN_CONFIG

    def to_dict(self) -> dict[str, Any]:
        return {
            "series": [s.to_dict() for s in self.series],
            "excluded": {k: self.excluded[k] for k in sorted(self.excluded)},
            "notes": [n.to_dict() for n in self.notes],
            "exclusions": self.config.to_dict(),
        }


def _descendant_model_calls(root: Event, events: Iterable[Event]) -> list[Event]:
    """Model calls whose ``parent_id`` chain reaches ``root`` (or that it lists as included)."""
    by_id = {e.id: e for e in events}
    included = set(root.included_result_ids)
    result: list[Event] = []
    for e in by_id.values():
        if e.kind != "model_call":
            continue
        if e.id in included:
            result.append(e)
            continue
        seen: set[str] = set()
        parent = e.parent_id
        while parent is not None and parent not in seen:
            if parent == root.id:
                result.append(e)
                break
            seen.add(parent)
            parent = by_id[parent].parent_id if parent in by_id else None
    return result


def _has_model_call_children(aggregate: Event, events: list[Event]) -> bool:
    return bool(_descendant_model_calls(aggregate, events))


def _candidates(run: Run, config: TokenConfig) -> tuple[list[Event], dict[str, str], bool]:
    """Model calls (or aggregates, if no model calls) in canonical order.

    Excluded routing / retrieval / compaction calls and unused aggregates are
    left out and named in the returned ``excluded`` map. Calls without a
    ``token_basis`` stay in the list (also named in ``excluded``) so callers
    can treat them as series boundaries.
    """
    events = run.sorted_events()
    model_calls = [e for e in events if e.kind == "model_call"]
    aggregates = [e for e in events if e.kind == "aggregate"]
    excluded: dict[str, str] = {}
    use_aggregates = not model_calls and bool(aggregates)

    pool: list[Event] = []
    for e in aggregates:
        if _has_model_call_children(e, events):
            excluded[e.id] = "aggregate_with_children"
        elif use_aggregates:
            pool.append(e)
        else:
            excluded[e.id] = "aggregate_not_used"
    pool.extend(model_calls)

    candidates: list[Event] = []
    for e in sorted(pool, key=lambda ev: ev.sort_key):
        reason = exclusion_reason(e, config)
        if reason is not None:
            excluded[e.id] = reason
            continue
        if e.token_basis is None:
            excluded[e.id] = "token_basis_absent"
        candidates.append(e)
    return candidates, excluded, use_aggregates


def select_comparable(run: Run, config: TokenConfig = DEFAULT_TOKEN_CONFIG) -> Selection:
    """Split the run's main context series into comparable runs of model calls.

    A new series starts whenever ``token_basis`` or ``model`` changes between
    consecutive candidates. Routing / retrieval / compaction calls are
    excluded by name or tag and do not interrupt a series; aggregates are
    excluded whenever a child model call exists and used (flagged
    ``is_aggregate``) only when the run has no model calls at all. A model
    call without a basis is comparable to nothing: it is excluded *and*
    terminates the series it sits in, so no comparison reaches across it.
    """
    candidates, excluded, use_aggregates = _candidates(run, config)
    series: list[Series] = []
    open_series = False
    for e in candidates:
        if e.token_basis is None:
            # A main-series call with unknown basis is a gap: nothing on either
            # side of it is compared across it.
            open_series = False
            continue
        key = (e.token_basis, e.model)
        if open_series and (series[-1].token_basis, series[-1].model) == key:
            series[-1].events.append(e)
        else:
            open_series = True
            series.append(
                Series(
                    token_basis=e.token_basis or "",
                    model=e.model,
                    events=[e],
                    is_aggregate=use_aggregates,
                )
            )
    return Selection(
        series=series, excluded=excluded, notes=token_basis_notes(run, config), config=config
    )


def comparable_model_calls(
    run: Run, config: TokenConfig = DEFAULT_TOKEN_CONFIG
) -> list[list[Event]]:
    """The comparable series of :func:`select_comparable` as plain event lists.

    Each inner list shares one ``token_basis`` and one ``model``; a change in
    either splits the series. Events without a basis never appear.
    """
    return [list(s.events) for s in select_comparable(run, config).series]


def token_basis_notes(run: Run, config: TokenConfig = DEFAULT_TOKEN_CONFIG) -> list[CoverageNote]:
    """Coverage notes about token bases: mixed bases and calls without a basis."""
    calls = [
        e
        for e in run.sorted_events()
        if e.kind == "model_call" and exclusion_reason(e, config) is None
    ]
    notes: list[CoverageNote] = []
    bases = sorted({e.token_basis for e in calls if e.token_basis is not None})
    if len(bases) > 1:
        notes.append(
            CoverageNote(
                code="mixed_token_basis",
                message=(
                    "run mixes token bases "
                    + ", ".join(bases)
                    + "; token counts are compared and totalled per basis only, "
                    "never across the boundary"
                ),
                fields=["token_basis", "tokens_in", "tokens_out"],
                event_ids=[e.id for e in calls if e.token_basis is not None],
            )
        )
    without = [e.id for e in calls if e.token_basis is None]
    if without:
        notes.append(
            CoverageNote(
                code="token_basis_absent",
                message=(
                    f"{len(without)} model call(s) have no token_basis; "
                    "their token counts are comparable to nothing"
                ),
                fields=["token_basis"],
                event_ids=without,
            )
        )
    return notes


# --- Per-basis totals ------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TokenTotals:
    """Sums for one basis. A sum is ``None`` when no event contributed to it."""

    token_basis: str
    calls: int
    tokens_in: int | None = None
    tokens_out: int | None = None
    tokens_total: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None
    is_aggregate: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "token_basis": self.token_basis,
            "calls": self.calls,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "tokens_total": self.tokens_total,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "is_aggregate": self.is_aggregate,
        }


def _sum_or_none(values: Iterable[int | None]) -> int | None:
    present = [v for v in values if v is not None]
    return sum(present) if present else None


def token_totals_by_basis(
    run: Run, config: TokenConfig = DEFAULT_TOKEN_CONFIG
) -> dict[str, TokenTotals]:
    """Token totals keyed by ``token_basis``; bases are never summed together.

    Uses the same candidate set as :func:`select_comparable`, so aggregates
    contribute only when the run has no child model calls, and excluded
    routing / retrieval / compaction calls do not count. Events without a
    basis are omitted (see :func:`calls_without_token_basis`).
    """
    candidates, _excluded, use_aggregates = _candidates(run, config)
    result: dict[str, TokenTotals] = {}
    for basis in sorted({e.token_basis for e in candidates if e.token_basis is not None}):
        group = [e for e in candidates if e.token_basis == basis]
        result[basis] = TokenTotals(
            token_basis=basis,
            calls=len(group),
            tokens_in=_sum_or_none(e.tokens_in for e in group),
            tokens_out=_sum_or_none(e.tokens_out for e in group),
            tokens_total=_sum_or_none(e.tokens_total for e in group),
            cache_read_tokens=_sum_or_none(e.cache_read_tokens for e in group),
            cache_write_tokens=_sum_or_none(e.cache_write_tokens for e in group),
            is_aggregate=use_aggregates,
        )
    return result


def calls_without_token_basis(run: Run, config: TokenConfig = DEFAULT_TOKEN_CONFIG) -> list[str]:
    """IDs of non-excluded model calls whose ``token_basis`` is ``None``."""
    _, excluded, _ = _candidates(run, config)
    return sorted(eid for eid, reason in excluded.items() if reason == "token_basis_absent")
