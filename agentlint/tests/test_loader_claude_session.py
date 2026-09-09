"""Tests for the experimental Claude Code session JSONL loader (TL-B5).

Every fixture under ``tests/fixtures/claude_session/`` is hand-written and
synthetic; see the sidecar ``.meta.json`` files.
"""

from __future__ import annotations

import builtins
import contextlib
import json
import os
from pathlib import Path
from typing import Any

import pytest

from agentlint.fingerprint import fingerprint, utf8_length
from agentlint.loaders import claude_session
from agentlint.loaders.base import LoadError, LoadResult
from agentlint.model import TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ, Event, Run, to_json

FIXTURES = Path(__file__).parent / "fixtures" / "claude_session"
HEALTHY = FIXTURES / "healthy.jsonl"
HEALTHY_SESSION = "11111111-1111-4111-8111-111111111111"


def load(*paths: str | Path, **kwargs: Any) -> LoadResult:
    return claude_session.load([str(p) for p in paths], experimental=True, **kwargs)


def only_run(result: LoadResult) -> Run:
    assert result.errors == []
    assert len(result.runs) == 1
    return result.runs[0]


def events_of(run: Run, kind: str) -> list[Event]:
    return [e for e in run.events if e.kind == kind]


def by_id(run: Run, event_id: str) -> Event:
    matches = [e for e in run.events if e.id == event_id]
    assert len(matches) == 1, event_id
    return matches[0]


def fixture_records(name: str) -> list[dict[str, Any]]:
    with (FIXTURES / name).open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


# --- Metadata --------------------------------------------------------------


def test_format_label_and_experimental_flag() -> None:
    assert claude_session.FORMAT_LABEL == "claude-session-jsonl"
    assert claude_session.EXPERIMENTAL is True
    assert claude_session.CLI_FLAG == "--experimental-claude-session"


def test_token_basis_constant_is_documented_excludes_cache_read() -> None:
    assert claude_session.CLAUDE_SESSION_TOKEN_BASIS == TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ
    assert claude_session.CLAUDE_SESSION_TOKEN_BASIS == "input_excludes_cache_read"
    docs = Path(__file__).parent.parent / "docs" / "loaders" / "claude-session.md"
    assert claude_session.CLAUDE_SESSION_TOKEN_BASIS in docs.read_text(encoding="utf-8")


@pytest.mark.parametrize("name", sorted(p.name for p in FIXTURES.rglob("*.jsonl")))
def test_every_fixture_has_synthetic_metadata(name: str) -> None:
    path = next(FIXTURES.rglob(name))
    meta_path = path.with_suffix(".meta.json")
    assert meta_path.is_file(), f"missing sidecar for {name}"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["origin"] == "synthetic"
    assert meta["ref"]
    assert meta["completeness"] in {"complete", "incomplete"}
    assert meta["excerpt_or_raw"] in {"excerpt", "raw"}


# --- Experimental gate -----------------------------------------------------


def test_load_without_opt_in_returns_single_explanatory_error() -> None:
    result = claude_session.load([str(HEALTHY)])
    assert result.format_label == "claude-session-jsonl"
    assert result.runs == []
    assert len(result.errors) == 1
    error = result.errors[0]
    assert isinstance(error, LoadError)
    assert error.path == str(HEALTHY)
    assert "experimental" in error.reason
    assert "--experimental-claude-session" in error.reason
    assert "experimental=True" in error.reason


def test_load_with_falsy_config_is_still_gated() -> None:
    assert claude_session.load([str(HEALTHY)], config={"experimental": False}).runs == []
    assert claude_session.load([str(HEALTHY)], config={}).runs == []


def test_load_enabled_by_keyword_mapping_config_or_attribute_config() -> None:
    class Config:
        experimental = True

    class NarrowConfig:
        experimental_claude_session = True

    assert len(claude_session.load([str(HEALTHY)], experimental=True).runs) == 1
    assert len(claude_session.load([str(HEALTHY)], config={"experimental": True}).runs) == 1
    assert (
        len(claude_session.load([str(HEALTHY)], config={"experimental_claude_session": True}).runs)
        == 1
    )
    assert len(claude_session.load([str(HEALTHY)], config=Config()).runs) == 1
    assert len(claude_session.load([str(HEALTHY)], config=NarrowConfig()).runs) == 1


