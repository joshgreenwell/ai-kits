"""Tests for the ``langfuse-observations`` loader (JG-123 / TL-B3).

Every fixture under ``tests/fixtures/langfuse`` is synthetic; the io strings
all start with ``SYNTHETIC-`` so the "never copies content" test can look for
them by prefix.
"""

from __future__ import annotations

import contextlib
import csv
import json
from pathlib import Path
from typing import Any

import pytest

from agentlint.fingerprint import fingerprint, utf8_length
from agentlint.loaders import langfuse
from agentlint.loaders.base import LoadResult
from agentlint.model import (
    TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ,
    Event,
    Run,
    to_json,
)
from agentlint.tokens import TokenConfig

FIXTURES = Path(__file__).parent / "fixtures" / "langfuse"
V2_JSON = FIXTURES / "observations_v2.json"
V2_JSONL = FIXTURES / "observations_v2.jsonl"
V2_CSV = FIXTURES / "observations_v2.csv"
LEGACY_JSON = FIXTURES / "observations_legacy.json"
NO_USAGE_CSV = FIXTURES / "observations_no_usage.csv"
ALL_FIXTURES = [V2_JSON, V2_JSONL, V2_CSV, LEGACY_JSON, NO_USAGE_CSV]

TRACE_A = "trace-aaaa-0001"
TRACE_B = "trace-bbbb-0002"


# --- helpers -----------------------------------------------------------------


def _run(result: LoadResult, run_id: str) -> Run:
    matches = [r for r in result.runs if r.id == run_id]
    assert len(matches) == 1, [r.id for r in result.runs]
    return matches[0]


def _event(run: Run, event_id: str) -> Event:
    matches = [e for e in run.events if e.id == event_id]
    assert len(matches) == 1, [e.id for e in run.events]
    return matches[0]


def _notes(run: Run, code: str) -> list:
    return [n for n in run.coverage.notes if n.code == code]


def _fixture_rows(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        data = json.loads(text)
        return data["data"] if isinstance(data, dict) else data
    if path.suffix == ".jsonl":
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    return list(csv.DictReader(text.splitlines()))


def _string_leaves(value: Any) -> set[str]:
    if isinstance(value, str):
        return {value}
    if isinstance(value, dict):
        return set().union(*(_string_leaves(v) for v in value.values())) if value else set()
    if isinstance(value, list):
        return set().union(*(_string_leaves(v) for v in value)) if value else set()
    return set()


def _write_json(tmp_path: Path, name: str, rows: Any) -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(rows), encoding="utf-8")
    return path


def _gen(obs_id: str, trace: str = "trace-tmp-0001", **extra: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": obs_id,
        "traceId": trace,
        "type": "GENERATION",
        "name": "chat",
        "startTime": "2024-01-01T00:00:00.000Z",
        "endTime": "2024-01-01T00:00:01.000Z",
        "model": "model-tmp",
    }
    row.update(extra)
    return row


# --- format label, source refs, detect ------------------------------------------


def test_format_label_and_source_refs():
    result = langfuse.load(V2_JSON)
    assert langfuse.FORMAT_LABEL == "langfuse-observations"
    assert result.format_label == "langfuse-observations"
    assert result.errors == []
    for run in result.runs:
        assert run.source_format == "langfuse-observations"
        assert run.source_refs == [V2_JSON.as_posix()]


@pytest.mark.parametrize("path", ALL_FIXTURES, ids=[p.name for p in ALL_FIXTURES])
def test_detect_accepts_every_fixture(path: Path):
    assert langfuse.detect(path) is True


