"""Shared loader contract (plan §2.3).

Every loader module exposes:

* ``FORMAT_LABEL: str`` — the format label recorded in ``Run.source_format``.
* ``detect(path) -> bool`` — cheap shape sniff on one file; never raises.
* ``load(paths, config=None) -> LoadResult`` — parse one or more files or a
  directory, merge runs by run ID, normalize, and report anything it could not
  parse in ``errors``. Loaders never read files outside ``paths``, never touch
  the network, and never copy content into the model (hashes, counts, sizes and
  identifiers only).

Parse problems that leave a run usable are recorded on that run's coverage
(``reasons`` / ``truncation_notes`` / ``notes``) and mark it ``incomplete``.
Input that yields no run at all is a :class:`LoadError` (the CLI maps
"no runs and at least one error" to exit code 3).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from agentlint.model import Run


@dataclass(frozen=True, slots=True)
class LoadError:
    """One input the loader could not turn into a run."""

    path: str
    reason: str
    locator: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"path": self.path, "reason": self.reason, "locator": self.locator}

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> LoadError:
        return cls(path=data["path"], reason=data["reason"], locator=data.get("locator"))


@dataclass(slots=True)
class LoadResult:
    """What a loader returns: normalized runs plus anything it had to give up on."""

    format_label: str
    runs: list[Run] = field(default_factory=list)
    errors: list[LoadError] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "format_label": self.format_label,
            "runs": [run.to_dict() for run in self.runs],
            "errors": [error.to_dict() for error in self.errors],
        }
