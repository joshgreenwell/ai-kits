"""TL-B2 (JG-122): OTLP JSON Lines loader, multi-file merge, bad-line tolerance."""

from __future__ import annotations

import builtins
import json
import pathlib
from pathlib import Path
from typing import Any

import pytest

from agentlint.loaders import otlp_json, otlp_jsonl
from agentlint.model import Run, to_json
from tests.conftest import FIXTURES

JSONL = FIXTURES / "otlp" / "jsonl"
PART1 = JSONL / "split_part1.jsonl"
PART2 = JSONL / "split_part2.jsonl"
BAD_LINE = JSONL / "bad_line.jsonl"


def _only_run(result: Any) -> Run:
    assert result.errors == [], result.errors
    assert len(result.runs) == 1
    return result.runs[0]


def _envelope_line(*spans: dict[str, Any]) -> str:
    envelope = {
        "resourceSpans": [{"resource": {"attributes": []}, "scopeSpans": [{"spans": list(spans)}]}]
    }
    return json.dumps(envelope, separators=(",", ":")) + "\n"


def _chat(trace: str, span_id: str, conversation: str, start_s: int) -> dict[str, Any]:
    return {
        "traceId": trace,
        "spanId": span_id,
        "name": "chat model-a",
        "startTimeUnixNano": str(1_700_000_000_000_000_000 + start_s * 1_000_000_000),
        "endTimeUnixNano": str(1_700_000_000_000_000_000 + (start_s + 1) * 1_000_000_000),
        "attributes": [
            {"key": "gen_ai.operation.name", "value": {"stringValue": "chat"}},
            {"key": "gen_ai.conversation.id", "value": {"stringValue": conversation}},
            {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "10"}},
            {"key": "gen_ai.usage.output_tokens", "value": {"intValue": "1"}},
        ],
        "status": {"code": 1},
    }


