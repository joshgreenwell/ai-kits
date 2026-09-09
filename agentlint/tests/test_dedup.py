"""TL-A2 (JG-118): dedup by source identity and tool_call_id, counts, multi-file merge."""

from __future__ import annotations

from agentlint.dedup import dedup_events, merge_events, merge_runs, normalize_run, normalize_runs
from agentlint.fingerprint import fingerprint
from agentlint.model import Coverage, CoverageNote, Run
from tests.conftest import make_event, make_run

ARGS = fingerprint({"query": "a long enough search argument"})


class TestSourceIdentity:
    def test_same_id_collapses_into_one_event(self) -> None:
        streamed = make_event("span-01", kind="tool_call", start_ms=10, tool_call_id="c1")
        durable = make_event(
            "span-01",
            kind="tool_call",
            start_ms=10,
            tool_call_id="c1",
            status="ok",
            result_bytes=2048,
            args_fingerprint=ARGS,
        )
        events, dropped, notes = dedup_events([streamed, durable])
        assert len(events) == 1
        assert dropped == 1
        assert events[0].id == "span-01"
        assert events[0].result_bytes == 2048
        assert events[0].status == "ok"
        assert [n.code for n in notes] == ["dedup_merged"]

    def test_richer_field_set_wins_and_gaps_are_filled(self) -> None:
        a = make_event("x", kind="tool_call", tool_call_id="c1", result_bytes=100, name="search")
        b = make_event("x", kind="tool_call", tool_call_id="c1", end_ms=99, native_tool_call_id="n")
        merged, conflicts = merge_events(a, b)
        assert merged.result_bytes == 100
        assert merged.name == "search"
        assert merged.end_ms == 99
        assert merged.native_tool_call_id == "n"
        assert conflicts == []

    def test_conflicts_recorded_in_coverage_notes(self) -> None:
        a = make_event("x", kind="tool_call", tool_call_id="c1", result_bytes=100, name="search")
        b = make_event("x", kind="tool_call", tool_call_id="c1", result_bytes=200)
        events, dropped, notes = dedup_events([a, b])
        assert events[0].result_bytes == 100  # richer record kept
        assert dropped == 1
        conflict = [n for n in notes if n.code == "dedup_conflict"]
        assert len(conflict) == 1
        assert conflict[0].fields == ["result_bytes"]
        assert conflict[0].event_ids == ["x"]

    def test_status_unknown_does_not_win_over_known(self) -> None:
        a = make_event("x", kind="tool_call", status="unknown", name="n", result_bytes=1, end_ms=2)
        b = make_event("x", kind="tool_call", status="error", error_type="Timeout")
        merged, conflicts = merge_events(a, b)
        assert merged.status == "error"
        assert merged.error_type == "Timeout"
        assert conflicts == []

    def test_scope_namespaces_and_included_ids_are_unioned(self) -> None:
        a = make_event("x", scope={"app": {"phase": 1}}, included_result_ids=["r1"])
        b = make_event("x", scope={"other": {"k": 2}}, included_result_ids=["r2", "r1"])
        merged, _ = merge_events(a, b)
        assert merged.scope == {"app": {"phase": 1}, "other": {"k": 2}}
        assert merged.included_result_ids == ["r2", "r1"] or merged.included_result_ids == [
            "r1",
            "r2",
        ]
        assert set(merged.included_result_ids) == {"r1", "r2"}


class TestToolCallId:
    def test_same_tool_call_id_with_different_source_ids_merges(self) -> None:
        streamed = make_event("stream-7", kind="tool_call", tool_call_id="c7", start_ms=5)
        row = make_event(
            "row-7", kind="tool_call", tool_call_id="c7", start_ms=5, status="ok", result_bytes=9
        )
        events, dropped, notes = dedup_events([streamed, row])
        assert len(events) == 1
        assert dropped == 1
        assert events[0].id == "row-7"  # richer record keeps its own original id
        merged_note = next(n for n in notes if n.code == "dedup_merged")
        assert "stream-7" in merged_note.message
        assert merged_note.event_ids == ["row-7", "stream-7"]

    def test_fan_out_with_different_tool_call_ids_is_not_merged(self) -> None:
        a = make_event("f1", kind="tool_call", tool_call_id="c1", args_fingerprint=ARGS, start_ms=1)
        b = make_event("f2", kind="tool_call", tool_call_id="c2", args_fingerprint=ARGS, start_ms=1)
        events, dropped, notes = dedup_events([a, b])
        assert len(events) == 2
        assert dropped == 0
        assert notes == []

    def test_identical_args_without_tool_call_id_are_not_merged(self) -> None:
        a = make_event("f1", kind="tool_call", args_fingerprint=ARGS)
        b = make_event("f2", kind="tool_call", args_fingerprint=ARGS)
        events, dropped, _ = dedup_events([a, b])
        assert (len(events), dropped) == (2, 0)

    def test_approval_and_tool_call_sharing_tool_call_id_are_not_merged(self) -> None:
        approval = make_event("ap-1", kind="approval", tool_call_id="c1", status="blocked")
        call = make_event("tc-1", kind="tool_call", tool_call_id="c1", status="error")
        events, dropped, _ = dedup_events([approval, call])
        assert (len(events), dropped) == (2, 0)
        assert {e.status for e in events} == {"blocked", "error"}

    def test_transitive_identity(self) -> None:
        # a shares id with b; b shares tool_call_id with c -> one event.
        a = make_event("s1", kind="tool_call")
        b = make_event("s1", kind="tool_call", tool_call_id="c1")
        c = make_event("s2", kind="tool_call", tool_call_id="c1", result_bytes=3)
        events, dropped, _ = dedup_events([a, b, c])
        assert (len(events), dropped) == (1, 2)


