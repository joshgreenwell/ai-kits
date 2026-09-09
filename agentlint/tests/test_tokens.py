"""TL-A4 (JG-120): token basis, comparable-call selection, exclusions, per-basis totals."""

from __future__ import annotations

from agentlint.dedup import normalize_run
from agentlint.model import (
    TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ as EXCL,
)
from agentlint.model import (
    TOKEN_BASIS_INPUT_INCLUDES_CACHE_READ as INCL,
)
from agentlint.model import Run
from agentlint.tokens import (
    DEFAULT_EXCLUDED_OPERATION_NAMES,
    DEFAULT_EXCLUDED_TAGS,
    TokenConfig,
    calls_without_token_basis,
    comparable_model_calls,
    exclusion_reason,
    select_comparable,
    token_basis_notes,
    token_totals_by_basis,
)
from tests.conftest import make_event, make_run


def call(id: str, start_ms: int, basis: str | None = INCL, model: str = "model-a", **kw):
    return make_event(
        id, kind="model_call", start_ms=start_ms, token_basis=basis, model=model, status="ok", **kw
    )


class TestSeriesSplitting:
    def test_same_basis_and_model_form_one_series(self) -> None:
        run = make_run(
            call("a", 1, tokens_in=10), call("b", 2, tokens_in=20), call("c", 3, tokens_in=30)
        )
        series = comparable_model_calls(run)
        assert [[e.id for e in s] for s in series] == [["a", "b", "c"]]

    def test_basis_change_splits_series(self) -> None:
        run = make_run(
            call("a", 1, INCL), call("b", 2, INCL), call("c", 3, EXCL), call("d", 4, EXCL)
        )
        series = comparable_model_calls(run)
        assert [[e.id for e in s] for s in series] == [["a", "b"], ["c", "d"]]
        for s in series:
            assert len({e.token_basis for e in s}) == 1
            assert len({e.model for e in s}) == 1

    def test_model_change_splits_series(self) -> None:
        run = make_run(call("a", 1), call("b", 2, model="model-b"), call("c", 3))
        assert [[e.id for e in s] for s in comparable_model_calls(run)] == [["a"], ["b"], ["c"]]

    def test_returning_to_earlier_basis_starts_a_new_series(self) -> None:
        run = make_run(call("a", 1, INCL), call("b", 2, EXCL), call("c", 3, INCL))
        assert [[e.id for e in s] for s in comparable_model_calls(run)] == [["a"], ["b"], ["c"]]

    def test_event_without_basis_is_excluded_and_splits_the_series(self) -> None:
        run = make_run(call("a", 1), call("b", 2, basis=None), call("c", 3))
        sel = select_comparable(run)
        assert [[e.id for e in s.events] for s in sel.series] == [["a"], ["c"]]
        assert sel.excluded["b"] == "token_basis_absent"
        assert calls_without_token_basis(run) == ["b"]

    def test_excluded_routing_call_does_not_split_the_series(self) -> None:
        run = make_run(
            call("a", 1, name="chat"), call("r", 2, name="router"), call("c", 3, name="chat")
        )
        assert [[e.id for e in s] for s in comparable_model_calls(run)] == [["a", "c"]]

    def test_selection_uses_canonical_order(self) -> None:
        run = make_run(call("late", 3), call("early", 1), call("mid", 2))
        assert [e.id for e in comparable_model_calls(run)[0]] == ["early", "mid", "late"]

    def test_non_model_events_are_ignored(self) -> None:
        run = make_run(
            call("a", 1),
            make_event("t", kind="tool_call", start_ms=2, tool_call_id="c1"),
            make_event("p", kind="approval", start_ms=3, status="blocked"),
            call("b", 4),
        )
        assert [[e.id for e in s] for s in comparable_model_calls(run)] == [["a", "b"]]