class TestContractAndConvention:
    def test_format_label(self) -> None:
        assert otlp_jsonl.FORMAT_LABEL == "otlp-jsonl"
        assert _only_run(otlp_jsonl.load(PART1)).source_format == "otlp-jsonl"

    def test_sidecar_metadata_declares_synthetic_origin(self) -> None:
        for path in (PART1, PART2, BAD_LINE):
            meta = json.loads(path.with_suffix(".meta.json").read_text(encoding="utf-8"))
            assert meta["origin"] == "synthetic"
            assert set(meta) >= {"origin", "ref", "completeness", "excerpt_or_raw"}

    def test_detect_accepts_line_delimited_envelopes(self) -> None:
        assert otlp_jsonl.detect(PART1)
        assert otlp_jsonl.detect(str(BAD_LINE))  # first line is fine

    def test_detect_rejects_pretty_json_sidecars_and_missing_files(self, tmp_path: Path) -> None:
        assert not otlp_jsonl.detect(FIXTURES / "otlp" / "gen_current.json")  # pretty-printed
        assert not otlp_jsonl.detect(PART1.with_suffix(".meta.json"))
        assert not otlp_jsonl.detect(tmp_path / "missing.jsonl")
        assert not otlp_jsonl.detect(tmp_path)
        assert not otlp_json.detect(PART1)  # the JSON loader leaves JSONL alone

    def test_blank_lines_and_trailing_newline_are_tolerated(self) -> None:
        text = PART1.read_text(encoding="utf-8")
        assert "\n\n" in text and text.endswith("\n")
        run = _only_run(otlp_jsonl.load(PART1))
        assert sorted(e.id for e in run.events) == [
            "000000000000f001",
            "000000000000f002",
            "000000000000f003",
        ]
        assert run.coverage.completeness == "complete"

    def test_missing_trailing_newline_still_loads(self, tmp_path: Path) -> None:
        path = tmp_path / "no_newline.jsonl"
        line = _envelope_line(_chat("0000000000000000000000000000b001", "0000000000000b01", "c", 0))
        path.write_text(line.rstrip("\n"), encoding="utf-8")
        assert otlp_jsonl.detect(path)
        run = _only_run(otlp_jsonl.load(path))
        assert [e.id for e in run.events] == ["0000000000000b01"]

    def test_locators_carry_file_line_and_json_pointer(self) -> None:
        run = _only_run(otlp_jsonl.load(PART1))
        locators = {e.id: e.source_locator for e in run.events}
        assert locators["000000000000f001"] == f"{PART1}:1#/resourceSpans/0/scopeSpans/0/spans/0"
        assert locators["000000000000f002"] == f"{PART1}:1#/resourceSpans/0/scopeSpans/0/spans/1"
        assert locators["000000000000f003"] == f"{PART1}:3#/resourceSpans/0/scopeSpans/0/spans/0"

    def test_compact_single_line_file_loads_identically_in_both_loaders(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "single.json"
        path.write_text(
            _envelope_line(_chat("0000000000000000000000000000b002", "0000000000000b02", "c", 0))
        )
        assert otlp_json.detect(path) and otlp_jsonl.detect(path)
        as_json = _only_run(otlp_json.load(path)).to_dict()
        as_jsonl = _only_run(otlp_jsonl.load(path)).to_dict()
        as_json.pop("source_format")
        as_jsonl.pop("source_format")
        as_json["events"][0].pop("source_locator")
        as_jsonl["events"][0].pop("source_locator")
        as_json["raw_records"][0].pop("source_locator")
        as_jsonl["raw_records"][0].pop("source_locator")
        assert as_json == as_jsonl


class TestMultiFileMerge:
    def test_run_split_across_files_lands_in_one_run(self) -> None:
        run = _only_run(otlp_jsonl.load([PART1, PART2]))
        assert run.id == "conv-0007" and run.conversation_id == "conv-0007"
        assert run.source_refs == [str(PART1), str(PART2)]
        kinds = {e.id: e.kind for e in run.events}
        assert kinds == {
            "000000000000f001": "aggregate",
            "000000000000f002": "model_call",
            "000000000000f003": "tool_call",
            "000000000000f004": "model_call",
        }
        assert run.coverage.events_total == 4
        assert run.coverage.completeness == "complete"

    def test_rotation_overlap_is_deduplicated_and_counted(self) -> None:
        run = _only_run(otlp_jsonl.load([PART1, PART2]))
        assert run.coverage.events_dropped_dedup == 1
        assert [e.id for e in run.events].count("000000000000f003") == 1
        note = next(n for n in run.coverage.notes if n.code == "dedup_merged")
        assert note.event_ids == ["000000000000f003"]
        assert not any(n.code == "dedup_conflict" for n in run.coverage.notes)
        # Both copies stay in raw_records as evidence; the run keeps both files.
        assert sum(1 for r in run.raw_records if r["span"]["spanId"] == "000000000000f003") == 2
        tool = next(e for e in run.events if e.id == "000000000000f003")
        assert tool.status == "ok" and tool.result_bytes is not None

    def test_directory_input_merges_and_ignores_sidecars(self) -> None:
        result = otlp_jsonl.load(JSONL)
        assert result.errors == []
        by_id = {r.id: r for r in result.runs}
        assert set(by_id) == {"conv-0007", "conv-0008"}
        assert by_id["conv-0007"].source_refs == [str(PART1), str(PART2)]
        assert by_id["conv-0007"].coverage.events_dropped_dedup == 1
        assert by_id["conv-0008"].source_refs == [str(BAD_LINE)]
        assert all(".meta.json" not in ref for run in result.runs for ref in run.source_refs)

    def test_file_order_does_not_change_the_events(self) -> None:
        forward = _only_run(otlp_jsonl.load([PART1, PART2]))
        reverse = _only_run(otlp_jsonl.load([PART2, PART1]))

        def without_locator(run: Run) -> list[dict[str, Any]]:
            # The surviving copy of the overlapped span cites whichever file came first.
            return [
                {k: v for k, v in e.to_dict().items() if k != "source_locator"} for e in run.events
            ]

        assert without_locator(forward) == without_locator(reverse)
        assert forward.coverage.events_dropped_dedup == reverse.coverage.events_dropped_dedup


class TestBadLines:
    def test_bad_line_is_a_truncation_note_and_marks_the_run_incomplete(self) -> None:
        run = _only_run(otlp_jsonl.load(BAD_LINE))
        assert run.coverage.completeness == "incomplete"
        assert len(run.coverage.truncation_notes) == 1
        note = run.coverage.truncation_notes[0]
        assert note.startswith(f"{BAD_LINE}:2: line 2 is not valid JSON")
        assert note in run.coverage.reasons
        assert run.coverage.truncated is False  # a bad line is not an export cut-off

    def test_other_lines_still_load(self) -> None:
        run = _only_run(otlp_jsonl.load(BAD_LINE))
        assert [e.id for e in run.events] == ["000000000000f101", "000000000000f102"]
        assert all(e.tokens_in is not None for e in run.events)

    def test_bad_line_marks_every_run_of_that_file(self, tmp_path: Path) -> None:
        path = tmp_path / "two_runs.jsonl"
        path.write_text(
            _envelope_line(_chat("0000000000000000000000000000b003", "0000000000000b03", "r1", 0))
            + "not json at all\n"
            + _envelope_line(
                _chat("0000000000000000000000000000b004", "0000000000000b04", "r2", 2)
            ),
            encoding="utf-8",
        )
        result = otlp_jsonl.load(path)
        assert result.errors == []
        assert [r.id for r in result.runs] == ["r1", "r2"]
        for run in result.runs:
            assert run.coverage.completeness == "incomplete"
            assert run.coverage.truncation_notes == [
                f"{path}:2: line 2 is not valid JSON (Expecting value); line skipped"
            ]

    def test_file_with_no_loadable_line_is_a_load_error(self, tmp_path: Path) -> None:
        path = tmp_path / "garbage.jsonl"
        path.write_text("{oops\n\n{again\n", encoding="utf-8")
        result = otlp_jsonl.load(path)
        assert result.runs == []
        assert [(e.path, e.locator) for e in result.errors] == [(str(path), f"{path}:1")]

    def test_line_that_is_not_an_envelope_is_a_problem_not_a_crash(self, tmp_path: Path) -> None:
        path = tmp_path / "mixed.jsonl"
        path.write_text(
            _envelope_line(_chat("0000000000000000000000000000b005", "0000000000000b05", "r5", 0))
            + '["an array, not an envelope"]\n'
            + '{"resourceLogs": []}\n',
            encoding="utf-8",
        )
        run = _only_run(otlp_jsonl.load(path))
        assert run.coverage.completeness == "incomplete"
        assert run.coverage.reasons == [
            f"{path}:2#: envelope is not an object",
            f"{path}:3#: envelope has no resourceSpans",
        ]
        assert run.coverage.truncation_notes == []

    def test_missing_path_and_empty_directory_are_load_errors(self, tmp_path: Path) -> None:
        result = otlp_jsonl.load([tmp_path / "nowhere.jsonl", tmp_path])
        assert result.runs == []
        assert [e.reason for e in result.errors] == [
            "path does not exist",
            "directory has no matching files",
        ]


class TestDeterminism:
    def test_loading_twice_is_byte_identical(self) -> None:
        first = otlp_jsonl.load([JSONL, PART1])
        second = otlp_jsonl.load([JSONL, PART1])
        assert to_json(first.to_dict()) == to_json(second.to_dict())

    def test_loader_never_opens_a_path_outside_the_input(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        opened: list[Path] = []
        real_open = builtins.open
        real_path_open = pathlib.Path.open

        def spy_open(file: Any, *args: Any, **kwargs: Any) -> Any:
            opened.append(Path(file))
            return real_open(file, *args, **kwargs)

        def spy_path_open(self: Path, *args: Any, **kwargs: Any) -> Any:
            opened.append(self)
            return real_path_open(self, *args, **kwargs)

        monkeypatch.setattr(builtins, "open", spy_open)
        monkeypatch.setattr(pathlib.Path, "open", spy_path_open)
        result = otlp_jsonl.load([JSONL, PART1])
        monkeypatch.undo()
        assert result.errors == []
        allowed = {PART1, PART2, BAD_LINE}
        # Directory sniffing may peek at the sidecars' heads; it must not read anything else.
        allowed |= {p for p in JSONL.iterdir() if p.is_file()}
        assert opened, "the loader must read its input through open()"
        assert {p.resolve() for p in opened} <= {p.resolve() for p in allowed}
