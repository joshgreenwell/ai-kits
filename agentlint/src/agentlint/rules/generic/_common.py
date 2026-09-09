"""Small pure helpers shared by the generic rules.

Everything here works on identifiers, numbers and hashes only. Nothing reads
``Event.scope`` beyond the neutral tag namespace, and nothing reads content.
"""

from __future__ import annotations

from typing import Any

from agentlint.fingerprint import fingerprints_equal
from agentlint.model import Event, Evidence, Fingerprint, canonical_json

HASH_EXCERPT = 12


def claimable(fp: Fingerprint | None) -> bool:
    """True when ``fp`` can back an equality claim: present, ``full`` and not a placeholder."""
    return fingerprints_equal(fp, fp)
"""How many hex characters of a fingerprint hash the output quotes."""


def short_hash(hash_hex: str | None) -> str:
    """A readable excerpt of a hash for messages (never used for equality)."""
    if not hash_hex:
        return "absent"
    return hash_hex[:HASH_EXCERPT] + "…"


def interval(event: Event) -> tuple[int, int] | None:
    """``(start_ms, end_ms)`` when both bounds are known, else ``None``.

    The end is ``end_ms`` when present, otherwise ``start_ms + duration_ms``.
    """
    if event.start_ms is None:
        return None
    if event.end_ms is not None:
        return event.start_ms, event.end_ms
    if event.duration_ms is not None:
        return event.start_ms, event.start_ms + event.duration_ms
    return None


def strictly_after(earlier: Event, later: Event) -> bool:
    """True when ``later`` demonstrably begins after ``earlier`` ends.

    Uses intervals when both events have them (``later.start >= earlier.end``);
    falls back to ``seq`` when both carry one; otherwise makes no claim and
    returns ``False``. Overlapping intervals (fan-out) are never "after".
    """
    a, b = interval(earlier), interval(later)
    if a is not None and b is not None:
        return b[0] >= a[1]
    if earlier.seq is not None and later.seq is not None:
        return later.seq > earlier.seq
    return False


def begins_between(event: Event, earlier: Event, later: Event) -> bool:
    """True when ``event`` starts after ``earlier`` ends and before ``later`` starts."""
    e, a, b = interval(event), interval(earlier), interval(later)
    if e is not None and a is not None and b is not None:
        return a[1] <= e[0] < b[0]
    if event.seq is not None and earlier.seq is not None and later.seq is not None:
        return earlier.seq < event.seq < later.seq
    return False


def scope_key(event: Event) -> str:
    """Canonical text of ``event.scope`` used only to compare scopes for equality.

    The text is never stored, printed or interpreted; two events with the
    same key have byte-identical scope.
    """
    return canonical_json(event.scope)


def cite(event: Event, field: str | None = None, value: Any = None, note: str | None = None):
    """An :class:`Evidence` item citing ``event``'s original identifiers."""
    return Evidence(
        event_id=event.id,
        source_locator=event.source_locator,
        field=field,
        value=value,
        note=note,
    )