# --- detect ----------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    ["healthy.jsonl", "unknown_type.jsonl", "sidechain.jsonl", "error_result.jsonl"],
)
def test_detect_accepts_session_logs(name: str) -> None:
    assert claude_session.detect(FIXTURES / name) is True
    assert claude_session.detect(str(FIXTURES / name)) is True


def test_detect_rejects_other_shapes_and_never_raises(tmp_path: Path) -> None:
    assert claude_session.detect(FIXTURES) is False  # a directory
    assert claude_session.detect(tmp_path / "missing.jsonl") is False
    assert claude_session.detect(FIXTURES / "healthy.meta.json") is False  # wrong suffix
    other = tmp_path / "other.jsonl"
    other.write_text('{"resourceSpans": []}\n{"resourceSpans": []}\n', encoding="utf-8")
    assert claude_session.detect(other) is False
    broken = tmp_path / "broken.jsonl"
    broken.write_bytes(b"\xff\xfe not json\n")
    assert claude_session.detect(broken) is False
    empty = tmp_path / "empty.jsonl"
    empty.write_text("", encoding="utf-8")
    assert claude_session.detect(empty) is False


def test_detect_opens_only_the_given_path(monkeypatch: pytest.MonkeyPatch) -> None:
    opened = record_opens(monkeypatch)
    claude_session.detect(HEALTHY)
    assert opened == {HEALTHY.resolve()}


# --- Healthy session: identity join and field mapping ----------------------


def test_healthy_run_identity_and_bounds() -> None:
    run = only_run(load(HEALTHY))
    assert run.id == HEALTHY_SESSION
    assert run.conversation_id == HEALTHY_SESSION
    assert run.source_format == "claude-session-jsonl"
    assert run.coverage.completeness == "complete"
    assert run.coverage.reasons == []
    assert run.started_at == 1767323045000
    assert run.ended_at == 1767323049000
    assert run.coverage.events_total == 3
    assert run.raw_records == []  # privacy: nothing verbatim survives


def test_healthy_records_claude_code_version_in_source_refs() -> None:
    run = only_run(load(HEALTHY))
    assert "claude-code-version=2.1.0" in run.source_refs
    assert str(HEALTHY) in run.source_refs


def test_healthy_assistant_messages_become_model_calls_with_usage() -> None:
    run = only_run(load(HEALTHY))
    calls = events_of(run, "model_call")
    assert [c.id for c in calls] == [
        "aaaaaaaa-0000-4000-8000-000000000002",
        "aaaaaaaa-0000-4000-8000-000000000005",
    ]
    first, second = calls
    # A streamed message is written as several lines; the last line carries the
    # final usage and stop reason, the first line's uuid is the event identity.
    assert first.tokens_in == 12
    assert first.tokens_out == 57
    assert first.cache_read_tokens == 2500
    assert first.cache_write_tokens == 400
    assert first.tokens_total is None
    assert first.token_basis == TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ
    assert first.model == "example-model-v1"
    assert first.finish_reason == "tool_use"
    assert first.status == "ok"
    assert first.adapter == "claude-code"
    assert first.start_ms == 1767323046000
    assert first.source_locator == f"{HEALTHY}:3"
    assert first.scope["claude_session"]["message_id"] == "msg_synthetic_0001"
    assert first.scope["claude_session"]["record_uuids"] == [
        "aaaaaaaa-0000-4000-8000-000000000002",
        "aaaaaaaa-0000-4000-8000-000000000003",
    ]
    assert first.scope["claude_session"]["parent_uuid"] == "aaaaaaaa-0000-4000-8000-000000000001"
    assert second.tokens_in == 30
    assert second.tokens_out == 14
    assert second.cache_read_tokens == 2900
    assert second.cache_write_tokens == 0  # a zero the log carried, not an absent value
    assert second.finish_reason == "end_turn"
    assert second.source_locator == f"{HEALTHY}:6"