def test_detect_rejects_other_shapes(tmp_path: Path):
    otlp = tmp_path / "otlp.json"
    otlp.write_text(
        json.dumps(
            {
                "resourceSpans": [
                    {"scopeSpans": [{"spans": [{"traceId": "ab", "spanId": "cd", "startTime": 1}]}]}
                ]
            }
        )
    )
    plain_csv = tmp_path / "plain.csv"
    plain_csv.write_text("id,name\n1,x\n")
    text = tmp_path / "notes.txt"
    text.write_text('{"traceId": "x", "startTime": "y"}')
    empty = tmp_path / "empty.jsonl"
    empty.write_text("")
    sidecar = FIXTURES / "observations_v2.jsonl.fixture.json"
    assert langfuse.detect(otlp) is False
    assert langfuse.detect(plain_csv) is False
    assert langfuse.detect(text) is False
    assert langfuse.detect(empty) is False
    assert langfuse.detect(sidecar) is False
    assert langfuse.detect(tmp_path) is False
    assert langfuse.detect(tmp_path / "missing.json") is False


# --- identity join ---------------------------------------------------------------


def test_identity_join_ids_parents_trace_session():
    result = langfuse.load(V2_JSON)
    assert [r.id for r in result.runs] == [TRACE_A, TRACE_B]
    run_a = _run(result, TRACE_A)
    assert run_a.conversation_id == "session-0001"
    assert [e.id for e in run_a.events] == [
        "obs-a-root",
        "obs-a-gen1",
        "obs-a-tool1",
        "obs-a-span-tool",
        "obs-a-gen2",
        "obs-a-evt",
    ]
    assert _event(run_a, "obs-a-root").parent_id is None
    assert _event(run_a, "obs-a-gen1").parent_id == "obs-a-root"
    assert _event(run_a, "obs-a-tool1").parent_id == "obs-a-root"
    run_b = _run(result, TRACE_B)
    assert run_b.conversation_id == "session-0002"
    assert _event(run_b, "obs-b-gen1").parent_id == "obs-b-root"


def test_multiple_traces_in_one_file_become_separate_runs():
    result = langfuse.load(V2_JSON)
    assert len(result.runs) == 2
    assert {e.id for e in _run(result, TRACE_A).events}.isdisjoint(
        {e.id for e in _run(result, TRACE_B).events}
    )
    assert _run(result, TRACE_A).coverage.events_total == 6
    assert _run(result, TRACE_B).coverage.events_total == 3


# --- kind, status, times, model -------------------------------------------------


def test_observation_type_to_kind():
    run_a = _run(langfuse.load(V2_JSON), TRACE_A)
    run_b = _run(langfuse.load(V2_JSON), TRACE_B)
    assert _event(run_a, "obs-a-gen1").kind == "model_call"
    assert _event(run_a, "obs-a-tool1").kind == "tool_call"
    assert _event(run_a, "obs-a-span-tool").kind == "tool_call"  # SPAN with tool metadata
    assert _event(run_a, "obs-a-root").kind == "aggregate"  # SPAN wrapping generations
    assert _event(run_a, "obs-a-evt").kind == "other"
    assert _event(run_b, "obs-b-span-plain").kind == "other"  # SPAN wrapping nothing
    assert _event(run_a, "obs-a-gen1").scope == {
        "langfuse": {"type": "GENERATION", "level": "DEFAULT"}
    }


def test_embedding_and_agent_types(tmp_path: Path):
    rows = [
        {
            "id": "ag",
            "traceId": "t",
            "type": "AGENT",
            "name": "loop",
            "startTime": "2024-01-01T00:00:00Z",
        },
        _gen("emb", "t", type="EMBEDDING", parentObservationId="ag"),
        {"id": "ev", "traceId": "t", "type": "event", "startTime": "2024-01-01T00:00:00Z"},
    ]
    run = langfuse.load(_write_json(tmp_path, "types.json", rows)).runs[0]
    assert _event(run, "emb").kind == "model_call"
    assert _event(run, "ag").kind == "aggregate"
    assert _event(run, "ev").kind == "other"


def test_level_error_maps_to_status_error():
    run_a = _run(langfuse.load(V2_JSON), TRACE_A)
    assert _event(run_a, "obs-a-gen2").status == "error"
    assert _event(run_a, "obs-a-gen1").status == "ok"
    assert _event(run_a, "obs-a-gen2").error_type is None  # statusMessage never copied


