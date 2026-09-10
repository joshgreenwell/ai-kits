"""``docs/integration.md`` must stay true: its record-bundle example is executed here.

The guide tells an integrator to save one Python block, run it, and get a
bundle that loads with a stated coverage and analyses with a stated exit
code. This test extracts that very block from the Markdown — located by a
stable marker comment on its first line, so an edit that moves or renames it
fails loudly instead of silently testing nothing — runs it in a temporary
directory, and asserts exactly what the guide claims.
"""

from __future__ import annotations

import json
import runpy
from pathlib import Path

import pytest

from agentlint.loaders import record_bundle
from tests.conftest import run_cli

DOC = Path(__file__).resolve().parents[1] / "docs" / "integration.md"
MARKER = "# agentlint-docs: record-bundle-example"
FENCE_OPEN = "```python"
FENCE_CLOSE = "```"

EXPECTED_PRESENT = {
    "args_fingerprint",
    "end_ms",
    "finish_reason",
    "model",
    "provider",
    "result_bytes",
    "result_fingerprint",
    "seq",
    "start_ms",
    "token_basis",
    "tokens_in",
    "tokens_out",
    "tool_call_id",
}
EXPECTED_ABSENT = {"cache_read_tokens", "error_type", "parent_id"}
EXPECTED_EVENTS = 6
EXPECTED_RUN_ID = "acme-run-3f9c"
EXPECTED_FINDING = "NO_PROGRESS_CYCLE"
EXPECTED_EXIT_CODE = 0


def python_blocks(text: str) -> list[str]:
    """Every fenced ``python`` block of ``text``, in order, fences excluded."""
    blocks: list[str] = []
    current: list[str] | None = None
    for line in text.splitlines():
        if current is None:
            if line.strip() == FENCE_OPEN:
                current = []
        elif line.strip() == FENCE_CLOSE:
            blocks.append("\n".join(current) + "\n")
            current = None
        else:
            current.append(line)
    return blocks


def marked_block() -> str:
    """The one example block whose first line is :data:`MARKER`."""
    text = DOC.read_text(encoding="utf-8")
    matching = [b for b in python_blocks(text) if b.splitlines()[:1] == [MARKER]]
    if len(matching) != 1:
        pytest.fail(
            f"{DOC}: expected exactly one ```python block starting with {MARKER!r}, "
            f"found {len(matching)}. The record-bundle example is executed by this "
            "test; restore the marker as the block's first line (or update MARKER "
            "here) so the guide cannot drift from the tool."
        )
    return matching[0]


@pytest.fixture
def emitted_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Run the guide's example script in ``tmp_path`` and return the bundle it wrote."""
    script = tmp_path / "emit_bundle.py"
    script.write_text(marked_block(), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    runpy.run_path(str(script), run_name="__main__")
    bundle = tmp_path / "bundle.json"
    assert bundle.is_file(), "the example script must write bundle.json next to it"
    return bundle


def test_example_bundle_loads_with_the_coverage_the_guide_claims(emitted_bundle: Path) -> None:
    result = record_bundle.load(emitted_bundle)
    assert result.errors == []
    assert len(result.runs) == 1
    run = result.runs[0]
    assert run.id == EXPECTED_RUN_ID
    assert run.source_format == "record-bundle"
    assert run.conversation_id == "acme-conv-0b21"
    assert len(run.events) == EXPECTED_EVENTS
    assert run.coverage.completeness == "complete"
    assert run.coverage.reasons == []
    fields = run.coverage.fields
    assert {name for name, state in fields.items() if state == "present"} == EXPECTED_PRESENT
    assert {name for name, state in fields.items() if state == "absent"} == EXPECTED_ABSENT
    assert not [name for name, state in fields.items() if state == "partial"]


def test_example_records_keep_source_identity_and_carry_no_content(
    emitted_bundle: Path,
) -> None:
    document = json.loads(emitted_bundle.read_text(encoding="utf-8"))
    assert document["schema_version"] == "1"
    assert [r["id"] for r in document["records"]] == [
        f"dbg-900{n}" for n in range(1, EXPECTED_EVENTS + 1)
    ]
    for record in document["records"]:
        assert None not in record.values(), f"{record['id']}: absent means omit the key"
        assert set(record["scope"]) == {"acme"}, "app data must be namespaced"
        for key in ("args_fingerprint", "result_fingerprint"):
            if key in record:
                assert record[key]["representation"] == "full"
                assert len(record[key]["hash"]) == 64


def test_analyze_of_the_example_bundle_exits_with_the_documented_code(
    emitted_bundle: Path,
) -> None:
    result = run_cli("analyze", str(emitted_bundle), "--format", "json")
    assert result.code == EXPECTED_EXIT_CODE, result.out
    document = result.json()
    assert document["summary"]["exit_code"] == EXPECTED_EXIT_CODE
    assert document["summary"]["incomplete"] is False
    assert len(document["runs"]) == 1
    analysed = document["runs"][0]
    assert analysed["incomplete_for_rules"] == []
    assert analysed["abstentions"] == []
    assert analysed["errors"] == []
    assert [f["rule_id"] for f in analysed["findings"]] == [EXPECTED_FINDING]
    finding = analysed["findings"][0]
    assert finding["tier"] == "proven"
    cited = {e["event_id"] for e in finding["evidence"]}
    assert cited == {"dbg-9002", "dbg-9004", "dbg-9006"}
    locators = {e["source_locator"] for e in finding["evidence"]}
    assert all(loc.startswith("acme/debug-report/3f9c/rows/") for loc in locators)
