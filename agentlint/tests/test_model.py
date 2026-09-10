"""TL-A1 (JG-117): dataclasses, lossless round-trip, absent != zero, ordering, findings."""

from __future__ import annotations

import dataclasses
import json

import pytest

from agentlint import __version__
from agentlint.model import (
    Coverage,
    CoverageNote,
    Event,
    Evidence,
    Finding,
    Fingerprint,
    Run,
    field_coverage,
    finding_fingerprint,
    sort_events,
    to_json,
)
from agentlint.tokens import comparable_model_calls
from tests.conftest import make_event, make_run

SECTION_2_4_EVENT_FIELDS = {
    "id",
    "source_locator",
    "parent_id",
    "seq",
    "kind",
    "name",
    "model",
    "provider",
    "adapter",
    "token_basis",
    "start_ms",
    "end_ms",
    "duration_ms",
    "status",
    "error_type",
    "error_code",
    "tokens_in",
    "tokens_out",
    "tokens_total",
    "cache_read_tokens",
    "cache_write_tokens",
    "finish_reason",
    "tool_call_id",
    "native_tool_call_id",
    "args_fingerprint",
    "result_fingerprint",
    "result_bytes",
    "preview_bytes",
    "scope",
    "included_result_ids",
}


def _full_event() -> Event:
    return Event(
        id="0000000000ab12cd",
        source_locator="synthetic/trace.json#spans[7]",
        kind="tool_call",
        status="ok",
        parent_id="00000000deadbeef",
        seq=7,
        name="search_docs",
        model=None,
        provider=None,
        adapter="adapter-y",
        token_basis=None,
        start_ms=1_700_000_000_123,
        end_ms=1_700_000_000_456,
        duration_ms=333,
        error_type=None,
        error_code=None,
        tokens_in=None,
        tokens_out=None,
        tokens_total=None,
        cache_read_tokens=None,
        cache_write_tokens=None,
        finish_reason=None,
        tool_call_id="call-0007",
        native_tool_call_id="toolu-native-0007",
        args_fingerprint=Fingerprint(hash="ab" * 32, representation="full"),
        result_fingerprint=Fingerprint(hash="cd" * 32, representation="truncated"),
        result_bytes=70_000,
        preview_bytes=512,
        scope={"example_app": {"phase": "research", "attempt": 2}},
        included_result_ids=["0000000000ab12ce"],
    )


class TestFieldsMatchSection24:
    def test_event_fields_match_field_for_field(self) -> None:
        assert {f.name for f in dataclasses.fields(Event)} == SECTION_2_4_EVENT_FIELDS

    def test_run_fields(self) -> None:
        assert {f.name for f in dataclasses.fields(Run)} == {
            "id",
            "conversation_id",
            "source_format",
            "source_refs",
            "started_at",
            "ended_at",
            "coverage",
            "events",
            "raw_records",
        }

    def test_coverage_fields(self) -> None:
        assert {f.name for f in dataclasses.fields(Coverage)} == {
            "fields",
            "events_total",
            "events_dropped_dedup",
            "truncated",
            "truncation_notes",
            "completeness",
            "reasons",
            "notes",
        }

    def test_finding_fields(self) -> None:
        assert {f.name for f in dataclasses.fields(Finding)} == {
            "rule_id",
            "title",
            "category",
            "tier",
            "confidence",
            "run_id",
            "observed_pattern",
            "impact",
            "evidence",
            "limitations",
            "thresholds",
            "fingerprint",
        }

    def test_native_tool_call_id_is_separate_from_tool_call_id(self) -> None:
        e = _full_event()
        assert e.tool_call_id == "call-0007"
        assert e.native_tool_call_id == "toolu-native-0007"
        d = e.to_dict()
        assert d["tool_call_id"] != d["native_tool_call_id"]

    def test_preview_bytes_is_separate_from_result_bytes(self) -> None:
        e = _full_event()
        assert (e.result_bytes, e.preview_bytes) == (70_000, 512)

    def test_scope_is_namespaced(self) -> None:
        e = _full_event()
        assert e.scope == {"example_app": {"phase": "research", "attempt": 2}}
        with pytest.raises(TypeError):
            make_event("x", scope={"flat": "value"})  # type: ignore[arg-type]

    def test_version_exported(self) -> None:
        assert __version__ == "0.0.1"