class TestAggregates:
    def test_aggregate_excluded_when_child_model_calls_exist(self) -> None:
        agg = make_event(
            "agg", kind="aggregate", start_ms=0, token_basis=INCL, model="model-a", tokens_in=300
        )
        run = make_run(
            agg,
            call("a", 1, parent_id="agg", tokens_in=100),
            call("b", 2, parent_id="agg", tokens_in=200),
        )
        sel = select_comparable(run)
        assert [[e.id for e in s.events] for s in sel.series] == [["a", "b"]]
        assert sel.excluded["agg"] == "aggregate_with_children"
        assert not any(s.is_aggregate for s in sel.series)

    def test_aggregate_with_grandchildren_is_excluded(self) -> None:
        agg = make_event("agg", kind="aggregate", start_ms=0, token_basis=INCL, model="model-a")
        run = make_run(
            agg,
            make_event("step", kind="other", start_ms=1, parent_id="agg"),
            call("a", 2, parent_id="step"),
        )
        assert select_comparable(run).excluded["agg"] == "aggregate_with_children"

    def test_aggregate_with_included_result_ids_is_excluded(self) -> None:
        agg = make_event(
            "agg",
            kind="aggregate",
            start_ms=0,
            token_basis=INCL,
            model="model-a",
            included_result_ids=["a"],
        )
        run = make_run(agg, call("a", 2))
        assert select_comparable(run).excluded["agg"] == "aggregate_with_children"

    def test_aggregate_included_and_flagged_when_no_model_calls(self) -> None:
        agg1 = make_event(
            "g1", kind="aggregate", start_ms=0, token_basis=INCL, model="model-a", tokens_in=300
        )
        agg2 = make_event(
            "g2", kind="aggregate", start_ms=5, token_basis=INCL, model="model-a", tokens_in=400
        )
        run = make_run(agg1, agg2, make_event("t", kind="tool_call", start_ms=1))
        sel = select_comparable(run)
        assert len(sel.series) == 1
        assert sel.series[0].is_aggregate is True
        assert [e.id for e in sel.series[0].events] == ["g1", "g2"]
        assert all(e.kind == "aggregate" for e in sel.series[0].events)
        assert sel.to_dict()["series"][0]["is_aggregate"] is True

    def test_aggregate_never_summed_with_child_usage(self) -> None:
        agg = make_event(
            "agg", kind="aggregate", start_ms=0, token_basis=INCL, model="model-a", tokens_in=300
        )
        run = make_run(
            agg,
            call("a", 1, parent_id="agg", tokens_in=100),
            call("b", 2, parent_id="agg", tokens_in=200),
        )
        totals = token_totals_by_basis(run)
        assert totals[INCL].tokens_in == 300  # 100 + 200, not 600
        assert totals[INCL].calls == 2
        assert totals[INCL].is_aggregate is False

    def test_aggregate_without_basis_is_not_used(self) -> None:
        agg = make_event("agg", kind="aggregate", start_ms=0, tokens_in=300)
        sel = select_comparable(make_run(agg))
        assert sel.series == []
        assert sel.excluded["agg"] == "token_basis_absent"


class TestExclusions:
    def test_excluded_by_operation_name(self) -> None:
        run = make_run(
            call("a", 1, name="chat"),
            call("r", 2, name="router.classify"),
            call("q", 3, name="Retrieval Rerank"),
            call("c", 4, name="context compaction"),
            call("b", 5, name="chat"),
        )
        sel = select_comparable(run)
        assert [[e.id for e in s.events] for s in sel.series] == [["a", "b"]]
        assert sel.excluded == {
            "r": "operation_name:router",
            "q": "operation_name:rerank",
            "c": "operation_name:compaction",
        }

    def test_name_match_is_whole_word(self) -> None:
        # "reroute" and "embedded_chat" are not the excluded words.
        assert exclusion_reason(call("x", 1, name="reroute")) is None
        assert exclusion_reason(call("x", 1, name="embedded_chat")) is None
        assert exclusion_reason(call("x", 1, name="route")) == "operation_name:route"

    def test_excluded_by_app_tag(self) -> None:
        tagged = call("r", 2, name="chat", scope={"agentlint": {"tags": ["routing"]}})
        run = make_run(call("a", 1, name="chat"), tagged, call("b", 3, name="chat"))
        sel = select_comparable(run)
        assert [[e.id for e in s.events] for s in sel.series] == [["a", "b"]]
        assert sel.excluded["r"] == "tag:routing"

    def test_custom_namespace_and_lists(self) -> None:
        config = TokenConfig(
            excluded_operation_names=("planner",),
            excluded_tags=("housekeeping",),
            tag_namespace="example_app",
        )
        run = make_run(
            call("a", 1, name="chat"),
            call("p", 2, name="planner"),
            call("h", 3, name="chat", scope={"example_app": {"tags": ["housekeeping"]}}),
            call("r", 4, name="router"),  # no longer excluded under the custom list
        )
        sel = select_comparable(run, config)
        # "router" is no longer excluded; the excluded calls do not split the series.
        assert [[e.id for e in s.events] for s in sel.series] == [["a", "r"]]
        assert sel.excluded == {"p": "operation_name:planner", "h": "tag:housekeeping"}

    def test_exclusion_list_visible_in_json_output(self) -> None:
        sel = select_comparable(make_run(call("a", 1)))
        out = sel.to_dict()["exclusions"]
        assert out["excluded_operation_names"] == sorted(DEFAULT_EXCLUDED_OPERATION_NAMES)
        assert out["excluded_tags"] == sorted(DEFAULT_EXCLUDED_TAGS)
        assert out["tag_namespace"] == "agentlint"
        for word in ("routing", "retrieval", "compaction"):
            assert word in out["excluded_operation_names"]
        assert TokenConfig().to_dict() == out


