"""TL-C5 (JG-130): REPEATED_TOOL_RESULT equality, size, placeholders, truncation."""

from __future__ import annotations

import json

from agentlint.rules import GENERIC_RULES, run_rules, validate_meta
from agentlint.rules.generic.repeated_tool_result import META, RULE_ID
from tests.conftest import load_bundle_run, load_rule_run


def findings_for(name: str):
    run = load_rule_run(name)
    report = run_rules(run, GENERIC_RULES)
    return run, report, [f for f in report.findings if f.rule_id == RULE_ID]


class TestPositive:
    def test_three_identical_10_kib_results_from_different_args_give_one_finding(self) -> None:
        run, report, found = findings_for("rtr_positive")
        assert len({e.args_fingerprint.hash for e in run.events if e.kind == "tool_call"}) == 3
        assert len(found) == 1
        finding = found[0]
        assert finding.tier == "proven"
        assert finding.confidence == "medium"
        assert [e.event_id for e in finding.evidence] == ["t1", "t2", "t3"]
        assert len({e.value for e in finding.evidence}) == 1
        assert all("result_bytes 10240" in (e.note or "") for e in finding.evidence)
        assert "fetch_schema, read_document" in finding.observed_pattern
        assert finding.thresholds == {"min_result_bytes": 8192, "min_results": 3}
        assert report.thresholds[RULE_ID] == finding.thresholds
        assert RULE_ID not in report.incomplete_for_rules

    def test_evidence_never_quotes_arguments_or_content(self) -> None:
        _, _, found = findings_for("rtr_positive")
        text = json.dumps(found[0].to_dict())
        assert "/workspace" not in text
        assert "SSSS" not in text


class TestNegative:
    def test_identical_hash_but_2_kib_is_below_the_size_threshold(self) -> None:
        _, report, found = findings_for("rtr_small")
        assert found == []
        assert RULE_ID not in report.incomplete_for_rules

    def test_short_status_strings_are_never_hashed_so_never_equal(self) -> None:
        run, _, found = findings_for("rtr_status_strings")
        assert all(e.result_fingerprint is None for e in run.events if e.kind == "tool_call")
        assert found == []

    def test_one_side_truncated_makes_no_equality_claim_and_leaves_a_note(self) -> None:
        _, report, found = findings_for("rtr_truncated")
        assert found == []
        note = next(n for n in report.abstentions if n.rule_id == RULE_ID)
        assert note.code == "rule_partial"
        assert note.fields == ["result_fingerprint(full)"]
        assert note.event_ids == ["t3"]
        assert RULE_ID in report.incomplete_for_rules

    def test_does_not_fire_on_the_example_scope_loss_pairs(self) -> None:
        run = load_bundle_run("exampleapp_scope_loss")
        report = run_rules(run, GENERIC_RULES)
        assert report.findings == []
        assert report.errors == []


class TestMetadata:
    def test_doc_follows_appendix_a_template(self) -> None:
        validate_meta(META)
        assert META.requirements == ["result_fingerprint(full)", "result_bytes"]