class TestRoundTrip:
    def test_run_json_round_trip_is_lossless(self) -> None:
        big_ns = 1_700_000_000_123_456_789  # nanosecond timestamp beyond 2**53
        run = Run(
            id="0af1e2d3c4b5a697",
            source_format="otlp-json",
            conversation_id="conv-00ff",
            source_refs=["synthetic/page-1.json", "synthetic/page-2.json"],
            started_at=1_700_000_000_000,
            ended_at=1_700_000_009_000,
            coverage=Coverage(
                fields={"tokens_in": "partial"},
                events_total=1,
                events_dropped_dedup=0,
                truncated=True,
                truncation_notes=["export cut at page 2"],
                completeness="incomplete",
                reasons=["truncated"],
                notes=[CoverageNote(code="x", message="y", fields=["tokens_in"], event_ids=["a"])],
            ),
            events=[_full_event()],
            raw_records=[{"spanId": "0000000000ab12cd", "startTimeUnixNano": big_ns}],
        )
        text = to_json(run)
        back = Run.from_dict(json.loads(text))
        assert back == run
        assert back.raw_records[0]["startTimeUnixNano"] == big_ns
        assert isinstance(back.events[0].id, str)
        assert back.events[0].id == "0000000000ab12cd"  # leading zeros survive
        assert to_json(back) == text  # byte-identical on re-serialisation

    def test_fixture_round_trip(self, mixed_basis_fixture: dict) -> None:
        run = Run.from_dict(mixed_basis_fixture["run"])
        assert Run.from_dict(json.loads(to_json(run))) == run
        assert len(run.raw_records) == 4

    def test_finding_round_trip(self) -> None:
        f = Finding(
            rule_id="CONTEXT_GROWTH",
            title="Context growth candidate",
            category="context",
            tier="projected",
            confidence="medium",
            run_id="run-0001",
            observed_pattern="tokens_in rose 1000 -> 9500",
            impact=None,
            evidence=[
                Evidence(event_id="00a1", source_locator="s#0", field="tokens_in", value=1000)
            ],
            limitations=["candidate, not cause"],
            thresholds={"delta_tokens": 8000, "ratio": 1.5},
        )
        assert Finding.from_dict(json.loads(to_json(f))) == f

    def test_to_json_is_deterministic(self) -> None:
        run = make_run(make_event("b"), make_event("a"))
        assert to_json(run) == to_json(make_run(make_event("b"), make_event("a")))


class TestAbsentIsNotZero:
    def test_missing_values_serialize_as_null(self) -> None:
        d = make_event("e1", kind="tool_call").to_dict()
        for name in ("tokens_in", "result_bytes", "args_fingerprint", "result_fingerprint"):
            assert name in d
            assert d[name] is None
        text = to_json(make_run(make_event("e1", kind="tool_call")))
        assert '"tokens_in": null' in text
        assert '"result_bytes": null' in text
        assert '"args_fingerprint": null' in text
        assert '"tokens_in": 0' not in text
        assert '"args_fingerprint": {}' not in text
        assert '"args_fingerprint": ""' not in text

    def test_zero_is_kept_as_zero(self) -> None:
        d = make_event("e1", tokens_in=0).to_dict()
        assert d["tokens_in"] == 0

    def test_non_int_counts_rejected(self) -> None:
        with pytest.raises(TypeError):
            make_event("e1", tokens_in="12")  # type: ignore[arg-type]
        with pytest.raises(TypeError):
            make_event("e1", result_bytes=True)  # type: ignore[arg-type]

    def test_coverage_counts_absent_until_normalized(self) -> None:
        c = Coverage()
        assert c.events_total is None
        assert c.events_dropped_dedup is None
        assert c.to_dict()["events_total"] is None


class TestVocabularies:
    def test_kind_includes_aggregate_and_approval(self) -> None:
        assert make_event("a", kind="aggregate").kind == "aggregate"
        assert make_event("b", kind="approval").kind == "approval"

    def test_invalid_kind_and_status_rejected(self) -> None:
        with pytest.raises(ValueError):
            make_event("a", kind="llm")
        with pytest.raises(ValueError):
            make_event("a", status="failed")

    def test_blocked_approval_has_status_blocked_not_error(self) -> None:
        e = make_event("appr-1", kind="approval", status="blocked", tool_call_id="call-1")
        assert e.status == "blocked"
        assert e.status != "error"
        assert Event.from_dict(e.to_dict()).status == "blocked"

    def test_coverage_vocabulary_enforced(self) -> None:
        with pytest.raises(ValueError):
            Coverage(fields={"tokens_in": "missing"})
        with pytest.raises(ValueError):
            Coverage(completeness="clean")

    def test_fingerprint_representation_enforced(self) -> None:
        with pytest.raises(ValueError):
            Fingerprint(hash="ab" * 32, representation="partial")
        with pytest.raises(ValueError):
            Fingerprint(hash="", representation="full")


