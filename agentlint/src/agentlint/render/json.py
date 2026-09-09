"""JSON renderer: the full analysis document, byte-deterministic.

Sorted keys, two-space indent, fixed separators, UTF-8 kept, one trailing
newline. Identical input produces identical bytes; nothing here depends on
time, environment or dictionary insertion order.
"""

from __future__ import annotations

import json as _json
from typing import Any


def render_json(document: dict[str, Any]) -> str:
    """Serialise ``document`` deterministically; never adds or drops a key."""
    return (
        _json.dumps(
            document,
            sort_keys=True,
            indent=2,
            separators=(",", ": "),
            ensure_ascii=False,
            allow_nan=False,
        )
        + "\n"
    )
