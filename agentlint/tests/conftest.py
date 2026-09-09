"""Shared synthetic builders for the agentlint test suite.

Everything here is invented: identifiers are short hex strings chosen for
readability, never copied from a real trace.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agentlint.model import Event, Run

FIXTURES = Path(__file__).parent / "fixtures"


def make_event(id: str, kind: str = "model_call", **overrides: Any) -> Event:
    """A synthetic event with a locator derived from its id (test data only)."""
    values: dict[str, Any] = {
        "id": id,
        "source_locator": f"synthetic.json#events[{id}]",
        "kind": kind,
    }
    values.update(overrides)
    return Event(**values)


def make_run(*events: Event, id: str = "run-0001", **overrides: Any) -> Run:
    """A synthetic run wrapping ``events`` (unsorted, un-normalized)."""
    values: dict[str, Any] = {"id": id, "source_format": "record-bundle", "events": list(events)}
    values.update(overrides)
    return Run(**values)


@pytest.fixture
def mixed_basis_fixture() -> dict[str, Any]:
    """The synthetic mixed-token-basis run fixture, with its metadata header."""
    with (FIXTURES / "run_mixed_basis.json").open(encoding="utf-8") as handle:
        return json.load(handle)