def test_missing_level_is_unknown(tmp_path: Path):
    run = langfuse.load(_write_json(tmp_path, "nolevel.json", [_gen("g")])).runs[0]
    assert _event(run, "g").status == "unknown"


def test_times_and_model_mapped():
    run_a = _run(langfuse.load(V2_JSON), TRACE_A)
    gen1 = _event(run_a, "obs-a-gen1")
    assert gen1.start_ms == 1704067200100
    assert gen1.end_ms == 1704067201000
    assert gen1.duration_ms == 900
    assert gen1.model == "model-a"
    assert gen1.name == "chat"
    assert run_a.started_at == 1704067200000
    assert run_a.ended_at == 1704067205000
    assert run_a.coverage.fields["start_ms"] == "present"
    assert run_a.coverage.fields["end_ms"] == "present"


def test_unparseable_time_left_unknown(tmp_path: Path):
    rows = [_gen("g", startTime="yesterday", endTime="2024-01-01T00:00:01Z")]
    run = langfuse.load(_write_json(tmp_path, "badtime.json", rows)).runs[0]
    assert _event(run, "g").start_ms is None
    assert _event(run, "g").duration_ms is None
    assert [n.event_ids for n in _notes(run, "unparseable_time")] == [["g"]]


# --- usage and token basis --------------------------------------------------------


def test_v2_usage_details_with_cache_read_key():
    run_a = _run(langfuse.load(V2_JSON), TRACE_A)
    gen1 = _event(run_a, "obs-a-gen1")
    assert (gen1.tokens_in, gen1.tokens_out, gen1.tokens_total) == (900, 40, 1000)
    assert gen1.cache_read_tokens == 60
    assert gen1.cache_write_tokens is None
    assert gen1.token_basis == TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ
    run_b = _run(langfuse.load(V2_JSON), TRACE_B)
    gen_b = _event(run_b, "obs-b-gen1")
    assert gen_b.cache_read_tokens == 100
    assert gen_b.cache_write_tokens == 30
    assert gen_b.token_basis == TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ
    assert _notes(run_b, "token_basis_assumed") == []


def test_v2_usage_details_without_cache_key_is_assumed_and_noted():
    run_a = _run(langfuse.load(V2_JSON), TRACE_A)
    gen2 = _event(run_a, "obs-a-gen2")
    assert gen2.token_basis == TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ
    assert gen2.cache_read_tokens is None
    notes = _notes(run_a, "token_basis_assumed")
    assert len(notes) == 1
    assert notes[0].event_ids == ["obs-a-gen2"]
    assert notes[0].fields == ["token_basis"]
    assert run_a.coverage.completeness == "complete"


def test_ambiguous_cache_keys_leave_cache_read_unknown(tmp_path: Path):
    rows = [
        _gen(
            "g",
            usageDetails={
                "input": 10,
                "output": 5,
                "total": 20,
                "input_cached_tokens": 3,
                "cache_read_input_tokens": 4,
            },
        )
    ]
    run = langfuse.load(_write_json(tmp_path, "ambiguous.json", rows)).runs[0]
    assert _event(run, "g").cache_read_tokens is None
    assert _event(run, "g").tokens_in == 10
    assert [n.event_ids for n in _notes(run, "usage_detail_ambiguous")] == [["g"]]


def test_legacy_shape_detected_with_loud_note():
    result = langfuse.load(LEGACY_JSON)
    run = result.runs[0]
    assert run.id == "trace-dddd-0004"
    notes = _notes(run, "legacy_observation_shape")
    assert len(notes) == 1
    assert "older Observations API shape" in notes[0].message
    for name in ("promptTokens", "completionTokens", "totalTokens", "usage"):
        assert name in notes[0].message
    assert "usageDetails" in notes[0].message
    assert notes[0].event_ids == ["obs-d-gen1", "obs-d-gen2"]
    assert "legacy_observation_shape" in run.coverage.reasons
    assert run.coverage.completeness == "incomplete"
    gen1 = _event(run, "obs-d-gen1")
    assert (gen1.tokens_in, gen1.tokens_out, gen1.tokens_total) == (800, 35, 835)
    assert gen1.token_basis is None
    assert run.coverage.fields["token_basis"] == "absent"