def test_healthy_tool_use_and_tool_result_join_into_one_tool_call() -> None:
    run = only_run(load(HEALTHY))
    (call,) = events_of(run, "tool_call")
    records = fixture_records("healthy.jsonl")
    tool_use = records[3]["message"]["content"][0]
    tool_result = records[4]["message"]["content"][0]
    assert call.id == "toolu_synthetic_0001"
    assert call.tool_call_id == "toolu_synthetic_0001"
    assert call.native_tool_call_id == "toolu_synthetic_0001"
    assert call.name == "Read"
    assert call.status == "ok"
    assert call.parent_id == "aaaaaaaa-0000-4000-8000-000000000002"
    assert call.args_fingerprint == fingerprint(tool_use["input"])
    assert call.result_fingerprint == fingerprint(tool_result["content"])
    assert call.result_bytes == utf8_length(tool_result["content"])
    assert call.result_bytes == len(tool_result["content"].encode("utf-8"))
    assert call.start_ms == 1767323046500
    assert call.end_ms == 1767323047250
    assert call.duration_ms == 750
    assert call.source_locator == f"{HEALTHY}:4#/message/content/0"
    assert call.scope["claude_session"]["result_locator"] == f"{HEALTHY}:5#/message/content/0"


def test_healthy_seq_follows_parent_uuid_chain() -> None:
    run = only_run(load(HEALTHY))
    seqs = {e.id: e.seq for e in run.events}
    assert seqs["aaaaaaaa-0000-4000-8000-000000000002"] == 1
    assert seqs["toolu_synthetic_0001"] == 2
    assert seqs["aaaaaaaa-0000-4000-8000-000000000005"] == 4
    assert [e.id for e in run.events] == [e.id for e in run.sorted_events()]


def test_healthy_ignored_record_type_is_noted_not_incomplete() -> None:
    run = only_run(load(HEALTHY))
    codes = {n.code for n in run.coverage.notes}
    assert "ignored_record_type" in codes
    note = next(n for n in run.coverage.notes if n.code == "ignored_record_type")
    assert "file-history-snapshot" in note.message
    assert run.coverage.completeness == "complete"


def test_output_never_contains_prompt_text_tool_input_or_cwd() -> None:
    result = load(HEALTHY)
    text = to_json(result.to_dict())
    records = fixture_records("healthy.jsonl")
    assert records[0]["message"]["content"] not in text
    assert "README" not in text
    assert "/synthetic/project" not in text
    assert "Synthetic" not in text


# --- Unknown shapes --------------------------------------------------------


def test_unknown_top_level_type_marks_run_incomplete_and_names_it() -> None:
    run = only_run(load(FIXTURES / "unknown_type.jsonl"))
    assert run.coverage.completeness == "incomplete"
    assert "unknown_record_type:mystery-record" in run.coverage.reasons
    note = next(n for n in run.coverage.notes if n.code == "unknown_record_type")
    assert "mystery-record" in note.message
    assert f"{FIXTURES / 'unknown_type.jsonl'}:2" in note.message
    # the assistant message on the same file still maps
    assert len(events_of(run, "model_call")) == 1


def test_unknown_content_block_type_marks_run_incomplete_and_names_it() -> None:
    run = only_run(load(FIXTURES / "unknown_type.jsonl"))
    assert "unknown_content_block:widget" in run.coverage.reasons
    note = next(n for n in run.coverage.notes if n.code == "unknown_content_block")
    assert "widget" in note.message
    assert "#/message/content/0" in note.message


