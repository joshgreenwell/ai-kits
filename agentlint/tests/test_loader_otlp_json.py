"""TL-B1 (JG-121): OTLP/JSON loader, tolerant gen_ai.* mapping, run-ID fallback."""

from __future__ import annotations

import builtins
import json
import pathlib
import shutil
from pathlib import Path
from typing import Any

import pytest

from agentlint.loaders import otlp_json
from agentlint.loaders.otlp_mapping import (
    ATTRIBUTE_MAPPINGS,
    MAPPED_ATTRIBUTE_NAMES,
    classify_span,
    decode_any_value,
    decode_attributes,
    event_status,
    parse_span_status,
    parse_unix_nano,
    render_mapping_table,
)
from agentlint.model import Run, to_json
from tests.conftest import FIXTURES

OTLP = FIXTURES / "otlp"
DOC = Path(__file__).resolve().parents[1] / "docs" / "loaders" / "otlp.md"

GEN_CURRENT = OTLP / "gen_current.json"
GEN_LEGACY = OTLP / "gen_legacy.json"
MALFORMED = OTLP / "malformed_record.json"
NO_CONVERSATION = OTLP / "missing_conversation_id.json"
USAGE_VARIANTS = OTLP / "usage_variants.json"
HEX_IDS = OTLP / "hex_ids_large_timestamps.json"
PAGES = OTLP / "pages"


def _only_run(result: Any) -> Run:
    assert result.errors == [], result.errors
    assert len(result.runs) == 1
    return result.runs[0]


def _events_by_id(run: Run) -> dict[str, Any]:
    return {e.id: e for e in run.events}


def _fixture_header(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)["_fixture"]


# --- Contract and detection ---------------------------------------------------


class TestContract:
    def test_format_label(self) -> None:
        assert otlp_json.FORMAT_LABEL == "otlp-json"
        assert _only_run(otlp_json.load(GEN_CURRENT)).source_format == "otlp-json"

    def test_detect_accepts_otlp_json_envelopes(self) -> None:
        assert otlp_json.detect(GEN_CURRENT)
        assert otlp_json.detect(str(HEX_IDS))  # instrumentationLibrarySpans alias

    def test_detect_rejects_other_shapes(self, tmp_path: Path) -> None:
        assert not otlp_json.detect(FIXTURES / "run_mixed_basis.json")  # JSON, not OTLP
        assert not otlp_json.detect(OTLP / "jsonl" / "split_part1.jsonl")  # line-delimited
        assert not otlp_json.detect(tmp_path / "missing.json")  # never raises
        assert not otlp_json.detect(tmp_path)  # a directory
        empty = tmp_path / "empty.json"
        empty.write_text("", encoding="utf-8")
        assert not otlp_json.detect(empty)

    def test_detect_accepts_compact_single_line_envelope(self, tmp_path: Path) -> None:
        path = tmp_path / "compact.json"
        path.write_text('{"resourceSpans": []}\n', encoding="utf-8")
        assert otlp_json.detect(path)

    @pytest.mark.parametrize(
        "path",
        [GEN_CURRENT, GEN_LEGACY, MALFORMED, NO_CONVERSATION, USAGE_VARIANTS, HEX_IDS],
    )
    def test_fixture_declares_synthetic_metadata(self, path: Path) -> None:
        header = _fixture_header(path)
        assert header["origin"] == "synthetic"
        assert set(header) >= {"origin", "ref", "completeness", "excerpt_or_raw"}

    def test_page_fixtures_declare_synthetic_metadata(self) -> None:
        for path in sorted(PAGES.glob("*.json")):
            assert _fixture_header(path)["origin"] == "synthetic"


# --- Typed values ----------------------------------------------------------------