def test_legacy_non_token_unit_not_mapped():
    run = langfuse.load(LEGACY_JSON).runs[0]
    gen2 = _event(run, "obs-d-gen2")
    assert (gen2.tokens_in, gen2.tokens_out, gen2.tokens_total) == (None, None, None)
    notes = _notes(run, "usage_unit_not_tokens")
    assert len(notes) == 1
    assert "CHARACTERS" in notes[0].message
    assert notes[0].event_ids == ["obs-d-gen2"]


def test_v2_shape_is_not_reported_as_legacy():
    for run in langfuse.load(V2_JSON).runs:
        assert _notes(run, "legacy_observation_shape") == []
        assert "legacy_observation_shape" not in run.coverage.reasons


def test_usage_column_absent_in_csv_gives_none_and_absent_coverage():
    result = langfuse.load(NO_USAGE_CSV)
    assert result.errors == []
    run = result.runs[0]
    assert run.id == "trace-eeee-0005"
    for event in run.events:
        assert event.tokens_in is None
        assert event.tokens_out is None
        assert event.tokens_total is None
        assert event.cache_read_tokens is None
        assert event.token_basis is None
    assert run.coverage.fields["tokens_in"] == "absent"
    assert run.coverage.fields["tokens_out"] == "absent"
    assert run.coverage.fields["token_basis"] == "absent"
    assert run.coverage.fields["cache_read_tokens"] == "absent"
    assert "usage_absent" in run.coverage.reasons
    assert run.coverage.completeness == "incomplete"
    notes = _notes(run, "usage_absent")
    assert len(notes) == 1
    assert "absent from the export" in notes[0].message
    assert notes[0].event_ids == ["obs-e-gen1", "obs-e-gen2"]


def test_usage_keys_absent_in_json_rows_gives_none(tmp_path: Path):
    rows = [_gen("g1"), _gen("g2")]
    run = langfuse.load(_write_json(tmp_path, "nousage.json", rows)).runs[0]
    assert all(e.tokens_in is None and e.token_basis is None for e in run.events)
    assert run.coverage.fields["tokens_in"] == "absent"
    assert "usage_absent" in run.coverage.reasons


def test_empty_usage_details_cell_is_partial_not_zero():
    run = langfuse.load(V2_CSV).runs[0]
    gen2 = _event(run, "obs-c-gen2")
    assert gen2.tokens_in is None
    assert gen2.token_basis is None
    gen1 = _event(run, "obs-c-gen1")
    assert (gen1.tokens_in, gen1.cache_read_tokens) == (700, 50)
    assert run.coverage.fields["tokens_in"] == "partial"
    assert "usage_absent" not in run.coverage.reasons


def test_csv_dotted_usage_columns_fold_into_object(tmp_path: Path):
    path = tmp_path / "flat.csv"
    path.write_text(
        "id,traceId,type,name,startTime,endTime,model,usageDetails.input,usageDetails.output,"
        "usageDetails.total,usageDetails.input_cached_tokens\n"
        "g,t,GENERATION,chat,2024-01-01T00:00:00Z,2024-01-01T00:00:01Z,model-x,11,2,13,4\n"
    )
    run = langfuse.load(path).runs[0]
    gen = _event(run, "g")
    assert (gen.tokens_in, gen.tokens_out, gen.tokens_total, gen.cache_read_tokens) == (
        11,
        2,
        13,
        4,
    )
    assert gen.token_basis == TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ


# --- tool calls, io fingerprints, never copying content --------------------------