def test_unparseable_line_marks_run_incomplete(tmp_path: Path) -> None:
    path = tmp_path / "bad.jsonl"
    lines = HEALTHY.read_text(encoding="utf-8").splitlines()
    lines.insert(2, "{not json")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    run = only_run(load(path))
    assert run.coverage.completeness == "incomplete"
    assert f"unparseable_line:{path}:3" in run.coverage.reasons


def test_assistant_message_without_usage_has_null_tokens_and_no_basis(tmp_path: Path) -> None:
    records = fixture_records("healthy.jsonl")
    del records[5]["message"]["usage"]
    path = tmp_path / "no_usage.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    run = only_run(load(path))
    call = by_id(run, "aaaaaaaa-0000-4000-8000-000000000005")
    assert call.tokens_in is None
    assert call.tokens_out is None
    assert call.cache_read_tokens is None
    assert call.cache_write_tokens is None
    assert call.token_basis is None
    assert call.status == "unknown"


# --- Negative inputs -------------------------------------------------------


def test_missing_path_and_empty_file_are_load_errors(tmp_path: Path) -> None:
    empty = tmp_path / "empty.jsonl"
    empty.write_text("\n\n", encoding="utf-8")
    result = load(tmp_path / "missing.jsonl", empty)
    assert result.runs == []
    assert [e.path for e in result.errors] == [str(empty), str(tmp_path / "missing.jsonl")]
    assert "no JSON records" in result.errors[0].reason


def test_file_without_session_id_is_a_load_error(tmp_path: Path) -> None:
    path = tmp_path / "nosession.jsonl"
    path.write_text('{"type":"summary","summary":"x","leafUuid":"u"}\n', encoding="utf-8")
    result = load(path)
    assert result.runs == []
    assert len(result.errors) == 1
    assert "sessionId" in result.errors[0].reason