class TestCounts:
    def test_events_total_and_dropped(self) -> None:
        run = make_run(
            make_event("a", kind="tool_call", tool_call_id="c1", start_ms=1),
            make_event("a", kind="tool_call", tool_call_id="c1", start_ms=1, status="ok"),
            make_event("b", start_ms=2),
        )
        out = normalize_run(run)
        assert out.coverage.events_total == 2
        assert out.coverage.events_dropped_dedup == 1
        assert len(out.events) == 2

    def test_re_imported_canonical_event_adds_nothing(self) -> None:
        canonical = make_event("a", kind="tool_call", tool_call_id="c1", start_ms=1, status="ok")
        first = normalize_run(make_run(canonical))
        assert first.coverage.events_total == 1
        # Re-import the canonical event (for example from a second export page).
        again = normalize_run(
            Run.from_dict(
                {**first.to_dict(), "events": [*first.to_dict()["events"], canonical.to_dict()]}
            )
        )
        assert again.coverage.events_total == 1
        assert len(again.events) == 1
        assert again.events[0] == canonical
        assert again.coverage.events_dropped_dedup == 1
        assert not any(n.code == "dedup_conflict" for n in again.coverage.notes)

    def test_normalize_is_idempotent(self) -> None:
        run = make_run(
            make_event("a", kind="tool_call", tool_call_id="c1", start_ms=2),
            make_event("a", kind="tool_call", tool_call_id="c1", start_ms=2, status="ok"),
            make_event("b", start_ms=1, model="m", token_basis="input_includes_cache_read"),
        )
        once = normalize_run(run)
        twice = normalize_run(once)
        assert twice == once
        assert twice.coverage.events_dropped_dedup == 1

    def test_normalize_sorts_and_fills_coverage(self) -> None:
        run = make_run(
            make_event("b", start_ms=2, tokens_in=5, model="m"), make_event("a", start_ms=1)
        )
        out = normalize_run(run)
        assert [e.id for e in out.events] == ["a", "b"]
        assert out.coverage.fields["tokens_in"] == "partial"
        assert out.coverage.completeness == "complete"
        assert out.raw_records == run.raw_records

    def test_truncated_run_is_incomplete(self) -> None:
        run = make_run(coverage=Coverage(truncated=True, truncation_notes=["page 2 missing"]))
        out = normalize_run(run)
        assert out.coverage.completeness == "incomplete"
        assert "truncated" in out.coverage.reasons
        assert out.coverage.truncation_notes == ["page 2 missing"]

    def test_loader_reasons_and_notes_are_kept(self) -> None:
        note = CoverageNote(code="loader", message="usage export omitted")
        run = make_run(coverage=Coverage(reasons=["no usage"], notes=[note]))
        out = normalize_run(run)
        assert out.coverage.reasons == ["no usage"]
        assert out.coverage.notes[0] == note
        assert out.coverage.completeness == "incomplete"


class TestMultiFileMerge:
    def test_runs_merge_by_id_before_dedup(self) -> None:
        page1 = Run(
            id="run-1",
            source_format="otlp-json",
            source_refs=["synthetic/p1.json"],
            started_at=100,
            ended_at=200,
            events=[make_event("a", kind="tool_call", tool_call_id="c1", start_ms=100)],
            raw_records=[{"page": 1}],
        )
        page2 = Run(
            id="run-1",
            source_format="otlp-json",
            source_refs=["synthetic/p2.json"],
            started_at=150,
            ended_at=300,
            events=[
                make_event("a", kind="tool_call", tool_call_id="c1", start_ms=100, status="ok"),
                make_event("b", start_ms=250),
            ],
            raw_records=[{"page": 2}],
        )
        other = Run(id="run-2", source_format="otlp-json", events=[make_event("z")])
        merged = merge_runs([page1, page2, other])
        assert [r.id for r in merged] == ["run-1", "run-2"]
        assert merged[0].source_refs == ["synthetic/p1.json", "synthetic/p2.json"]
        assert merged[0].started_at == 100
        assert merged[0].ended_at == 300
        assert merged[0].raw_records == [{"page": 1}, {"page": 2}]
        assert len(merged[0].events) == 3  # not yet deduplicated

        normalized = normalize_runs([page1, page2, other])
        assert normalized[0].coverage.events_total == 2
        assert normalized[0].coverage.events_dropped_dedup == 1
        assert normalized[1].coverage.events_total == 1
        assert normalized[1].coverage.events_dropped_dedup == 0

    def test_conflicting_conversation_id_is_noted(self) -> None:
        a = Run(id="r", source_format="f", conversation_id="conv-1")
        b = Run(id="r", source_format="f", conversation_id="conv-2")
        merged = merge_runs([a, b])[0]
        assert merged.conversation_id == "conv-1"
        assert [n.code for n in merged.coverage.notes] == ["merge_conflict"]
        assert merged.coverage.notes[0].fields == ["conversation_id"]

    def test_missing_conversation_id_is_filled(self) -> None:
        a = Run(id="r", source_format="f")
        b = Run(id="r", source_format="f", conversation_id="conv-2")
        assert merge_runs([a, b])[0].conversation_id == "conv-2"

    def test_truncation_propagates(self) -> None:
        a = Run(id="r", source_format="f")
        b = Run(id="r", source_format="f", coverage=Coverage(truncated=True))
        assert normalize_runs([a, b])[0].coverage.completeness == "incomplete"