def test_tool_call_id_read_from_metadata():
    run_a = _run(langfuse.load(V2_JSON), TRACE_A)
    assert _event(run_a, "obs-a-tool1").tool_call_id == "call-a-0001"
    assert _event(run_a, "obs-a-span-tool").tool_call_id == "call-a-0002"
    assert _event(run_a, "obs-a-gen1").tool_call_id is None
    assert _event(run_a, "obs-a-root").tool_call_id is None


def test_io_fingerprints_and_result_bytes_match_fixture_values():
    rows = {r["id"]: r for r in _fixture_rows(V2_JSON)}
    run_a = _run(langfuse.load(V2_JSON), TRACE_A)
    tool = _event(run_a, "obs-a-tool1")
    assert tool.args_fingerprint == fingerprint(rows["obs-a-tool1"]["input"])
    assert tool.result_fingerprint == fingerprint(rows["obs-a-tool1"]["output"])
    assert tool.args_fingerprint.representation == "full"
    assert tool.result_bytes == utf8_length(rows["obs-a-tool1"]["output"])
    gen1 = _event(run_a, "obs-a-gen1")
    assert gen1.args_fingerprint == fingerprint(rows["obs-a-gen1"]["input"])
    assert gen1.result_bytes == utf8_length(rows["obs-a-gen1"]["output"])
    gen2 = _event(run_a, "obs-a-gen2")  # output is null in the export
    assert gen2.result_fingerprint is None
    assert gen2.result_bytes is None
    assert gen2.args_fingerprint is not None


def test_csv_json_cells_fingerprint_like_json_export():
    rows = {r["id"]: r for r in _fixture_rows(V2_CSV)}
    run = langfuse.load(V2_CSV).runs[0]
    gen1 = _event(run, "obs-c-gen1")
    assert gen1.args_fingerprint == fingerprint(json.loads(rows["obs-c-gen1"]["input"]))
    tool = _event(run, "obs-c-tool1")
    assert tool.result_bytes == utf8_length(rows["obs-c-tool1"]["output"])


def test_truncation_marker_gives_truncated_representation(tmp_path: Path):
    rows = [
        _gen(
            "g",
            input="SYNTHETIC-TRUNCATED-PROMPT long enough to hash",
            inputTruncated=True,
            output={"text": "SYNTHETIC-TRUNCATED-OUTPUT long enough to hash"},
        )
    ]
    run = langfuse.load(_write_json(tmp_path, "trunc.json", rows)).runs[0]
    gen = _event(run, "g")
    assert gen.args_fingerprint.representation == "truncated"
    assert gen.result_fingerprint.representation == "full"
    assert run.coverage.truncated is True
    assert run.coverage.completeness == "incomplete"
    assert "truncated" in run.coverage.reasons


def test_short_io_values_are_not_hashed(tmp_path: Path):
    rows = [_gen("g", input="hi", output={"a": 1})]
    run = langfuse.load(_write_json(tmp_path, "short.json", rows)).runs[0]
    assert _event(run, "g").args_fingerprint is None
    assert _event(run, "g").result_fingerprint is None
    assert _event(run, "g").result_bytes == utf8_length({"a": 1})


@pytest.mark.parametrize("path", ALL_FIXTURES, ids=[p.name for p in ALL_FIXTURES])
def test_io_content_never_appears_in_output(path: Path):
    leaves: set[str] = set()
    for row in _fixture_rows(path):
        for key in ("input", "output", "metadata", "statusMessage"):
            value = row.get(key)
            if isinstance(value, str) and value[:1] in "{[":
                with contextlib.suppress(ValueError):
                    value = json.loads(value)
            leaves |= _string_leaves(value)
    sentinels = {s for s in leaves if s.startswith("SYNTHETIC-")}
    assert sentinels, "fixture must carry sentinel io strings"
    rendered = to_json(langfuse.load(path).to_dict())
    assert "SYNTHETIC-" not in rendered
    for sentinel in sentinels:
        assert sentinel not in rendered
    # Neither the sentinel words nor any content-bearing key survives.
    assert "Northbridge" not in rendered
    assert '"input":' not in rendered
    assert '"output":' not in rendered
    assert '"metadata":' not in rendered
    assert '"statusMessage":' not in rendered