class TestPerBasisTotals:
    def test_totals_reported_per_basis_never_summed(self) -> None:
        run = make_run(
            call("a", 1, INCL, tokens_in=100, tokens_out=10, cache_read_tokens=50),
            call("b", 2, INCL, tokens_in=200, tokens_out=20, cache_read_tokens=60),
            call("c", 3, EXCL, tokens_in=1000, tokens_out=30),
        )
        totals = token_totals_by_basis(run)
        assert set(totals) == {INCL, EXCL}
        assert totals[INCL].to_dict() == {
            "token_basis": INCL,
            "calls": 2,
            "tokens_in": 300,
            "tokens_out": 30,
            "tokens_total": None,
            "cache_read_tokens": 110,
            "cache_write_tokens": None,
            "is_aggregate": False,
        }
        assert totals[EXCL].tokens_in == 1000
        assert totals[EXCL].cache_read_tokens is None  # absent stays absent, not 0
        assert sum(t.tokens_in for t in totals.values()) == 1300  # only a test would do this

    def test_events_without_basis_not_totalled(self) -> None:
        run = make_run(call("a", 1, basis=None, tokens_in=100))
        assert token_totals_by_basis(run) == {}
        assert calls_without_token_basis(run) == ["a"]

    def test_excluded_calls_not_totalled(self) -> None:
        run = make_run(call("a", 1, tokens_in=100), call("r", 2, name="retrieval", tokens_in=999))
        assert token_totals_by_basis(run)[INCL].tokens_in == 100

    def test_empty_run(self) -> None:
        assert token_totals_by_basis(make_run()) == {}
        assert comparable_model_calls(make_run()) == []


class TestMixedBasisNegativeCase:
    def test_mixed_bases_yield_no_cross_boundary_comparison_and_a_note(
        self, mixed_basis_fixture: dict
    ) -> None:
        run = Run.from_dict(mixed_basis_fixture["run"])
        series = comparable_model_calls(run)
        assert [[e.id for e in s] for s in series] == [["00a1", "00a2"], ["00a3", "00a4"]]
        # No series spans the boundary between excludes-cache and includes-cache.
        for s in series:
            assert len({e.token_basis for e in s}) == 1
        notes = token_basis_notes(run)
        assert [n.code for n in notes] == ["mixed_token_basis"]
        assert "token_basis" in notes[0].fields
        assert set(notes[0].event_ids) == {"00a1", "00a2", "00a3", "00a4"}
        assert "never across the boundary" in notes[0].message

    def test_normalize_attaches_mixed_basis_note(self, mixed_basis_fixture: dict) -> None:
        run = normalize_run(Run.from_dict(mixed_basis_fixture["run"]))
        assert any(n.code == "mixed_token_basis" for n in run.coverage.notes)
        assert run.coverage.fields["token_basis"] == "present"
        # Normalizing again does not duplicate the note.
        assert sum(n.code == "mixed_token_basis" for n in normalize_run(run).coverage.notes) == 1

    def test_single_basis_has_no_note(self) -> None:
        assert token_basis_notes(make_run(call("a", 1), call("b", 2))) == []

    def test_absent_basis_note_names_events(self) -> None:
        notes = token_basis_notes(make_run(call("a", 1), call("b", 2, basis=None)))
        assert [n.code for n in notes] == ["token_basis_absent"]
        assert notes[0].event_ids == ["b"]

    def test_excluded_calls_do_not_trigger_mixed_note(self) -> None:
        run = make_run(call("a", 1, INCL), call("r", 2, EXCL, name="router"))
        assert token_basis_notes(run) == []
