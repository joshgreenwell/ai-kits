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


RULE_FIXTURES = FIXTURES / "rules"
FIXTURE_METADATA_KEYS = ("origin", "ref", "completeness", "excerpt_or_raw")


def load_rule_fixture(name: str) -> dict[str, Any]:
    """Read ``tests/fixtures/rules/<name>.json`` and check its ``_fixture`` header.

    Every rule fixture is synthetic and says so: the header must declare
    ``origin``, ``ref``, ``completeness`` and ``excerpt_or_raw``.
    """
    with (RULE_FIXTURES / f"{name}.json").open(encoding="utf-8") as handle:
        data = json.load(handle)
    header = data["_fixture"]
    missing = [k for k in FIXTURE_METADATA_KEYS if k not in header]
    assert not missing, f"{name}: fixture header lacks {missing}"
    assert header["origin"] == "synthetic", f"{name}: fixtures must be synthetic"
    return data


def load_rule_run(name: str, normalize: bool = True) -> Run:
    """The :class:`Run` of a rule fixture (``Run.from_dict``), normalized unless told not to."""
    from agentlint.dedup import normalize_run

    run = Run.from_dict(load_rule_fixture(name)["run"])
    return normalize_run(run) if normalize else run


_BUNDLE_EVENT_KEYS = (
    "kind",
    "name",
    "status",
    "seq",
    "model",
    "token_basis",
    "tokens_in",
    "tokens_out",
    "error_type",
    "error_code",
    "result_bytes",
)


def load_bundle_run(name: str) -> Run:
    """Turn a record-bundle-like rule fixture into a normalized :class:`Run`.

    This is a deliberately small stand-in for the record-bundle loader: every
    record becomes one event whose ``id`` is the record's ``row_id`` and
    whose ``source_locator`` is the record's ``locator``; app fields under
    the ``exampleapp`` key become ``Event.scope["exampleapp"]``; the records
    themselves are kept verbatim as ``raw_records``.
    """
    from agentlint.dedup import normalize_run

    bundle = load_rule_fixture(name)["bundle"]
    events = []
    for record in bundle["records"]:
        values: dict[str, Any] = {
            "id": record["row_id"],
            "source_locator": record["locator"],
            "args_fingerprint": record.get("args_fingerprint"),
            "result_fingerprint": record.get("result_fingerprint"),
            "scope": {"exampleapp": record["exampleapp"]} if "exampleapp" in record else {},
        }
        for key in _BUNDLE_EVENT_KEYS:
            if key in record:
                values[key] = record[key]
        events.append(Event.from_dict(values))
    run = Run(
        id=bundle["run"]["id"],
        source_format=bundle["run"]["source_format"],
        events=events,
        raw_records=list(bundle["records"]),
    )
    return normalize_run(run)


@pytest.fixture
def mixed_basis_fixture() -> dict[str, Any]:
    """The synthetic mixed-token-basis run fixture, with its metadata header."""
    with (FIXTURES / "run_mixed_basis.json").open(encoding="utf-8") as handle:
        return json.load(handle)