def test_raw_records_are_identity_only():
    run_a = _run(langfuse.load(V2_JSON), TRACE_A)
    assert len(run_a.raw_records) == 6
    assert run_a.raw_records[0] == {
        "id": "obs-a-root",
        "locator": f"{V2_JSON.as_posix()}#/data/0",
        "parentObservationId": None,
        "traceId": TRACE_A,
        "type": "SPAN",
    }
    assert all(
        set(r) == {"id", "locator", "parentObservationId", "traceId", "type"}
        for r in run_a.raw_records
    )


# --- locators, unknown fields --------------------------------------------------------


def test_source_locators_per_layout(tmp_path: Path):
    json_run = _run(langfuse.load(V2_JSON), TRACE_A)
    assert _event(json_run, "obs-a-root").source_locator == f"{V2_JSON.as_posix()}#/data/0"
    assert _event(json_run, "obs-a-gen1").source_locator == f"{V2_JSON.as_posix()}#/data/1"
    jsonl_run = langfuse.load(V2_JSONL).runs[0]
    assert _event(jsonl_run, "obs-a-gen3").source_locator == f"{V2_JSONL.as_posix()}#6"
    csv_run = langfuse.load(V2_CSV).runs[0]
    assert _event(csv_run, "obs-c-gen1").source_locator == f"{V2_CSV.as_posix()}#1"
    array_run = langfuse.load(LEGACY_JSON).runs[0]
    assert _event(array_run, "obs-d-gen1").source_locator == f"{LEGACY_JSON.as_posix()}#/1"
    single = _write_json(tmp_path, "single.json", _gen("only"))
    assert langfuse.load(single).runs[0].events[0].source_locator == f"{single.as_posix()}#/0"


def test_unknown_fields_ignored_with_one_note():
    result = langfuse.load(V2_JSON)
    run_a = _run(result, TRACE_A)
    notes = _notes(run_a, "unknown_fields")
    assert len(notes) == 1
    assert notes[0].message == "ignored unknown observation field(s): customFlag"
    run_b = _run(result, TRACE_B)
    assert [n.message for n in _notes(run_b, "unknown_fields")] == [
        "ignored unknown observation field(s): experimentBucket"
    ]
    for run in result.runs:
        for note in _notes(run, "unknown_fields"):
            for recognised in ("environment", "projectId", "latency", "costDetails"):
                assert recognised not in note.message
    assert "customFlag" not in to_json(run_a.to_dict()).replace(notes[0].message, "")


# --- multi-file merge, directories, determinism ---------------------------------------


def test_multiple_files_merge_by_trace_id():
    result = langfuse.load([V2_JSON, V2_JSONL])
    assert result.errors == []
    assert [r.id for r in result.runs] == [TRACE_A, TRACE_B]
    run_a = _run(result, TRACE_A)
    assert run_a.source_refs == [V2_JSON.as_posix(), V2_JSONL.as_posix()]
    assert [e.id for e in run_a.events][-1] == "obs-a-gen3"
    assert run_a.coverage.events_total == 7
    assert run_a.coverage.events_dropped_dedup == 6
    assert run_a.conversation_id == "session-0001"
    assert _notes(run_a, "dedup_conflict") == []
    assert _run(result, TRACE_B).source_refs == [V2_JSON.as_posix()]


def test_directory_loads_only_detected_files():
    result = langfuse.load(FIXTURES)
    assert result.errors == []
    assert [r.id for r in result.runs] == [
        TRACE_A,
        TRACE_B,
        "trace-cccc-0003",
        "trace-dddd-0004",
        "trace-eeee-0005",
    ]
    assert _run(result, TRACE_A).coverage.events_total == 7