class TestTypedValues:
    def test_int_value_is_parsed_exactly_beyond_2_pow_53(self) -> None:
        value = decode_any_value({"intValue": "9007199254740993"})
        assert value == 9007199254740993 and isinstance(value, int)
        assert decode_any_value({"intValue": 7}) == 7
        assert decode_any_value({"intValue": "-12"}) == -12

    def test_int_value_never_goes_through_a_float(self) -> None:
        with pytest.raises(ValueError):
            decode_any_value({"intValue": "12.5"})
        with pytest.raises(ValueError):
            decode_any_value({"intValue": 12.0})
        with pytest.raises(ValueError):
            decode_any_value({"intValue": True})

    def test_other_value_types(self) -> None:
        assert decode_any_value({"stringValue": "abc"}) == "abc"
        assert decode_any_value({"doubleValue": 0.5}) == 0.5
        assert decode_any_value({"boolValue": True}) is True
        assert decode_any_value({"bytesValue": "AAEC"}) == "AAEC"
        assert decode_any_value(
            {"arrayValue": {"values": [{"intValue": "1"}, {"stringValue": "x"}]}}
        ) == [1, "x"]
        assert decode_any_value(
            {"kvlistValue": {"values": [{"key": "depth", "value": {"intValue": "1"}}]}}
        ) == {"depth": 1}
        with pytest.raises(ValueError):
            decode_any_value({"unknownValue": 1})
        with pytest.raises(ValueError):
            decode_any_value("not an object")

    def test_decode_attributes_skips_bad_entries_and_reports_them(self) -> None:
        decoded, problems = decode_attributes(
            [
                {"key": "a", "value": {"intValue": "1"}},
                {"key": "b", "value": {"intValue": "x"}},
                {"value": {"stringValue": "no key"}},
                {"key": "a", "value": {"intValue": "2"}},
            ]
        )
        assert decoded == {"a": 1}
        assert problems == [
            "attributes/1 (b): expected an int64, got str",
            "attributes/2: missing string key",
        ]
        assert decode_attributes(None) == ({}, [])
        assert decode_attributes("nope") == ({}, ["attributes must be an array"])

    def test_timestamps_parse_exactly(self) -> None:
        assert parse_unix_nano("1700000000123456789") == 1700000000123456789
        assert parse_unix_nano(None) is None
        with pytest.raises(ValueError):
            parse_unix_nano(1.7e18)

    def test_status_codes_accept_enum_names_and_integers(self) -> None:
        assert parse_span_status({"code": 2}) == "error"
        assert parse_span_status({"code": "STATUS_CODE_ERROR"}) == "error"
        assert parse_span_status({"code": 1}) == "ok"
        assert parse_span_status({"code": "STATUS_CODE_OK"}) == "ok"
        assert parse_span_status({}) == "unset"
        assert parse_span_status(None) == "unset"
        assert parse_span_status({"code": "weird"}) == "unset"
        assert event_status("error", True) == "error"
        assert event_status("ok", False) == "ok"
        assert event_status("unset", True) == "ok"
        assert event_status("unset", False) == "unknown"


# --- Hex IDs and large integers ---------------------------------------------------


class TestPreservation:
    def test_hex_ids_with_leading_zeros_and_large_timestamps_survive(self) -> None:
        run = _only_run(otlp_json.load(HEX_IDS))
        events = _events_by_id(run)
        assert set(events) == {"00000000000000ab", "0000000000000001"}
        chat = events["00000000000000ab"]
        assert chat.start_ms == 1700000000123 and chat.end_ms == 1700000000987
        assert chat.duration_ms == 864
        assert chat.tokens_in == 9007199254740993 and isinstance(chat.tokens_in, int)
        assert chat.scope == {
            "otlp": {"trace_id": "0000000000000000000000000000a005", "operation_name": "chat"}
        }
        assert events["0000000000000001"].parent_id == "00000000000000ab"
        assert events["0000000000000001"].start_ms == 1700000001000
        assert (
            chat.source_locator
            == f"{HEX_IDS}#/resourceSpans/0/instrumentationLibrarySpans/0/spans/0"
        )
        assert run.conversation_id == "conv-0005"
        assert run.started_at == 1700000000123 and run.ended_at == 1700000001000

    def test_raw_records_keep_the_nanosecond_strings(self) -> None:
        run = _only_run(otlp_json.load(HEX_IDS))
        raw = run.raw_records[0]
        assert raw["source_locator"] == run.events[0].source_locator
        assert raw["span"]["startTimeUnixNano"] == "1700000000123456789"
        assert raw["span"]["spanId"] == "00000000000000ab"
        text = to_json(run)
        assert '"1700000000123456789"' in text
        assert "9007199254740993" in text
        assert Run.from_dict(json.loads(text)) == run

    def test_every_any_value_type_decodes_without_a_reason(self) -> None:
        run = _only_run(otlp_json.load(HEX_IDS))
        assert run.coverage.reasons == []
        assert run.coverage.completeness == "complete"