class TestOrdering:
    def test_events_sorted_by_start_seq_id(self) -> None:
        events = [
            make_event("c", start_ms=200, seq=1),
            make_event("b", start_ms=100, seq=2),
            make_event("a", start_ms=100, seq=1),
            make_event("z", start_ms=100, seq=1),
        ]
        assert [e.id for e in sort_events(events)] == ["a", "z", "b", "c"]

    def test_absent_start_and_seq_sort_last(self) -> None:
        events = [
            make_event("no-time", seq=0),
            make_event("no-seq", start_ms=50),
            make_event("both", start_ms=50, seq=3),
        ]
        assert [e.id for e in sort_events(events)] == ["both", "no-seq", "no-time"]

    def test_run_sorted_events_does_not_mutate(self) -> None:
        run = make_run(make_event("b", start_ms=2), make_event("a", start_ms=1))
        assert [e.id for e in run.sorted_events()] == ["a", "b"]
        assert [e.id for e in run.events] == ["b", "a"]
        assert [e.id for e in run.with_sorted_events().events] == ["a", "b"]

    def test_raw_records_retained_verbatim(self) -> None:
        raw = [{"kind": "span", "id": "b"}, {"kind": "span", "id": "a"}]
        run = make_run(raw_records=raw)
        assert run.with_sorted_events().raw_records == raw
        assert Run.from_dict(run.to_dict()).raw_records == raw


class TestFindingFingerprint:
    def _finding(self, evidence: list[Evidence], thresholds: dict) -> Finding:
        return Finding(
            rule_id="REPEATED_TOOL_RESULT",
            title="Repeated tool result",
            category="tools",
            tier="proven",
            confidence="medium",
            run_id="run-0001",
            observed_pattern="same result 3 times",
            evidence=evidence,
            thresholds=thresholds,
        )

    def test_fingerprint_is_stable_and_order_independent(self) -> None:
        ev1 = Evidence(event_id="a", source_locator="s#1", field="result_fingerprint")
        ev2 = Evidence(event_id="b", source_locator="s#2", field="result_fingerprint")
        f1 = self._finding([ev1, ev2], {"n": 3, "bytes": 8192})
        f2 = self._finding([ev2, ev1], {"bytes": 8192, "n": 3})
        assert f1.fingerprint == f2.fingerprint
        assert len(f1.fingerprint) == 64
        assert f1.fingerprint == finding_fingerprint(
            "REPEATED_TOOL_RESULT", "run-0001", [ev1, ev2], {"n": 3, "bytes": 8192}
        )

    def test_fingerprint_changes_with_thresholds_and_evidence(self) -> None:
        ev = Evidence(event_id="a", source_locator="s#1")
        base = self._finding([ev], {"n": 3})
        assert self._finding([ev], {"n": 2}).fingerprint != base.fingerprint
        other = Evidence(event_id="b", source_locator="s#2")
        assert self._finding([other], {"n": 3}).fingerprint != base.fingerprint

    def test_fingerprint_ignores_evidence_values(self) -> None:
        a = self._finding([Evidence(event_id="a", source_locator="s#1", value=1)], {"n": 3})
        b = self._finding([Evidence(event_id="a", source_locator="s#1", value=2)], {"n": 3})
        assert a.fingerprint == b.fingerprint

    def test_thresholds_recorded(self) -> None:
        f = self._finding([], {"n": 3, "bytes": 8192})
        assert f.to_dict()["thresholds"] == {"bytes": 8192, "n": 3}

    def test_tier_and_confidence_enforced(self) -> None:
        with pytest.raises(ValueError):
            dataclasses.replace(self._finding([], {}), tier="certain")
        with pytest.raises(ValueError):
            dataclasses.replace(self._finding([], {}), confidence="very high")


class TestFieldCoverage:
    def test_present_partial_absent(self) -> None:
        events = [
            make_event("m1", tokens_in=10, model="model-a"),
            make_event("m2", model="model-a"),
            make_event("t1", kind="tool_call", tool_call_id="c1"),
        ]
        cov = field_coverage(events)
        assert cov["model"] == "present"
        assert cov["tokens_in"] == "partial"
        assert cov["result_bytes"] == "absent"
        assert cov["tool_call_id"] == "present"

    def test_no_applicable_events_is_absent(self) -> None:
        assert field_coverage([])["tokens_in"] == "absent"


class TestTokenBasisNegativeCase:
    def test_event_without_token_basis_is_comparable_to_nothing(self) -> None:
        e = make_event("m1", tokens_in=1000, model="model-a", start_ms=1)
        assert e.token_basis is None
        run = make_run(e, make_event("m2", tokens_in=1200, model="model-a", start_ms=2))
        assert comparable_model_calls(run) == []
