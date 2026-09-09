"""TL-C1 (JG-126): NO_PROGRESS_CYCLE acceptance criteria."""

from __future__ import annotations

import json

from agentlint.fingerprint import fingerprint
from agentlint.model import finding_fingerprint
from agentlint.rules import GENERIC_RULES, RulesConfig, run_rules, validate_meta
from agentlint.rules.generic.no_progress_cycle import META, RULE_ID
from tests.conftest import load_rule_run, make_event, make_run

ARGS = fingerprint({"path": "/workspace/items", "recursive": True})
RESULT = fingerprint({"count": 3, "items": ["alpha", "beta", "gamma"]})


def report_and_findings(name: str, config: RulesConfig | None = None):
    run = load_rule_run(name)
    report = run_rules(run, GENERIC_RULES, config or RulesConfig())
    return run, report, [f for f in report.findings if f.rule_id == RULE_ID]


class TestPositive:
    def test_three_ordered_identical_calls_give_one_finding_citing_all_three(self) -> None:
        run, _, found = report_and_findings("npc_positive")
        assert len(found) == 1
        finding = found[0]
        assert [e.event_id for e in finding.evidence] == ["t1", "t2", "t3"]
        locators = {e.id: e.source_locator for e in run.events}
        for item in finding.evidence:
            assert item.source_locator == locators[item.event_id]
        assert finding.tier == "proven"
        assert finding.confidence == "medium"
        assert finding.category == "reliability"
        assert "3 sequential non-overlapping calls to tool list_items" in finding.observed_pattern

    def test_thresholds_are_shown_on_the_finding_and_in_the_report(self) -> None:
        _, report, found = report_and_findings("npc_positive")
        assert found[0].thresholds == {"min_calls": 3}
        assert report.thresholds[RULE_ID] == {"min_calls": 3}
        assert RULE_ID not in report.incomplete_for_rules
        assert report.summary_line() is None

    def test_finding_fingerprint_is_stable_and_derived_from_locators(self) -> None:
        _, report_a, found_a = report_and_findings("npc_positive")
        _, report_b, found_b = report_and_findings("npc_positive")
        assert found_a[0].fingerprint == found_b[0].fingerprint
        assert found_a[0].fingerprint == finding_fingerprint(
            RULE_ID, found_a[0].run_id, found_a[0].evidence, found_a[0].thresholds
        )
        assert json.dumps(report_a.to_dict(), sort_keys=True) == json.dumps(
            report_b.to_dict(), sort_keys=True
        )

    def test_evidence_never_quotes_scope_or_content(self) -> None:
        _, _, found = report_and_findings("npc_positive")
        text = json.dumps(found[0].to_dict())
        assert "/workspace" not in text
        assert "alpha" not in text

    def test_seq_only_ordering_is_enough(self) -> None:
        events = [
            make_event(
                f"t{i}",
                kind="tool_call",
                name="list_items",
                status="ok",
                seq=i,
                args_fingerprint=ARGS,
                result_fingerprint=RESULT,
                result_bytes=64,
            )
            for i in range(1, 4)
        ]
        report = run_rules(make_run(*events), GENERIC_RULES)
        found = [f for f in report.findings if f.rule_id == RULE_ID]
        assert len(found) == 1
        assert [e.event_id for e in found[0].evidence] == ["t1", "t2", "t3"]


class TestNegative:
    def test_fan_out_with_overlapping_intervals_gives_no_finding(self) -> None:
        _, report, found = report_and_findings("npc_fanout")
        assert found == []
        assert RULE_ID not in report.incomplete_for_rules

    def test_changed_result_is_progress(self) -> None:
        _, report, found = report_and_findings("npc_progress")
        assert found == []
        assert RULE_ID not in report.incomplete_for_rules

    def test_differing_scope_gives_no_finding(self) -> None:
        _, _, found = report_and_findings("npc_scope_differs")
        assert found == []

    def test_loader_tagged_polling_is_excluded(self) -> None:
        _, _, found = report_and_findings("npc_polling_tag")
        assert found == []

    def test_higher_threshold_from_config_suppresses_the_cycle(self) -> None:
        config = RulesConfig(overrides={RULE_ID: {"min_calls": 4}})
        _, report, found = report_and_findings("npc_positive", config)
        assert found == []
        assert report.thresholds[RULE_ID] == {"min_calls": 4}

    def test_two_identical_calls_are_below_the_default_threshold(self) -> None:
        events = [
            make_event(
                f"t{i}",
                kind="tool_call",
                name="list_items",
                status="ok",
                start_ms=i * 1000,
                end_ms=i * 1000 + 500,
                args_fingerprint=ARGS,
                result_fingerprint=RESULT,
                result_bytes=64,
            )
            for i in range(1, 3)
        ]
        report = run_rules(make_run(*events), GENERIC_RULES)
        assert [f for f in report.findings if f.rule_id == RULE_ID] == []


class TestAbstention:
    def test_redacted_results_abstain_with_a_note_naming_the_field(self) -> None:
        _, report, found = report_and_findings("npc_redacted_results")
        assert found == []
        notes = [n for n in report.abstentions if n.rule_id == RULE_ID]
        assert len(notes) == 1
        assert notes[0].code == "rule_abstained"
        assert "result_fingerprint(full)" in notes[0].fields
        assert "result_fingerprint(full)" in notes[0].message
        assert RULE_ID in report.incomplete_for_rules
        assert report.summary_line() is not None
        assert report.summary_line().startswith("incomplete for rules: [")
        assert RULE_ID in report.summary_line()

    def test_rule_is_not_invoked_when_ordering_is_absent(self) -> None:
        events = [
            make_event(
                f"t{i}",
                kind="tool_call",
                name="list_items",
                status="ok",
                args_fingerprint=ARGS,
                result_fingerprint=RESULT,
                result_bytes=64,
            )
            for i in range(1, 4)
        ]
        report = run_rules(make_run(*events), GENERIC_RULES)
        assert [f for f in report.findings if f.rule_id == RULE_ID] == []
        note = next(n for n in report.abstentions if n.rule_id == RULE_ID)
        assert note.fields == ["ordering"]


class TestMetadata:
    def test_doc_follows_appendix_a_template(self) -> None:
        validate_meta(META)
        assert META.requirements == [
            "args_fingerprint(full)",
            "result_fingerprint(full)",
            "ordering",
        ]
        assert META.thresholds == {"min_calls": 3}
