"""TL-C3 (JG-128): CONTEXT_GROWTH candidates, thresholds and boundaries."""

from __future__ import annotations

from agentlint.fingerprint import fingerprint
from agentlint.rules import GENERIC_RULES, run_rules, validate_meta
from agentlint.rules.generic.context_growth import META, RULE_ID
from tests.conftest import load_rule_run, make_event, make_run

INCL = "input_includes_cache_read"


def findings_for(name: str):
    run = load_rule_run(name)
    report = run_rules(run, GENERIC_RULES)
    return run, report, [f for f in report.findings if f.rule_id == RULE_ID]


def model(id: str, start: int, tokens_in: int, **kw):
    values = dict(
        kind="model_call",
        status="ok",
        model="model-a",
        token_basis=INCL,
        tokens_in=tokens_in,
        start_ms=start,
        end_ms=start + 500,
    )
    values.update(kw)
    return make_event(id, **values)


def tool(id: str, start: int, size: int = 20000):
    return make_event(
        id,
        kind="tool_call",
        name="read_document",
        status="ok",
        start_ms=start,
        end_ms=start + 500,
        args_fingerprint=fingerprint({"path": f"/workspace/docs/{id}.txt"}),
        result_fingerprint=fingerprint({"document": id * 20}),
        result_bytes=size,
    )


class TestPositive:
    def test_plus_12000_and_2x_lists_intervening_results_as_candidates(self) -> None:
        run, report, found = findings_for("cg_positive")
        assert len(found) == 1
        finding = found[0]
        assert finding.tier == "projected"
        assert finding.confidence == "medium"
        assert finding.category == "context"
        assert "candidates" in finding.observed_pattern
        assert "cause" not in finding.observed_pattern
        assert "tokens_in rose from 12000 to 24000 (+12000, x2.00)" in finding.observed_pattern
        ids = [e.event_id for e in finding.evidence]
        assert ids == ["m1", "t1", "t2", "m2"]
        before = next(e for e in finding.evidence if e.event_id == "m1")
        after = next(e for e in finding.evidence if e.event_id == "m2")
        assert (before.field, before.value, before.note) == ("tokens_in", 12000, "before")
        assert (after.field, after.value, after.note) == ("tokens_in", 24000, "after")
        sizes = {e.id: e.result_bytes for e in run.events}
        for candidate in (e for e in finding.evidence if e.event_id.startswith("t")):
            assert candidate.field == "result_bytes"
            assert candidate.value == sizes[candidate.event_id]
            assert candidate.note is not None and candidate.note.startswith("candidate:")
        assert finding.thresholds == {"min_delta_tokens": 8000, "min_ratio": 1.5}
        assert report.thresholds[RULE_ID] == finding.thresholds
        assert RULE_ID not in report.incomplete_for_rules

    def test_included_result_ids_add_candidates_outside_the_interval(self) -> None:
        run = make_run(
            tool("t0", 0),
            model("m1", 1000, 5000),
            model("m2", 3000, 20000, included_result_ids=["t0"]),
        )
        report = run_rules(run, GENERIC_RULES)
        found = [f for f in report.findings if f.rule_id == RULE_ID]
        assert len(found) == 1
        assert [e.event_id for e in found[0].evidence] == ["t0", "m1", "m2"]

    def test_no_recorded_result_between_reports_unknown_candidates(self) -> None:
        run = make_run(model("m1", 0, 5000), model("m2", 2000, 20000))
        report = run_rules(run, GENERIC_RULES)
        found = [f for f in report.findings if f.rule_id == RULE_ID]
        assert len(found) == 1
        assert "candidates are unknown" in found[0].observed_pattern


class TestNegative:
    def test_aggregate_usage_only_abstains_naming_per_call_tokens_in(self) -> None:
        _, report, found = findings_for("cg_aggregate_only")
        assert found == []
        note = next(n for n in report.abstentions if n.rule_id == RULE_ID)
        assert note.code == "rule_abstained"
        assert "tokens_in(model_call)" in note.fields
        assert "model_call" in note.fields
        assert RULE_ID in report.incomplete_for_rules

    def test_growth_across_token_basis_change_is_never_compared(self) -> None:
        _, report, found = findings_for("cg_basis_change")
        assert found == []
        assert RULE_ID not in report.incomplete_for_rules

    def test_growth_across_model_change_is_never_compared(self) -> None:
        _, _, found = findings_for("cg_model_change")
        assert found == []

    def test_plus_9000_but_only_1_2x_gives_no_finding(self) -> None:
        _, report, found = findings_for("cg_ratio_too_small")
        assert found == []
        assert RULE_ID not in report.incomplete_for_rules

    def test_2x_but_below_delta_gives_no_finding(self) -> None:
        run = make_run(model("m1", 0, 1000), tool("t1", 700), model("m2", 2000, 3000))
        report = run_rules(run, GENERIC_RULES)
        assert [f for f in report.findings if f.rule_id == RULE_ID] == []

    def test_routing_call_between_does_not_qualify_or_split(self) -> None:
        run = make_run(
            model("m1", 0, 12000),
            model("r", 1000, 300, name="router"),
            tool("t1", 1500),
            model("m2", 3000, 24000),
        )
        report = run_rules(run, GENERIC_RULES)
        found = [f for f in report.findings if f.rule_id == RULE_ID]
        assert len(found) == 1
        assert [e.event_id for e in found[0].evidence] == ["m1", "t1", "m2"]


class TestMetadata:
    def test_doc_follows_appendix_a_template(self) -> None:
        validate_meta(META)
        assert META.tier == "projected"
        assert "tokens_in(model_call)" in META.requirements