def test_directory_without_jsonl_files_is_a_load_error(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("nothing", encoding="utf-8")
    result = load(tmp_path)
    assert result.runs == []
    assert result.errors == [
        LoadError(path=str(tmp_path), reason="directory holds no *.jsonl files")
    ]


# --- Sidechains ------------------------------------------------------------


def test_sidechain_with_agent_id_becomes_a_separate_run() -> None:
    result = load(FIXTURES / "sidechain.jsonl")
    assert result.errors == []
    runs = {r.id: r for r in result.runs}
    parent_session = "33333333-3333-4333-8333-333333333333"
    assert set(runs) == {parent_session, "agent-synthetic-0001"}
    parent, agent = runs[parent_session], runs["agent-synthetic-0001"]
    assert parent.coverage.completeness == "complete"
    assert agent.coverage.completeness == "complete"
    assert agent.conversation_id == parent_session
    # never merged into the parent as if sequential
    parent_ids = {e.id for e in parent.events}
    agent_ids = {e.id for e in agent.events}
    assert parent_ids == {
        "cccccccc-0000-4000-8000-000000000002",
        "toolu_synthetic_0201",
        "cccccccc-0000-4000-8000-000000000004",
    }
    assert agent_ids == {
        "cccccccc-0000-4000-8000-000000000102",
        "toolu_synthetic_0202",
        "cccccccc-0000-4000-8000-000000000104",
    }
    assert parent_ids.isdisjoint(agent_ids)
    split = next(n for n in parent.coverage.notes if n.code == "sidechain_split")
    assert "agent-synthetic-0001" in split.message
    # the parent's delegation call still joins with its result
    task = by_id(parent, "toolu_synthetic_0201")
    assert task.name == "Agent"
    assert task.status == "ok"
    assert task.result_bytes is not None


def test_sidechain_without_agent_id_marks_parent_incomplete_and_is_not_merged() -> None:
    run = only_run(load(FIXTURES / "sidechain_no_agent.jsonl"))
    assert run.coverage.completeness == "incomplete"
    assert "sidechain_without_agent_id" in run.coverage.reasons
    note = next(n for n in run.coverage.notes if n.code == "sidechain_without_agent_id")
    assert "3 isSidechain record(s)" in note.message
    ids = {e.id for e in run.events}
    assert "toolu_synthetic_0302" not in ids
    assert "dddddddd-0000-4000-8000-000000000102" not in ids
    assert ids == {
        "dddddddd-0000-4000-8000-000000000002",
        "toolu_synthetic_0301",
        "dddddddd-0000-4000-8000-000000000004",
    }


# --- Split sessions and directories ----------------------------------------


def test_session_split_across_two_files_merges_into_one_run() -> None:
    session = "55555555-5555-4555-8555-555555555555"
    result = load(FIXTURES / "split" / "part1.jsonl", FIXTURES / "split" / "part2.jsonl")
    run = only_run(result)
    assert run.id == session
    assert run.coverage.completeness == "complete"
    assert run.coverage.reasons == []
    assert run.started_at == 1767690000000
    assert run.ended_at == 1767690003000
    assert "claude-code-version=2.1.0" in run.source_refs
    assert "claude-code-version=2.1.1" in run.source_refs
    call = by_id(run, "toolu_synthetic_0401")
    assert call.name == "Bash"
    assert call.status == "ok"
    assert call.args_fingerprint is not None
    assert call.result_fingerprint is not None
    assert call.result_bytes == 24
    assert call.start_ms == 1767690001000
    assert call.end_ms == 1767690002000
    assert {n.code for n in run.coverage.notes} >= {"dedup_merged"}
    assert run.coverage.events_dropped_dedup == 1


def test_directory_argument_reads_only_jsonl_files_directly_inside() -> None:
    from_dir = load(FIXTURES / "split")
    from_files = load(FIXTURES / "split" / "part1.jsonl", FIXTURES / "split" / "part2.jsonl")
    assert to_json(from_dir.to_dict()) == to_json(from_files.to_dict())


def test_first_part_alone_leaves_tool_call_without_result() -> None:
    run = only_run(load(FIXTURES / "split" / "part1.jsonl"))
    call = by_id(run, "toolu_synthetic_0401")
    assert call.status == "unknown"
    assert call.result_bytes is None
    assert call.result_fingerprint is None
    assert call.end_ms is None
    assert run.coverage.completeness == "complete"


def test_second_part_alone_flags_orphan_tool_result() -> None:
    run = only_run(load(FIXTURES / "split" / "part2.jsonl"))
    assert run.coverage.completeness == "incomplete"
    assert "tool_result_without_tool_use" in run.coverage.reasons
    call = by_id(run, "toolu_synthetic_0401")
    assert call.name is None
    assert call.args_fingerprint is None
    assert call.status == "ok"
    assert call.result_bytes == 24
    note = next(n for n in run.coverage.notes if n.code == "tool_result_without_tool_use")
    assert note.event_ids == ["toolu_synthetic_0401"]


# --- Error results ---------------------------------------------------------


def test_error_tool_result_maps_to_error_status_with_bytes_and_fingerprint() -> None:
    run = only_run(load(FIXTURES / "error_result.jsonl"))
    records = fixture_records("error_result.jsonl")
    failed = by_id(run, "toolu_synthetic_0501")
    error_content = records[3]["message"]["content"][0]["content"]
    assert failed.status == "error"
    assert failed.error_type == "tool_error"
    assert failed.result_bytes == len(error_content.encode("utf-8"))
    assert failed.result_fingerprint == fingerprint(error_content)
    assert run.coverage.completeness == "complete"


def test_short_tool_result_keeps_bytes_but_no_fingerprint() -> None:
    run = only_run(load(FIXTURES / "error_result.jsonl"))
    ok = by_id(run, "toolu_synthetic_0502")
    assert ok.status == "ok"
    assert ok.error_type is None
    assert ok.result_bytes == 10
    assert ok.result_fingerprint is None  # 10 bytes is below the 16-byte hashing minimum


def test_tool_use_blocks_on_different_lines_of_one_message_share_the_model_call() -> None:
    run = only_run(load(FIXTURES / "error_result.jsonl"))
    calls = events_of(run, "model_call")
    assert len(calls) == 2
    first = calls[0]
    assert first.tokens_out == 48  # final usage from the last line of the streamed message
    assert first.finish_reason == "tool_use"
    for tool_id in ("toolu_synthetic_0501", "toolu_synthetic_0502"):
        assert by_id(run, tool_id).parent_id == first.id


# --- Timestamps ------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("2026-01-02T03:04:05.678Z", 1767323045678),
        ("2026-01-02T03:04:05Z", 1767323045000),
        ("2026-01-02T04:04:05+01:00", 1767323045000),
        ("2026-01-02T03:04:05", 1767323045000),
        ("not a timestamp", None),
        ("", None),
        (None, None),
        (1767323045000, None),
    ],
)
def test_parse_timestamp_ms(value: Any, expected: int | None) -> None:
    assert claude_session.parse_timestamp_ms(value) == expected