# --- Dual naming generations -----------------------------------------------------


def _load_as(path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Load ``path`` under the neutral name ``trace.json`` so locators match."""
    folder = tmp_path / path.stem
    folder.mkdir()
    shutil.copy(path, folder / "trace.json")
    monkeypatch.chdir(folder)
    return _only_run(otlp_json.load("trace.json")).to_dict()


class TestNamingGenerations:
    def test_both_generations_produce_identical_runs(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        current = _load_as(GEN_CURRENT, tmp_path, monkeypatch)
        legacy = _load_as(GEN_LEGACY, tmp_path, monkeypatch)
        # raw_records are the exports themselves and differ by attribute name.
        assert current["raw_records"] != legacy["raw_records"]
        current.pop("raw_records")
        legacy.pop("raw_records")
        assert current == legacy
        assert current["id"] == "conv-0001"

    def test_mapping_table_covers_two_generations(self) -> None:
        by_field = {m.field: m for m in ATTRIBUTE_MAPPINGS}
        assert by_field["tokens_in"].names == (
            "gen_ai.usage.input_tokens",
            "gen_ai.usage.prompt_tokens",
        )
        assert by_field["tokens_out"].names == (
            "gen_ai.usage.output_tokens",
            "gen_ai.usage.completion_tokens",
        )
        assert set(by_field["model"].names) == {"gen_ai.request.model", "gen_ai.response.model"}
        assert set(by_field["provider"].names) == {"gen_ai.provider.name", "gen_ai.system"}
        for name in (
            "gen_ai.operation.name",
            "gen_ai.conversation.id",
            "gen_ai.tool.call.id",
            "gen_ai.tool.name",
            "gen_ai.usage.cache_read.input_tokens",
        ):
            assert name in MAPPED_ATTRIBUTE_NAMES

    def test_documentation_table_is_generated_from_the_mapping(self) -> None:
        text = DOC.read_text(encoding="utf-8")
        start = text.index("<!-- mapping-table:start -->") + len("<!-- mapping-table:start -->\n")
        end = text.index("<!-- mapping-table:end -->")
        assert text[start:end] == render_mapping_table()
        for name in MAPPED_ATTRIBUTE_NAMES:
            assert f"`{name}`" in text


# --- Classification, status, content ---------------------------------------------


class TestClassification:
    def test_kinds_from_fixture(self) -> None:
        run = _only_run(otlp_json.load(GEN_CURRENT))
        kinds = {e.id: e.kind for e in run.events}
        assert kinds == {
            "000000000000a001": "aggregate",  # invoke_agent wrapping two model calls
            "000000000000a002": "model_call",
            "000000000000a003": "tool_call",
            "000000000000a004": "model_call",
            "000000000000a005": "other",
        }

    def test_classify_span_rules(self) -> None:
        assert classify_span({"gen_ai.tool.name": "x"}, {"tool_name": "x"}, 0) == "tool_call"
        assert classify_span({}, {"operation_name": "execute_tool"}, 3) == "tool_call"
        assert classify_span({}, {"operation_name": "chat"}, 0) == "model_call"
        assert classify_span({}, {"tokens_in": 1}, 0) == "model_call"
        assert classify_span({}, {"tokens_in": 1}, 1) == "aggregate"
        assert classify_span({}, {}, 2) == "aggregate"
        assert classify_span({}, {}, 1) == "other"
        assert classify_span({"http.request.method": "GET"}, {}, 0) == "other"

    def test_status_and_error_type(self) -> None:
        events = _events_by_id(_only_run(otlp_json.load(GEN_CURRENT)))
        assert events["000000000000a001"].status == "ok"  # STATUS_CODE_OK
        assert events["000000000000a002"].status == "ok"
        assert events["000000000000a003"].status == "ok"  # UNSET but a result was parsed
        assert events["000000000000a004"].status == "error"
        assert events["000000000000a004"].error_type == "RateLimitError"
        assert events["000000000000a005"].status == "unknown"  # UNSET, nothing parsed

    def test_model_fields(self) -> None:
        events = _events_by_id(_only_run(otlp_json.load(GEN_CURRENT)))
        chat = events["000000000000a002"]
        assert (chat.model, chat.provider) == ("model-a", "provider-x")
        assert (chat.tokens_in, chat.tokens_out, chat.cache_read_tokens) == (1000, 50, 400)
        assert chat.finish_reason == "stop"
        assert chat.name == "chat model-a"
        assert chat.parent_id == "000000000000a001"
        assert chat.seq is None and chat.adapter is None and chat.native_tool_call_id is None
        assert events["000000000000a004"].tokens_out == 0  # a real zero stays zero

    def test_tool_fields_and_content_fingerprints(self) -> None:
        events = _events_by_id(_only_run(otlp_json.load(GEN_CURRENT)))
        tool = events["000000000000a003"]
        assert tool.name == "search_docs"
        assert tool.tool_call_id == "call-0001"
        assert tool.args_fingerprint is not None
        assert tool.args_fingerprint.representation == "full"
        assert tool.result_fingerprint is not None
        assert tool.result_bytes == len(b'{"hits": ["doc-1", "doc-2"], "count": 2}')
        assert tool.preview_bytes is None
        assert tool.model is None and tool.tokens_in is None

    def test_absent_content_gives_none_not_a_placeholder_hash(self) -> None:
        events = _events_by_id(_only_run(otlp_json.load(NO_CONVERSATION)))
        tool = events["000000000000c002"]
        assert tool.kind == "tool_call"
        assert tool.args_fingerprint is None
        assert tool.result_fingerprint is None
        assert tool.result_bytes is None

    def test_token_basis_comes_from_config_only(self) -> None:
        run = _only_run(otlp_json.load(GEN_CURRENT))
        assert all(e.token_basis is None for e in run.events)
        run = _only_run(otlp_json.load(GEN_CURRENT, {"token_basis": "input_excludes_cache_read"}))
        events = _events_by_id(run)
        assert events["000000000000a002"].token_basis == "input_excludes_cache_read"
        assert events["000000000000a001"].token_basis is None  # aggregate without usage
        assert events["000000000000a003"].token_basis is None


# --- Usage coverage ----------------------------------------------------------------


class TestUsageCoverage:
    def test_missing_usage_is_none_and_absent(self) -> None:
        run = _only_run(otlp_json.load(NO_CONVERSATION))
        chat = _events_by_id(run)["000000000000c001"]
        assert (chat.tokens_in, chat.tokens_out, chat.tokens_total) == (None, None, None)
        assert run.coverage.fields["tokens_in"] == "absent"
        assert run.coverage.fields["tokens_out"] == "absent"
        notes = {n.code: n for n in run.coverage.notes}
        assert notes["usage_absent"].event_ids == ["000000000000c001"]

    def test_partial_usage_is_partial(self) -> None:
        run = _only_run(otlp_json.load(USAGE_VARIANTS))
        events = _events_by_id(run)
        assert (events["000000000000d001"].tokens_in, events["000000000000d001"].tokens_out) == (
            100,
            10,
        )
        assert (events["000000000000d002"].tokens_in, events["000000000000d002"].tokens_out) == (
            120,
            None,
        )
        assert events["000000000000d003"].tokens_in is None
        assert run.coverage.fields["tokens_in"] == "partial"
        assert run.coverage.fields["tokens_out"] == "partial"
        notes = {n.code: n for n in run.coverage.notes}
        assert notes["usage_absent"].event_ids == ["000000000000d003"]


# --- Multi-file input and merge --------------------------------------------------


class TestMultiFile:
    def test_directory_merges_pages_into_one_run(self) -> None:
        run = _only_run(otlp_json.load(PAGES))
        assert run.id == "conv-0006"
        assert run.source_refs == [str(PAGES / "page_1.json"), str(PAGES / "page_2.json")]
        kinds = {e.id: e.kind for e in run.events}
        assert kinds == {
            "000000000000e001": "aggregate",  # children live in the other page
            "000000000000e002": "model_call",
            "000000000000e003": "model_call",
            "000000000000e004": "tool_call",
        }
        assert run.coverage.events_total == 4
        assert run.coverage.events_dropped_dedup == 0
        assert run.coverage.completeness == "complete"
        assert run.started_at == 1700000000000 and run.ended_at == 1700000009000
        assert [r["source_locator"].split("#")[0] for r in run.raw_records] == [
            str(PAGES / "page_1.json"),
            str(PAGES / "page_1.json"),
            str(PAGES / "page_2.json"),
            str(PAGES / "page_2.json"),
        ]

    def test_file_list_in_any_order_gives_the_same_run(self) -> None:
        forward = otlp_json.load([PAGES / "page_1.json", PAGES / "page_2.json"])
        reverse = otlp_json.load([PAGES / "page_2.json", PAGES / "page_1.json"])
        assert [e.id for e in forward.runs[0].events] == [e.id for e in reverse.runs[0].events]
        assert forward.runs[0].events == reverse.runs[0].events
        assert set(forward.runs[0].source_refs) == set(reverse.runs[0].source_refs)

    def test_several_runs_come_back_sorted_by_id(self) -> None:
        result = otlp_json.load([USAGE_VARIANTS, GEN_CURRENT, NO_CONVERSATION])
        assert result.errors == []
        assert [r.id for r in result.runs] == [
            "0000000000000000000000000000a003",
            "conv-0001",
            "conv-0004",
        ]

    def test_same_file_twice_is_deduplicated(self) -> None:
        run = _only_run(otlp_json.load([GEN_CURRENT, GEN_CURRENT]))
        assert run.coverage.events_total == 5
        assert run.coverage.events_dropped_dedup == 5


# --- Run-ID fallback ------------------------------------------------------------------


class TestRunIdFallback:
    def test_missing_conversation_id_falls_back_to_trace_id_and_is_flagged(self) -> None:
        run = _only_run(otlp_json.load(NO_CONVERSATION))
        assert run.id == "0000000000000000000000000000a003"
        assert run.conversation_id is None
        assert run.coverage.completeness == "complete"
        note = next(n for n in run.coverage.notes if n.code == "run_id_fallback_trace_id")
        assert note.fields == ["run_id", "conversation_id"]
        assert note.event_ids == ["000000000000c001", "000000000000c002"]

    def test_conversation_id_is_used_when_present(self) -> None:
        run = _only_run(otlp_json.load(USAGE_VARIANTS))
        assert run.id == "conv-0004" and run.conversation_id == "conv-0004"
        assert not any(n.code == "run_id_fallback_trace_id" for n in run.coverage.notes)

    def test_configured_app_attribute_wins_over_conversation_id(self) -> None:
        run = _only_run(otlp_json.load(USAGE_VARIANTS, {"run_id_attribute": "app.run.id"}))
        assert run.id == "run-app-0004"
        assert run.conversation_id == "conv-0004"

    def test_children_inherit_the_root_spans_run_id(self) -> None:
        run = _only_run(otlp_json.load(GEN_CURRENT))
        assert run.id == "conv-0001"
        assert len(run.events) == 5  # children without the attribute joined the root's run


# --- Negative cases -----------------------------------------------------------------


class TestNegativeCases:
    def test_malformed_records_mark_the_run_incomplete_with_locators(self) -> None:
        run = _only_run(otlp_json.load(MALFORMED))
        assert run.coverage.completeness == "incomplete"
        prefix = f"{MALFORMED}#/resourceSpans/0/scopeSpans/0/spans/"
        assert sorted(run.coverage.reasons) == sorted(
            [
                f"{prefix}1: malformed span: missing spanId",
                f"{prefix}2: attributes/2 (gen_ai.usage.input_tokens): expected an int64, got str",
                f"{prefix}2: startTimeUnixNano: expected an int64, got float",
                f"{prefix}3: span is not an object",
            ]
        )
        events = _events_by_id(run)
        assert set(events) == {"000000000000b001", "000000000000b003"}
        good = events["000000000000b001"]
        assert (good.tokens_in, good.tokens_out, good.status) == (10, 5, "ok")
        damaged = events["000000000000b003"]
        assert damaged.start_ms is None and damaged.tokens_in is None
        assert damaged.tokens_out == 7

    def test_invalid_json_file_is_a_load_error_not_a_crash(self, tmp_path: Path) -> None:
        bad = tmp_path / "bad.json"
        bad.write_text('{"resourceSpans": [', encoding="utf-8")
        result = otlp_json.load([bad, GEN_CURRENT])
        assert len(result.runs) == 1 and result.runs[0].id == "conv-0001"
        assert [e.path for e in result.errors] == [str(bad)]
        assert result.errors[0].reason.startswith("invalid JSON")
        assert result.errors[0].locator == f"{bad}:1:20"

    def test_envelope_without_spans_is_a_load_error(self, tmp_path: Path) -> None:
        empty = tmp_path / "empty.json"
        empty.write_text('{"resourceSpans": []}', encoding="utf-8")
        result = otlp_json.load(empty)
        assert result.runs == []
        assert [(e.path, e.reason) for e in result.errors] == [(str(empty), "no spans found")]

    def test_envelope_of_the_wrong_shape_is_a_load_error(self, tmp_path: Path) -> None:
        wrong = tmp_path / "wrong.json"
        wrong.write_text('{"resourceSpans": "nope"}', encoding="utf-8")
        result = otlp_json.load(wrong)
        assert result.runs == []
        assert result.errors[0].locator == f"{wrong}#/resourceSpans"
        assert result.errors[0].reason == "not an array"

    def test_missing_path_and_empty_directory_are_load_errors(self, tmp_path: Path) -> None:
        result = otlp_json.load([tmp_path / "nowhere.json", tmp_path])
        assert result.runs == []
        assert [e.reason for e in result.errors] == [
            "path does not exist",
            "directory has no matching files",
        ]

    def test_unknown_gen_ai_attributes_are_ignored_and_noted_once(self) -> None:
        run = _only_run(otlp_json.load(USAGE_VARIANTS))
        notes = [n for n in run.coverage.notes if n.code == "unknown_gen_ai_attributes"]
        assert len(notes) == 1
        assert notes[0].fields == ["gen_ai.experimental.effort"]
        # Known-but-unmapped conventions and app attributes are not "unknown".
        assert "gen_ai.request.temperature" not in notes[0].message
        assert "app.custom.flag" not in notes[0].message

    def test_no_unknown_note_when_every_gen_ai_attribute_is_known(self) -> None:
        run = _only_run(otlp_json.load(GEN_CURRENT))
        assert not any(n.code == "unknown_gen_ai_attributes" for n in run.coverage.notes)

    def test_file_level_problem_attaches_to_every_run_of_that_file(self, tmp_path: Path) -> None:
        path = tmp_path / "two_runs.json"
        with GEN_CURRENT.open(encoding="utf-8") as handle:
            envelope = json.load(handle)
        with NO_CONVERSATION.open(encoding="utf-8") as handle:
            other = json.load(handle)
        spans = envelope["resourceSpans"][0]["scopeSpans"][0]["spans"]
        spans.extend(other["resourceSpans"][0]["scopeSpans"][0]["spans"])
        spans.append({"spanId": "000000000000ffff", "name": "no trace id"})
        path.write_text(json.dumps(envelope), encoding="utf-8")
        result = otlp_json.load(path)
        assert result.errors == []
        assert len(result.runs) == 2
        for run in result.runs:
            assert run.coverage.completeness == "incomplete"
            assert run.coverage.reasons == [
                f"{path}#/resourceSpans/0/scopeSpans/0/spans/7: malformed span: missing traceId"
            ]


# --- Determinism and confinement ----------------------------------------------------


class TestDeterminism:
    def test_loading_twice_is_byte_identical(self) -> None:
        first = otlp_json.load([PAGES, GEN_CURRENT, MALFORMED])
        second = otlp_json.load([PAGES, GEN_CURRENT, MALFORMED])
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
        result = otlp_json.load([PAGES, GEN_CURRENT])
        monkeypatch.undo()
        assert result.errors == []
        allowed = {PAGES / "page_1.json", PAGES / "page_2.json", GEN_CURRENT}
        assert opened, "the loader must read its input through open()"
        assert {p.resolve() for p in opened} <= {p.resolve() for p in allowed}
