"""End-to-end negative-control suite (JG-135, plan §2.10).

Every directory under ``tests/e2e/`` is one control: a small synthetic input
(record bundle, OTLP JSON / JSONL, Langfuse page or Claude session log) plus
an ``expected.json`` sidecar that declares the fixture-hygiene header and
what the CLI must report::

    {
      "_fixture": {"origin": "synthetic", "ref": "...", "completeness": "...",
                   "excerpt_or_raw": "..."},
      "inputs": ["bundle.json"],                 # optional; default: every non-sidecar file, sorted
      "args": ["--config", "{dir}/agentlint.toml"],  # optional extra CLI arguments
      "exit_code": 0,
      "findings": ["RULE_ID", ...],              # rule IDs of every finding, across all runs
      "incomplete_for_rules": [...],             # per run
      "coverage_completeness": "complete" | "incomplete" | null (no run loaded),
      "checks": { ... optional named assertions, see ``_apply_checks`` ... }
    }

One parametrised test enumerates the directory, so a control cannot be
added without being run, and every control is exercised through
``agentlint.cli.main`` with ``--format json`` — the real entry point, not the
rule functions — and asserted to be byte-identical across two invocations.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tests.conftest import FIXTURE_METADATA_KEYS, CliResult, run_cli

E2E_DIR = Path(__file__).resolve().parent
EXPECTED_NAME = "expected.json"
NON_INPUT_SUFFIXES = {".toml"}


def case_directories() -> list[Path]:
    """Every control directory (one ``expected.json`` each), sorted by name."""
    return sorted(p for p in E2E_DIR.iterdir() if p.is_dir() and (p / EXPECTED_NAME).is_file())


CASES = case_directories()


def load_expected(case: Path) -> dict[str, Any]:
    with (case / EXPECTED_NAME).open(encoding="utf-8") as handle:
        return json.load(handle)


def input_paths(case: Path, expected: dict[str, Any]) -> list[str]:
    names = expected.get("inputs")
    if names is None:
        names = sorted(
            p.name
            for p in case.iterdir()
            if p.is_file() and p.name != EXPECTED_NAME and p.suffix not in NON_INPUT_SUFFIXES
        )
    return [str(case / name) for name in names]


def cli_args(case: Path, expected: dict[str, Any]) -> list[str]:
    extra = [arg.replace("{dir}", str(case)) for arg in expected.get("args", [])]
    return ["analyze", *input_paths(case, expected), "--format", "json", *extra]


def analyze_case(case: Path, expected: dict[str, Any]) -> CliResult:
    return run_cli(*cli_args(case, expected))


# --- Named checks ------------------------------------------------------------


def _single_run(document: dict[str, Any]) -> dict[str, Any]:
    assert len(document["runs"]) == 1, [r["run"]["id"] for r in document["runs"]]
    return document["runs"][0]


def _strip(value: Any, keys: set[str]) -> Any:
    if isinstance(value, dict):
        return {k: _strip(v, keys) for k, v in value.items() if k not in keys}
    if isinstance(value, list):
        return [_strip(v, keys) for v in value]
    return value


def _apply_checks(document: dict[str, Any], output: str, checks: dict[str, Any]) -> None:
    """Assert every named check in ``checks`` against the JSON document.

    Unknown check names fail loudly so a typo in ``expected.json`` cannot
    silently pass.
    """
    for name, wanted in checks.items():
        if name == "runs":
            assert [r["run"]["id"] for r in document["runs"]] == wanted
        elif name == "events_total":
            assert _single_run(document)["coverage"]["events_total"] == wanted
        elif name == "events_dropped_dedup":
            assert _single_run(document)["coverage"]["events_dropped_dedup"] == wanted
        elif name == "abstention_fields":
            notes = _single_run(document)["abstentions"]
            for rule_id, fields in wanted.items():
                named = {f for n in notes if n["rule_id"] == rule_id for f in n["fields"]}
                assert set(fields) <= named, (rule_id, fields, notes)
        elif name == "coverage_note_codes":
            codes = {n["code"] for n in _single_run(document)["coverage"]["notes"]}
            assert set(wanted) <= codes, (wanted, codes)
        elif name == "coverage_reasons_contain":
            reasons = "\n".join(_single_run(document)["coverage"]["reasons"])
            for text in wanted:
                assert text in reasons, (text, reasons)
        elif name == "truncation_notes_contain":
            notes = "\n".join(_single_run(document)["coverage"]["truncation_notes"])
            for text in wanted:
                assert text in notes, (text, notes)
        elif name == "coverage_fields":
            fields = _single_run(document)["coverage"]["fields"]
            for field, state in wanted.items():
                assert fields[field] == state, (field, fields)
        elif name == "event_fields":
            events = {e["id"]: e for r in document["runs"] for e in r["run"]["events"]}
            for event_id, values in wanted.items():
                assert event_id in events, (event_id, sorted(events))
                for field, value in values.items():
                    assert events[event_id][field] == value, (event_id, field, events[event_id])
        elif name == "finding_evidence_counts":
            for rule_id, count in wanted.items():
                findings = [
                    f for r in document["runs"] for f in r["findings"] if f["rule_id"] == rule_id
                ]
                assert [len(f["evidence"]) for f in findings] == [count], findings
        elif name == "finding_tiers":
            for rule_id, tier in wanted.items():
                tiers = {
                    f["tier"]
                    for r in document["runs"]
                    for f in r["findings"]
                    if f["rule_id"] == rule_id
                }
                assert tiers == {tier}, (rule_id, tiers)
        elif name == "output_contains":
            for text in wanted:
                assert text in output, text
        elif name == "incomplete_reason_contains":
            reasons = "\n".join(item["reason"] for item in document["incomplete"])
            for text in wanted:
                assert text in reasons, (text, reasons)
        elif name == "identical_runs_ignoring":
            keys = set(wanted)
            stripped = [
                _strip(
                    {k: r[k] for k in ("run", "coverage", "findings", "abstentions", "stats")}, keys
                )
                for r in document["runs"]
            ]
            assert len(stripped) >= 2
            for other in stripped[1:]:
                assert other == stripped[0]
        else:
            raise AssertionError(f"unknown check {name!r} in {EXPECTED_NAME}")


# --- Tests -----------------------------------------------------------------


def test_suite_is_not_empty() -> None:
    assert len(CASES) >= 20, [c.name for c in CASES]


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_expected_sidecar_declares_the_hygiene_header(case: Path) -> None:
    expected = load_expected(case)
    header = expected["_fixture"]
    missing = [k for k in FIXTURE_METADATA_KEYS if not header.get(k)]
    assert not missing, f"{case.name}: header lacks {missing}"
    assert header["origin"] == "synthetic"
    assert header["completeness"] in {"complete", "incomplete"}
    assert header["excerpt_or_raw"] in {"raw", "excerpt"}
    for key in ("exit_code", "findings", "incomplete_for_rules", "coverage_completeness"):
        assert key in expected, f"{case.name}: {EXPECTED_NAME} lacks {key}"
    assert expected["coverage_completeness"] in {"complete", "incomplete", None}


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_control_through_the_cli(case: Path) -> None:
    expected = load_expected(case)
    first = analyze_case(case, expected)
    second = analyze_case(case, expected)

    assert first.out == second.out, f"{case.name}: output is not byte-deterministic"
    assert first.code == expected["exit_code"], (case.name, first.code, first.err, first.out[:2000])

    document = first.json()
    assert document["summary"]["exit_code"] == expected["exit_code"]

    findings = sorted(f["rule_id"] for r in document["runs"] for f in r["findings"])
    assert findings == sorted(expected["findings"]), (case.name, findings)

    for run in document["runs"]:
        assert run["incomplete_for_rules"] == sorted(expected["incomplete_for_rules"]), (
            case.name,
            run["incomplete_for_rules"],
            run["abstentions"],
        )
        assert run["coverage"]["completeness"] == expected["coverage_completeness"], (
            case.name,
            run["coverage"],
        )
    if expected["coverage_completeness"] is None:
        assert document["runs"] == []
    else:
        assert document["runs"], case.name

    _apply_checks(document, first.out, expected.get("checks", {}))


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_default_output_carries_no_content(case: Path) -> None:
    """Without ``--include-snippets`` nothing from the raw records reaches the output."""
    expected = load_expected(case)
    result = analyze_case(case, expected)
    document = result.json()
    assert document["options"]["include_snippets"] is False
    assert all("snippets" not in run for run in document["runs"])
    assert "SYNTHETIC-" not in result.out  # Langfuse io content sentinels
    assert "synthetic search terms" not in result.out  # tool arguments (hashed, never copied)


def test_healthy_run_is_the_honest_negative() -> None:
    """The healthy control exits 0 with every generic rule run fully and no abstention."""
    case = E2E_DIR / "healthy_run"
    result = analyze_case(case, load_expected(case))
    run = _single_run(result.json())
    assert result.code == 0
    assert run["findings"] == [] and run["abstentions"] == [] and run["errors"] == []
    assert run["summary"] is None
    assert set(run["rules_run"]) == set(run["thresholds"]) and len(run["rules_run"]) == 5
    text = run_cli("analyze", str(case / "bundle.json")).out
    assert "Findings: none (coverage complete)" in text
    assert "exit code 0" in text


def test_positive_controls_cover_every_generic_rule() -> None:
    """The suite proves every shipped rule can fire, not only that it stays quiet."""
    from agentlint.rules.generic import GENERIC_RULE_IDS

    fired: set[str] = set()
    for case in CASES:
        fired.update(load_expected(case)["findings"])
    assert set(GENERIC_RULE_IDS) <= fired, set(GENERIC_RULE_IDS) - fired