# --- Determinism -----------------------------------------------------------


def test_load_is_byte_deterministic() -> None:
    paths = sorted(str(p) for p in FIXTURES.rglob("*.jsonl"))
    first = to_json(load(*paths).to_dict())
    second = to_json(load(*paths).to_dict())
    reversed_order = to_json(load(*reversed(paths)).to_dict())
    assert first == second == reversed_order
    parsed = json.loads(first)
    assert [r["id"] for r in parsed["runs"]] == sorted(r["id"] for r in parsed["runs"])


def test_run_round_trips_through_json() -> None:
    for run in load(*sorted(FIXTURES.rglob("*.jsonl"))).runs:
        assert Run.from_dict(json.loads(to_json(run))) == run


# --- Path confinement ------------------------------------------------------


def record_opens(monkeypatch: pytest.MonkeyPatch) -> set[Path]:
    """Patch ``open`` / ``Path.open`` / ``os.open`` to record every path opened."""
    opened: set[Path] = set()
    real_open = builtins.open
    real_path_open = Path.open
    real_os_open = os.open

    def record(target: Any) -> None:
        if isinstance(target, int):
            return
        opened.add(Path(os.fsdecode(target)).resolve())

    def fake_open(file: Any, *args: Any, **kwargs: Any) -> Any:
        record(file)
        return real_open(file, *args, **kwargs)

    def fake_path_open(self: Path, *args: Any, **kwargs: Any) -> Any:
        record(self)
        return real_path_open(self, *args, **kwargs)

    def fake_os_open(path: Any, *args: Any, **kwargs: Any) -> Any:
        record(path)
        return real_os_open(path, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", fake_open)
    monkeypatch.setattr(Path, "open", fake_path_open)
    monkeypatch.setattr(os, "open", fake_os_open)
    return opened


def test_load_opens_only_jsonl_files_directly_inside_given_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inside = tmp_path / "sessions"
    inside.mkdir()
    (inside / "a.jsonl").write_text(HEALTHY.read_text(encoding="utf-8"), encoding="utf-8")
    (inside / "notes.json").write_text("{}", encoding="utf-8")
    (inside / "notes.txt").write_text("plain", encoding="utf-8")
    nested = inside / "subagents"
    nested.mkdir()
    (nested / "nested.jsonl").write_text(HEALTHY.read_text(encoding="utf-8"), encoding="utf-8")
    outside = tmp_path / "elsewhere.jsonl"
    outside.write_text(HEALTHY.read_text(encoding="utf-8"), encoding="utf-8")
    with contextlib.suppress(OSError):  # platforms without symlink support
        (inside / "link.jsonl").symlink_to(outside)

    opened = record_opens(monkeypatch)
    result = load(inside)
    assert len(result.runs) == 1
    assert opened == {(inside / "a.jsonl").resolve()}


def test_load_with_explicit_files_opens_exactly_those(monkeypatch: pytest.MonkeyPatch) -> None:
    opened = record_opens(monkeypatch)
    part1 = FIXTURES / "split" / "part1.jsonl"
    load(HEALTHY, part1)
    assert opened == {HEALTHY.resolve(), part1.resolve()}