def test_load_is_byte_deterministic():
    first = to_json(langfuse.load([V2_JSON, V2_JSONL, V2_CSV, LEGACY_JSON, NO_USAGE_CSV]).to_dict())
    second = to_json(
        langfuse.load([V2_JSON, V2_JSONL, V2_CSV, LEGACY_JSON, NO_USAGE_CSV]).to_dict()
    )
    assert first == second
    assert first.encode("utf-8") == second.encode("utf-8")


def test_round_trip_through_dict():
    for run in langfuse.load(FIXTURES).runs:
        assert Run.from_dict(run.to_dict()) == run


def test_config_is_passed_to_normalization():
    config = TokenConfig(excluded_operation_names=("chat",))
    result = langfuse.load(V2_JSON, config=config)
    # every model call is named "chat" and is now excluded, so no basis notes remain
    run_a = _run(result, TRACE_A)
    assert _notes(run_a, "token_basis_absent") == []
    assert _notes(run_a, "mixed_token_basis") == []


# --- negative cases: bad rows and files --------------------------------------------------


def test_row_without_trace_id_is_an_error_and_row_without_id_is_skipped(tmp_path: Path):
    rows = [
        _gen("ok"),
        {"id": "no-trace", "type": "GENERATION", "startTime": "2024-01-01T00:00:00Z"},
        {"traceId": "trace-tmp-0001", "type": "EVENT", "startTime": "2024-01-01T00:00:00Z"},
    ]
    path = _write_json(tmp_path, "bad-rows.json", rows)
    result = langfuse.load(path)
    assert [(e.reason, e.locator) for e in result.errors] == [
        ("row has no traceId", f"{path.as_posix()}#/1")
    ]
    run = result.runs[0]
    assert [e.id for e in run.events] == ["ok"]
    assert "rows_skipped" in run.coverage.reasons
    assert run.coverage.completeness == "incomplete"
    notes = _notes(run, "rows_skipped")
    assert len(notes) == 1
    assert f"{path.as_posix()}#/2 (row has no id)" in notes[0].message


def test_invalid_files_are_errors_not_exceptions(tmp_path: Path):
    broken = tmp_path / "broken.json"
    broken.write_text("{not json")
    wrong = tmp_path / "wrong.json"
    wrong.write_text(json.dumps({"meta": {}}))
    scalar = tmp_path / "scalar.json"
    scalar.write_text("42")
    empty_csv = tmp_path / "empty.csv"
    empty_csv.write_text("")
    result = langfuse.load([broken, wrong, scalar, empty_csv, tmp_path / "missing.json"])
    assert result.runs == []
    assert [e.path for e in result.errors] == [
        broken.as_posix(),
        wrong.as_posix(),
        scalar.as_posix(),
        empty_csv.as_posix(),
        (tmp_path / "missing.json").as_posix(),
    ]
    assert result.errors[0].reason.startswith("invalid JSON")
    assert result.errors[-1].reason.startswith("cannot read file")


def test_invalid_jsonl_line_is_reported_and_others_load(tmp_path: Path):
    path = tmp_path / "mixed.jsonl"
    path.write_text(
        json.dumps(_gen("g1"))
        + "\n"
        + "{oops\n"
        + "[1, 2]\n"
        + "\n"
        + json.dumps(_gen("g2"))
        + "\n"
    )
    result = langfuse.load(path)
    assert [e.locator for e in result.errors] == [f"{path.as_posix()}#1", f"{path.as_posix()}#2"]
    assert [e.id for e in result.runs[0].events] == ["g1", "g2"]


def test_session_id_disagreement_is_noted(tmp_path: Path):
    rows = [_gen("g1", sessionId="s-b"), _gen("g2", sessionId="s-a")]
    run = langfuse.load(_write_json(tmp_path, "sessions.json", rows)).runs[0]
    assert run.conversation_id == "s-a"
    assert [n.fields for n in _notes(run, "merge_conflict")] == [["conversation_id"]]
