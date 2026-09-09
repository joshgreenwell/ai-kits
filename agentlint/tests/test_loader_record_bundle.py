"""Tests for the record-bundle loader and its published schema (TL-B4, JG-124).

Every fixture under ``tests/fixtures/record_bundle/`` is synthetic and says so in
its ``_fixture`` block.
"""

from __future__ import annotations

import json
import re
from dataclasses import fields as dataclass_fields
from pathlib import Path
from typing import Any

import pytest

from agentlint.loaders import record_bundle as rb
from agentlint.loaders.base import LoadError, LoadResult
from agentlint.model import EVENT_KINDS, EVENT_STATUSES, REPRESENTATIONS, Event, Run, to_json
from agentlint.tokens import TokenConfig
from tests.conftest import FIXTURES, make_event, make_run

BUNDLES = FIXTURES / "record_bundle"
VALID = BUNDLES / "valid_bundle.json"
VIOLATIONS = BUNDLES / "schema_violations.json"
PREVIEW_ONLY = BUNDLES / "preview_only.json"
TWO_FILE_DIR = BUNDLES / "two_file_run"
DOCS = Path(__file__).resolve().parents[1] / "docs"
SCHEMA_FILE = DOCS / "record-bundle.schema.json"
DOC_FILE = DOCS / "record-bundle.md"


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_bundle(path: Path, doc: Any) -> Path:
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def minimal_bundle(**overrides: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {"schema_version": "1", "run_id": "run-t-0001", "records": []}
    doc.update(overrides)
    return doc


def one_run(result: LoadResult) -> Run:
    assert result.errors == []
    assert len(result.runs) == 1
    return result.runs[0]


# --- Fixture hygiene ---------------------------------------------------------


class TestFixtureMetadata:
    @pytest.mark.parametrize("path", sorted(BUNDLES.rglob("*.json")), ids=lambda p: p.name)
    def test_every_fixture_declares_synthetic_origin(self, path: Path) -> None:
        meta = read_json(path)["_fixture"]
        assert meta["origin"] == "synthetic"
        assert set(meta) >= {"origin", "ref", "completeness", "excerpt_or_raw"}
        assert meta["completeness"] in {"complete", "incomplete"}
        assert meta["excerpt_or_raw"] in {"excerpt", "raw"}


# --- detect() ------------------------------------------------------------------


class TestDetect:
    def test_format_label(self) -> None:
        assert rb.FORMAT_LABEL == "record-bundle"

    def test_detects_bundle_file_and_directory(self) -> None:
        assert rb.detect(VALID) is True
        assert rb.detect(str(VALID)) is True
        assert rb.detect(TWO_FILE_DIR) is True

    def test_rejects_other_json_and_non_json(self, tmp_path: Path) -> None:
        assert rb.detect(FIXTURES / "run_mixed_basis.json") is False
        assert rb.detect(DOC_FILE) is False
        assert rb.detect(write_bundle(tmp_path / "list.json", [1, 2])) is False
        assert rb.detect(write_bundle(tmp_path / "partial.json", {"run_id": "r"})) is False

    def test_never_raises(self, tmp_path: Path) -> None:
        assert rb.detect(tmp_path / "missing.json") is False
        assert rb.detect(tmp_path) is False  # empty directory
        (tmp_path / "broken.json").write_text("{", encoding="utf-8")
        assert rb.detect(tmp_path / "broken.json") is False


# --- Valid bundle ----------------------------------------------------------------


class TestValidBundle:
    @pytest.fixture
    def run(self) -> Run:
        return one_run(rb.load(VALID))

    def test_one_run_with_the_format_label(self, run: Run) -> None:
        assert run.source_format == "record-bundle"
        assert run.id == "run-bundle-0001"
        assert run.conversation_id == "conv-bundle-0001"
        assert run.source_refs == ["exampleapp/debug-report-0001"]
        assert run.started_at == 1700000000000
        assert run.ended_at == 1700000060000

    def test_every_kind_loads_in_canonical_order(self, run: Run) -> None:
        assert [e.id for e in run.events] == [
            "agg-01",
            "mc-01",
            "tc-01",
            "ap-01",
            "tc-02",
            "mc-02",
            "tc-03",
            "ot-01",
        ]
        assert {e.kind for e in run.events} == EVENT_KINDS
        assert run.coverage.events_total == 8
        assert run.coverage.events_dropped_dedup == 0
        assert run.coverage.completeness == "complete"
        assert run.coverage.reasons == []

    def test_blocked_approval_and_aggregate_children(self, run: Run) -> None:
        by_id = {e.id: e for e in run.events}
        assert by_id["ap-01"].kind == "approval"
        assert by_id["ap-01"].status == "blocked"
        assert by_id["ap-01"].tool_call_id == "call-0002"
        assert by_id["agg-01"].kind == "aggregate"
        assert by_id["agg-01"].included_result_ids == ["mc-01", "mc-02"]
        assert by_id["mc-01"].parent_id == "agg-01"

    def test_scope_passes_through_untouched(self, run: Run) -> None:
        doc = read_json(VALID)
        by_id = {e.id: e for e in run.events}
        for record in doc["records"]:
            assert by_id[record["id"]].scope == record.get("scope", {})
        assert by_id["tc-01"].scope == {
            "exampleapp": {"targets": ["target-a", "target-b"], "selection": "explicit"}
        }
        assert by_id["tc-03"].scope["exampleapp"]["selection"] == "single"

    def test_fingerprints_sizes_and_token_basis(self, run: Run) -> None:
        by_id = {e.id: e for e in run.events}
        tc = by_id["tc-01"]
        assert tc.args_fingerprint is not None
        assert tc.args_fingerprint.representation == "full"
        assert tc.args_fingerprint.hash.startswith("3626c398")
        assert tc.result_fingerprint is not None
        assert tc.result_bytes == 2048
        assert tc.preview_bytes == 512
        assert tc.native_tool_call_id == "native-0001"
        assert tc.error_type == "TargetUnavailable"
        assert tc.error_code == "E_TARGET"
        assert by_id["mc-01"].token_basis == "input_excludes_cache_read"
        assert by_id["mc-01"].adapter == "sdk-neutral"

    def test_absent_stays_none_and_zero_stays_zero(self, run: Run) -> None:
        by_id = {e.id: e for e in run.events}
        assert by_id["tc-01"].tokens_in is None
        assert by_id["tc-02"].result_bytes is None
        assert by_id["tc-02"].result_fingerprint is None
        assert by_id["ot-01"].start_ms is None
        assert by_id["ot-01"].duration_ms == 5
        assert by_id["mc-01"].cache_write_tokens == 0
        assert by_id["mc-02"].cache_write_tokens is None

    def test_app_locators_are_kept_verbatim(self, run: Run) -> None:
        assert all(
            e.source_locator.startswith("exampleapp/debug-report-0001/rows/") for e in run.events
        )

    def test_different_tool_call_ids_are_not_merged(self, run: Run) -> None:
        by_id = {e.id: e for e in run.events}
        # tc-01 and tc-02 share args_fingerprint; only tool_call_id separates them.
        assert by_id["tc-01"].args_fingerprint == by_id["tc-02"].args_fingerprint
        assert {"tc-01", "tc-02"} <= set(by_id)
        # The approval and the tool call it decided share call-0002 as two events.
        assert [e.id for e in run.events if e.tool_call_id == "call-0002"] == ["ap-01", "tc-02"]

    def test_document_is_retained_verbatim_with_final_status(self, run: Run) -> None:
        assert run.raw_records == [read_json(VALID)]
        assert rb.bundle_documents(run) == run.raw_records
        header = rb.bundle_headers(run)[0]
        assert "records" not in header
        assert header["final_status"] == "failed"
        assert header["_fixture"]["origin"] == "synthetic"
        assert rb.final_status(run) == "failed"

    def test_coverage_fields_reflect_the_data(self, run: Run) -> None:
        fields = run.coverage.fields
        assert fields["tool_call_id"] == "present"
        assert fields["args_fingerprint"] == "present"
        assert fields["result_bytes"] == "partial"  # tc-02 (blocked) has none
        assert fields["start_ms"] == "partial"  # ot-01 has none

    def test_config_is_passed_to_normalization(self) -> None:
        run = one_run(rb.load(VALID, config=TokenConfig(tag_namespace="exampleapp")))
        assert run.coverage.events_total == 8


# --- Schema violations inside records ----------------------------------------------

EXPECTED_VIOLATIONS: list[tuple[str, str]] = [
    ("/records/1", "missing required property 'id'"),
    ("/records/2/kind", "must be one of"),
    ("/records/3/tokens_in", "expected integer, got number"),
    ("/records/4/result_bytes", "expected integer, got null"),
    ("/records/5/result_size", "unexpected property"),
    ("/records/6/args_fingerprint", "missing required property 'representation'"),
    ("/records/7/scope/exampleapp", "expected object, got string"),
    ("/records/8/result_bytes", "must be >= 0"),
    ("/records/10", "expected object, got string"),
    ("/records/11/id", "must be at least 1 long"),
    ("/records/12/result_fingerprint/hash", "must match ^[0-9a-f]+$"),
    ("/records/13/tokens_out", "expected integer, got boolean"),
    ("/records/14/status", "must be one of"),
]


class TestSchemaViolations:
    @pytest.fixture
    def run(self) -> Run:
        return one_run(rb.load(VIOLATIONS))

    def test_valid_records_load_and_run_is_incomplete(self, run: Run) -> None:
        assert [e.id for e in run.events] == ["mc-10", "tc-19"]
        assert run.coverage.events_total == 2
        assert run.coverage.completeness == "incomplete"
        assert run.raw_records == [read_json(VIOLATIONS)]  # dropped records stay as evidence

    @pytest.mark.parametrize(("pointer", "message"), EXPECTED_VIOLATIONS, ids=lambda x: x)
    def test_each_violation_is_a_reason_with_a_pointer(
        self, run: Run, pointer: str, message: str
    ) -> None:
        expected = f"schema violation at {VIOLATIONS}#{pointer}: {message}"
        assert any(r.startswith(expected) for r in run.coverage.reasons), run.coverage.reasons

    def test_exactly_one_reason_per_violation(self, run: Run) -> None:
        assert len(run.coverage.reasons) == len(EXPECTED_VIOLATIONS)

    def test_one_note_per_dropped_record_naming_fields_and_id(self, run: Run) -> None:
        notes = [n for n in run.coverage.notes if n.code == "schema_violation"]
        assert len(notes) == len(EXPECTED_VIOLATIONS)
        by_first_id = {n.event_ids[0]: n for n in notes if n.event_ids}
        assert by_first_id["mc-13"].fields == ["tokens_in"]
        assert by_first_id["tc-17"].fields == ["scope"]
        assert by_first_id["tc-22"].fields == ["result_fingerprint"]
        assert f"{VIOLATIONS}#/records/3" in by_first_id["mc-13"].message
        # A record without a usable id cites no id rather than an invented one.
        no_id = [n for n in notes if not n.event_ids]
        assert len(no_id) == 3  # records 1 (missing id), 10 (a string), 11 (empty id)

    def test_null_is_a_violation_not_none(self, run: Run) -> None:
        assert "tc-14" not in {e.id for e in run.events}


# --- Top-level problems are LoadErrors --------------------------------------------


class TestTopLevelInvalid:
    @pytest.mark.parametrize(
        ("doc", "pointer", "message"),
        [
            (minimal_bundle(schema_version="2"), "/schema_version", 'must be one of "1"'),
            ({"schema_version": "1", "records": []}, "", "missing required property 'run_id'"),
            (minimal_bundle(records={}), "/records", "expected array, got object"),
            (minimal_bundle(run_id=""), "/run_id", "must be at least 1 long"),
            (minimal_bundle(started_at=1.5), "/started_at", "expected integer, got number"),
            (minimal_bundle(conversation_id=None), "/conversation_id", "got null"),
            ([], "", "expected object, got array"),
            ("text", "", "expected object, got string"),
        ],
        ids=[
            "unknown-version",
            "missing-run-id",
            "records-not-array",
            "empty-run-id",
            "float-timestamp",
            "null-conversation",
            "array-document",
            "string-document",
        ],
    )
    def test_invalid_top_level_is_a_load_error(
        self, tmp_path: Path, doc: Any, pointer: str, message: str
    ) -> None:
        path = write_bundle(tmp_path / "bad.json", doc)
        result = rb.load(path)
        assert result.runs == []
        assert len(result.errors) == 1
        error = result.errors[0]
        assert error.path == str(path)
        assert error.locator == f"{path}#{pointer}"
        assert message in error.reason

    def test_invalid_json_and_missing_file(self, tmp_path: Path) -> None:
        broken = tmp_path / "broken.json"
        broken.write_text("{not json", encoding="utf-8")
        result = rb.load([broken, tmp_path / "missing.json"])
        assert result.runs == []
        assert [e.path for e in result.errors] == [str(broken), str(tmp_path / "missing.json")]
        assert result.errors[0].reason.startswith("invalid JSON")
        assert result.errors[1].reason.startswith("cannot read file")

    def test_empty_directory(self, tmp_path: Path) -> None:
        result = rb.load(tmp_path)
        assert result.runs == []
        assert result.errors == [
            LoadError(path=str(tmp_path), reason="directory contains no .json files")
        ]

    def test_one_bad_file_does_not_stop_the_others(self, tmp_path: Path) -> None:
        write_bundle(tmp_path / "a.json", minimal_bundle(run_id="run-a"))
        write_bundle(tmp_path / "b.json", minimal_bundle(schema_version="9"))
        result = rb.load(tmp_path)
        assert [r.id for r in result.runs] == ["run-a"]
        assert [e.path for e in result.errors] == [str(tmp_path / "b.json")]


# --- preview_bytes without result_bytes -------------------------------------------------


class TestPreviewOnly:
    @pytest.fixture
    def run(self) -> Run:
        return one_run(rb.load(PREVIEW_ONLY))

    def test_result_bytes_stays_absent(self, run: Run) -> None:
        tool_calls = [e for e in run.events if e.kind == "tool_call"]
        assert len(tool_calls) == 2
        assert all(e.result_bytes is None for e in tool_calls)
        assert all(e.preview_bytes == 4096 for e in tool_calls)
        assert run.coverage.fields["result_bytes"] == "absent"

    def test_preview_only_note_names_the_events(self, run: Run) -> None:
        notes = [n for n in run.coverage.notes if n.code == "preview_only"]
        assert len(notes) == 1
        assert notes[0].fields == ["result_bytes", "preview_bytes"]
        assert notes[0].event_ids == ["tc-30", "tc-31"]

    def test_default_locator_is_the_json_pointer(self, run: Run) -> None:
        assert [e.source_locator for e in run.events] == [
            f"{PREVIEW_ONLY}#/records/{i}" for i in range(3)
        ]

    def test_mixed_sizes_are_partial(self, tmp_path: Path) -> None:
        doc = minimal_bundle(
            records=[
                {"id": "a", "kind": "tool_call", "status": "ok", "preview_bytes": 10},
                {"id": "b", "kind": "tool_call", "status": "ok", "result_bytes": 10},
            ]
        )
        run = one_run(rb.load(write_bundle(tmp_path / "mixed.json", doc)))
        assert run.coverage.fields["result_bytes"] == "partial"
        assert {e.id: e.result_bytes for e in run.events} == {"a": None, "b": 10}

    def test_no_note_when_full_sizes_are_present(self) -> None:
        run = one_run(rb.load(VALID))
        assert all(n.code != "preview_only" for n in run.coverage.notes)


# --- Two files, one run -------------------------------------------------------------


class TestTwoFileRun:
    @pytest.fixture
    def run(self) -> Run:
        return one_run(rb.load(TWO_FILE_DIR))

    def test_directory_merges_by_run_id(self, run: Run) -> None:
        assert run.id == "run-bundle-0004"
        assert [e.id for e in run.events] == ["mc-41", "tc-41", "mc-42", "ot-42"]
        assert run.coverage.events_total == 4
        assert run.coverage.events_dropped_dedup == 1
        assert len(rb.bundle_documents(run)) == 2

    def test_duplicate_record_collapses_to_the_richer_one(self, run: Run) -> None:
        tc = next(e for e in run.events if e.id == "tc-41")
        assert tc.status == "ok"
        assert tc.result_bytes == 640
        assert tc.end_ms == 1700000302000
        assert tc.source_locator == f"{TWO_FILE_DIR / 'part-2.json'}#/records/0"
        assert any(
            n.code == "dedup_merged" and n.event_ids == ["tc-41"] for n in run.coverage.notes
        )

    def test_header_fields_merge(self, run: Run) -> None:
        assert run.conversation_id == "conv-bundle-0004"
        assert run.source_refs == [
            "exampleapp/debug-report-0004/page-1",
            "exampleapp/debug-report-0004/page-2",
        ]
        assert run.started_at == 1700000300000
        assert run.ended_at == 1700000310000
        assert rb.final_status(run) == "completed"

    def test_unknown_top_level_key_is_noted_not_fatal(self, run: Run) -> None:
        notes = [n for n in run.coverage.notes if n.code == "unknown_top_level_keys"]
        assert len(notes) == 1
        assert "exported_by" in notes[0].message
        assert run.coverage.completeness == "complete"

    def test_explicit_files_in_any_order_give_identical_output(self, run: Run) -> None:
        part1, part2 = TWO_FILE_DIR / "part-1.json", TWO_FILE_DIR / "part-2.json"
        forward = rb.load([part1, part2])
        backward = rb.load([str(part2), str(part1)])
        assert to_json(forward.runs[0]) == to_json(run)
        assert to_json(backward.runs[0]) == to_json(run)

    def test_different_run_ids_stay_separate(self) -> None:
        # Files are read in sorted path order, whatever order they were given in.
        result = rb.load([VALID, PREVIEW_ONLY])
        assert [r.id for r in result.runs] == ["run-bundle-0003", "run-bundle-0001"]
        assert result.errors == []

    def test_disagreeing_final_status_is_none(self, tmp_path: Path) -> None:
        write_bundle(tmp_path / "a.json", minimal_bundle(final_status="failed"))
        write_bundle(tmp_path / "b.json", minimal_bundle(final_status="completed"))
        assert rb.final_status(one_run(rb.load(tmp_path))) is None


# --- Determinism ----------------------------------------------------------------------


class TestDeterminism:
    @pytest.mark.parametrize(
        "path", [VALID, VIOLATIONS, PREVIEW_ONLY, TWO_FILE_DIR], ids=lambda p: p.name
    )
    def test_loading_twice_is_byte_identical(self, path: Path) -> None:
        first = rb.load(path).to_dict()
        second = rb.load(path).to_dict()
        assert to_json(first) == to_json(second)

    def test_record_order_in_the_file_does_not_matter(self, tmp_path: Path) -> None:
        doc = read_json(VALID)
        shuffled = dict(doc)
        shuffled["records"] = list(reversed(doc["records"]))
        run_a = one_run(rb.load(VALID))
        run_b = one_run(rb.load(write_bundle(tmp_path / "reversed.json", shuffled)))
        assert run_a.events == run_b.events
        assert run_a.coverage == run_b.coverage


# --- Schema self-check -----------------------------------------------------------------


def schema_keywords(schema: Any) -> set[str]:
    """Every keyword used anywhere in ``schema`` (property names excluded)."""
    if not isinstance(schema, dict):
        return set()
    found = set(schema)
    for key, value in schema.items():
        if key in {"properties", "$defs"}:
            for sub in value.values():
                found |= schema_keywords(sub)
        elif key in {"items", "additionalProperties"}:
            found |= schema_keywords(value)
    return found


class TestSchemaSelfCheck:
    def test_published_file_is_generated_from_the_module(self) -> None:
        text = SCHEMA_FILE.read_text(encoding="utf-8")
        assert json.loads(text) == rb.SCHEMA
        assert text == rb.schema_json()

    def test_draft_and_identity(self) -> None:
        assert rb.SCHEMA["$schema"] == "https://json-schema.org/draft/2020-12/schema"
        assert rb.SCHEMA["$id"] == rb.SCHEMA_ID
        assert rb.SCHEMA["required"] == ["schema_version", "run_id", "records"]
        assert rb.SCHEMA["properties"]["schema_version"]["enum"] == list(rb.SCHEMA_VERSIONS)

    def test_every_event_field_has_a_record_property(self) -> None:
        properties = rb.SCHEMA["$defs"]["record"]["properties"]
        event_fields = {f.name for f in dataclass_fields(Event)}
        assert event_fields <= set(properties)
        assert set(properties) - event_fields == {"raw"}
        assert rb.SCHEMA["$defs"]["record"]["additionalProperties"] is False

    def test_vocabularies_match_the_model(self) -> None:
        record = rb.SCHEMA["$defs"]["record"]["properties"]
        assert set(record["kind"]["enum"]) == EVENT_KINDS
        assert set(record["status"]["enum"]) == EVENT_STATUSES
        fingerprint = rb.SCHEMA["$defs"]["fingerprint"]
        assert set(fingerprint["properties"]["representation"]["enum"]) == REPRESENTATIONS
        assert fingerprint["required"] == ["hash", "representation"]

    def test_no_null_and_integer_only_counts(self) -> None:
        record = rb.SCHEMA["$defs"]["record"]["properties"]
        for name, prop in {**record, **rb.SCHEMA["properties"]}.items():
            types = prop.get("type")
            types = [types] if isinstance(types, str) else (types or [])
            assert "null" not in types, name
            if name != "raw":  # raw is opaque and may be any non-null JSON value
                assert "number" not in types, name
            if "integer" in types:
                assert prop["minimum"] == 0, name

    def test_validator_covers_every_keyword_the_schema_uses(self) -> None:
        used = schema_keywords(rb.SCHEMA)
        assert used <= rb.SUPPORTED_KEYWORDS | rb.ANNOTATION_KEYWORDS, used

    def test_worked_example_in_the_docs_is_valid(self) -> None:
        text = DOC_FILE.read_text(encoding="utf-8")
        match = re.search(r"```json\n(.*?)```", text, re.S)
        assert match is not None
        example = json.loads(match.group(1))
        assert rb.validate(example) == []
        kinds = {r["kind"] for r in example["records"]}
        assert kinds >= {"model_call", "tool_call", "approval", "aggregate"}

    def test_docs_state_that_the_loader_validates(self) -> None:
        text = DOC_FILE.read_text(encoding="utf-8")
        assert "validates every document against the published schema" in text
        assert "record-bundle.schema.json" in text


# --- Validator unit tests --------------------------------------------------------------


class TestValidator:
    def test_type_list_and_boolean_schemas(self) -> None:
        schema = {"type": ["string", "integer"]}
        assert rb.validate("x", schema) == []
        assert rb.validate(3, schema) == []
        assert rb.validate(3.5, schema)[0].keyword == "type"
        assert rb.validate(True, schema)[0].message == "expected string or integer, got boolean"
        assert rb.validate(None, True) == []
        assert rb.validate(None, False)[0].keyword == "false"

    def test_enum_keeps_types_distinct(self) -> None:
        assert rb.validate("1", {"enum": ["1"]}) == []
        assert rb.validate(1, {"enum": ["1"]})[0].keyword == "enum"
        assert rb.validate(True, {"enum": [1]})[0].keyword == "enum"
        assert rb.validate(1, {"enum": [1.0]})[0].keyword == "enum"

    def test_minimum_min_length_pattern(self) -> None:
        assert rb.validate(0, {"type": "integer", "minimum": 0}) == []
        assert rb.validate(-1, {"minimum": 0})[0].keyword == "minimum"
        assert rb.validate("", {"minLength": 1})[0].keyword == "minLength"
        assert rb.validate("zz", {"pattern": "^[0-9a-f]+$"})[0].keyword == "pattern"
        assert rb.validate("0af", {"pattern": "^[0-9a-f]+$"}) == []

    def test_objects_arrays_refs_and_pointers(self) -> None:
        schema = {
            "$defs": {"leaf": {"type": "integer"}},
            "type": "object",
            "required": ["a"],
            "properties": {"a": {"type": "array", "items": {"$ref": "#/$defs/leaf"}}},
            "additionalProperties": {"type": "string"},
        }
        assert rb.validate({"a": [1, 2], "b": "x"}, schema) == []
        found = rb.validate({"a": [1, "no"], "b": 2, "we/ird~": 3}, schema)
        assert [(v.pointer, v.keyword) for v in found] == [
            ("/a/1", "type"),
            ("/b", "type"),
            ("/we~1ird~0", "type"),
        ]
        assert rb.validate({}, schema) == [
            rb.Violation("", "required", "missing required property 'a'")
        ]

    def test_additional_properties_false(self) -> None:
        found = rb.validate({"x": 1}, {"properties": {}, "additionalProperties": False})
        assert found == [rb.Violation("/x", "additionalProperties", "unexpected property")]

    def test_violation_to_dict(self) -> None:
        assert rb.Violation("/a", "type", "m").to_dict() == {
            "pointer": "/a",
            "keyword": "type",
            "message": "m",
        }

    def test_fixtures_validate_as_documented(self) -> None:
        assert rb.validate(read_json(VALID)) == []
        assert rb.validate(read_json(PREVIEW_ONLY)) == []
        assert len(rb.validate(read_json(VIOLATIONS))) == len(EXPECTED_VIOLATIONS)


# --- Round trip ------------------------------------------------------------------------


class TestRoundTrip:
    def test_to_record_bundle_reproduces_a_canonical_bundle(self) -> None:
        run = one_run(rb.load(VALID))
        assert rb.to_record_bundle(run) == read_json(VALID)

    def test_load_emit_load_is_identical(self, tmp_path: Path) -> None:
        first = one_run(rb.load(VALID))
        bundle = rb.to_record_bundle(first)
        again = tmp_path / "again.json"
        again.write_text(to_json(bundle), encoding="utf-8")
        second = one_run(rb.load(again))
        assert second == first
        assert to_json(second.to_dict()) == to_json(first.to_dict())
        assert rb.to_record_bundle(second) == bundle
        assert Run.from_dict(second.to_dict()) == first

    def test_round_trip_keeps_default_locators_and_final_status(self, tmp_path: Path) -> None:
        first = one_run(rb.load(PREVIEW_ONLY))
        bundle = rb.to_record_bundle(first)
        assert bundle["final_status"] == "completed"
        assert [r["source_locator"] for r in bundle["records"]] == [
            f"{PREVIEW_ONLY}#/records/{i}" for i in range(3)
        ]
        # No source_refs were declared, so the loader recorded the file it read; re-emitting
        # declares that path so the provenance survives the round trip.
        assert bundle["source_refs"] == [str(PREVIEW_ONLY)]
        second = one_run(rb.load(write_bundle(tmp_path / "again.json", bundle)))
        assert second.events == first.events
        assert second.coverage == first.coverage
        assert second.source_refs == first.source_refs
        assert rb.final_status(second) == "completed"

    def test_emitted_records_omit_absent_fields(self) -> None:
        run = make_run(
            make_event("e1", kind="tool_call", status="ok", tool_call_id="c1", seq=1),
            make_event("e2", status="ok", seq=2, tokens_in=0),
        )
        bundle = rb.to_record_bundle(run)
        assert bundle["schema_version"] == "1"
        assert bundle["run_id"] == run.id
        assert "conversation_id" not in bundle
        assert "source_refs" not in bundle
        assert bundle["records"] == [
            {
                "id": "e1",
                "source_locator": "synthetic.json#events[e1]",
                "kind": "tool_call",
                "status": "ok",
                "seq": 1,
                "tool_call_id": "c1",
            },
            {
                "id": "e2",
                "source_locator": "synthetic.json#events[e2]",
                "kind": "model_call",
                "status": "ok",
                "seq": 2,
                "tokens_in": 0,
            },
        ]
        assert rb.validate(bundle) == []

    def test_raw_is_carried_only_when_documents_agree(self, tmp_path: Path) -> None:
        a = minimal_bundle(
            records=[
                {"id": "x", "kind": "other", "status": "ok", "raw": {"v": 1}},
                {"id": "y", "kind": "other", "status": "ok", "raw": {"v": 1}},
            ]
        )
        b = minimal_bundle(
            records=[
                {"id": "x", "kind": "other", "status": "ok", "raw": {"v": 2}},
                {"id": "y", "kind": "other", "status": "ok", "raw": {"v": 1}},
            ]
        )
        write_bundle(tmp_path / "a.json", a)
        write_bundle(tmp_path / "b.json", b)
        bundle = rb.to_record_bundle(one_run(rb.load(tmp_path)))
        by_id = {r["id"]: r for r in bundle["records"]}
        assert "raw" not in by_id["x"]
        assert by_id["y"]["raw"] == {"v": 1}
