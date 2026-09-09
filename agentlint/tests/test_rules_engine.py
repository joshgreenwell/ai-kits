"""Epic TL-C (JG-114) / TL-C6 (JG-131): engine abstention, errors, evidence validation, collapse."""

from __future__ import annotations

import json

import pytest

from agentlint.fingerprint import fingerprint
from agentlint.model import Evidence, Finding, Run, finding_fingerprint
from agentlint.rules import (
    GENERIC_RULES,
    Rule,
    RuleDoc,
    RuleMeta,
    RulesConfig,
    check_requirements,
    parse_config,
    run_rules,
)
from agentlint.rules.base import parse_requirement, partial_coverage_notes, requirement_status
from agentlint.rules.engine import EVIDENCE_ERROR_PREFIX
from tests.conftest import load_rule_run, make_event, make_run

DOC = RuleDoc(*(["text"] * 10))


def meta(rule_id: str, requirements: list[str] | None = None, **kw) -> RuleMeta:
    values = dict(
        id=rule_id,
        title=rule_id.lower(),
        category="test",
        requirements=requirements or [],
        tier="proven",
        confidence="medium",
        doc=DOC,
    )
    values.update(kw)
    return RuleMeta(**values)


def finding_for(run: Run, rule_id: str, *evidence: Evidence, **kw) -> Finding:
    values = dict(
        rule_id=rule_id,
        title=rule_id.lower(),
        category="test",
        tier="proven",
        confidence="medium",
        run_id=run.id,
        observed_pattern="pattern",
        evidence=list(evidence),
    )
    values.update(kw)
    return Finding(**values)


class TestAbstention:
    def test_unmet_requirement_leaves_a_note_and_never_invokes_the_rule(self) -> None:
        calls: list[str] = []

        def body(run, config):
            calls.append(run.id)
            return []

        rule = Rule(meta=meta("NEEDS_BYTES", ["result_bytes"]), run=body, source="test")
        run = make_run(make_event("t1", kind="tool_call", seq=1))
        report = run_rules(run, [rule])
        assert calls == []
        assert [n.code for n in report.abstentions] == ["rule_abstained"]
        note = report.abstentions[0]
        assert note.rule_id == "NEEDS_BYTES"
        assert note.fields == ["result_bytes"]
        assert "result_bytes" in note.message
        assert report.incomplete_for_rules == ["NEEDS_BYTES"]
        assert report.summary_line() == "incomplete for rules: [NEEDS_BYTES]"
        assert report.rules_run == []

    def test_partial_coverage_is_noted_and_the_rule_still_runs(self) -> None:
        run = make_run(
            make_event("t1", kind="tool_call", seq=1, result_bytes=10),
            make_event("t2", kind="tool_call", seq=2),
        )
        rule = Rule(meta=meta("NEEDS_BYTES", ["result_bytes"]), run=lambda r, c: [], source="test")
        report = run_rules(run, [rule])
        assert report.rules_run == ["NEEDS_BYTES"]
        note = report.abstentions[0]
        assert note.code == "rule_partial"
        assert note.event_ids == ["t2"]
        assert report.incomplete_for_rules == ["NEEDS_BYTES"]
        assert partial_coverage_notes(run, rule.meta)[0].fields == ["result_bytes"]

    def test_coverage_fields_absent_is_a_fast_negative(self) -> None:
        run = load_rule_run("otr_preview_only")
        assert run.coverage.fields["result_bytes"] == "absent"
        assert check_requirements(run, meta("X", ["result_bytes"])) == ["result_bytes"]

    def test_unknown_requirement_is_never_satisfied(self) -> None:
        run = load_rule_run("npc_positive")
        assert check_requirements(run, meta("X", ["telepathy"])) == ["telepathy"]
        assert requirement_status(run, "telepathy").met is False
        with pytest.raises(ValueError, match="unknown requirement name"):
            parse_requirement("telepathy")
        with pytest.raises(ValueError, match="takes no qualifier"):
            parse_requirement("ordering(full)")
        with pytest.raises(ValueError, match="unknown qualifier"):
            parse_requirement("result_bytes(full)")

    def test_ordering_is_met_by_seq_or_by_start_with_an_end(self) -> None:
        by_seq = make_run(make_event("a", seq=1), make_event("b", seq=2))
        by_time = make_run(
            make_event("a", start_ms=0, duration_ms=5), make_event("b", start_ms=10, end_ms=12)
        )
        neither = make_run(make_event("a", start_ms=0), make_event("b", start_ms=10))
        assert check_requirements(by_seq, meta("X", ["ordering"])) == []
        assert check_requirements(by_time, meta("X", ["ordering"])) == []
        assert check_requirements(neither, meta("X", ["ordering"])) == ["ordering"]


class TestErrors:
    def test_raising_rule_is_reported_by_id_and_other_rules_still_run(self) -> None:
        def boom(run, config):
            raise RuntimeError("kaboom")

        bad = Rule(meta=meta("BOOM"), run=boom, source="test")
        run = load_rule_run("npc_positive")
        report = run_rules(run, [*GENERIC_RULES, bad])
        assert [e.rule_id for e in report.errors] == ["BOOM"]
        error = report.errors[0]
        assert error.stage == "run"
        assert error.exception_type == "RuntimeError"
        assert "kaboom" in error.message
        assert "NO_PROGRESS_CYCLE" in [f.rule_id for f in report.findings]
        assert report.incomplete_for_rules == ["BOOM"]
        assert "NO_PROGRESS_CYCLE" in report.rules_run

    def test_unknown_locator_is_rejected_with_a_clear_message(self) -> None:
        run = load_rule_run("npc_positive")
        good = run.events[0]

        def body(r, c):
            return [
                finding_for(r, "CITES", Evidence(event_id="ghost", source_locator="nowhere#0")),
                finding_for(
                    r, "CITES", Evidence(event_id=good.id, source_locator=good.source_locator)
                ),
            ]

        report = run_rules(run, [Rule(meta=meta("CITES"), run=body, source="test")])
        assert len(report.errors) == 1
        assert report.errors[0].stage == "evidence"
        assert EVIDENCE_ERROR_PREFIX in report.errors[0].message
        assert "ghost@nowhere#0#" in report.errors[0].message
        assert len(report.findings) == 1
        assert report.findings[0].evidence[0].event_id == good.id
        assert report.incomplete_for_rules == ["CITES"]

    def test_locator_present_only_in_raw_records_is_accepted(self) -> None:
        run = make_run(
            make_event("t1", kind="tool_call", seq=1),
            raw_records=[{"row_id": "row-0009", "locator": "bundle.json#records[8]"}],
        )

        def body(r, c):
            return [
                finding_for(
                    r, "RAW", Evidence(event_id="row-0009", source_locator="bundle.json#records[8]")
                )
            ]

        report = run_rules(run, [Rule(meta=meta("RAW"), run=body, source="test")])
        assert report.errors == []
        assert len(report.findings) == 1

    def test_finding_with_foreign_rule_id_or_no_evidence_is_rejected(self) -> None:
        run = load_rule_run("npc_positive")
        good = run.events[0]

        def body(r, c):
            return [
                finding_for(r, "OTHER", Evidence(good.id, good.source_locator)),
                finding_for(r, "MINE"),
            ]

        report = run_rules(run, [Rule(meta=meta("MINE"), run=body, source="test")])
        assert report.findings == []
        assert [e.stage for e in report.errors] == ["evidence", "evidence"]
        assert "does not match rule" in report.errors[0].message
        assert "no evidence" in report.errors[1].message

    def test_unknown_threshold_override_is_a_config_error_for_that_rule_only(self) -> None:
        run = load_rule_run("npc_positive")
        config = RulesConfig(overrides={"NO_PROGRESS_CYCLE": {"min_cals": 3}})
        report = run_rules(run, GENERIC_RULES, config)
        assert [e.rule_id for e in report.errors] == ["NO_PROGRESS_CYCLE"]
        assert report.errors[0].stage == "config"
        assert "min_cals" in report.errors[0].message
        assert "min_calls" in report.errors[0].message
        assert "NO_PROGRESS_CYCLE" not in report.thresholds
        assert len(report.rules_run) == len(GENERIC_RULES) - 1


class TestCollapse:
    def test_same_pattern_findings_collapse_with_merged_ordered_evidence(self) -> None:
        run = load_rule_run("npc_positive")
        events = {e.id: e for e in run.events}

        def body(r, c):
            return [
                finding_for(r, "DUP", Evidence(events["t3"].id, events["t3"].source_locator)),
                finding_for(r, "DUP", Evidence(events["t1"].id, events["t1"].source_locator)),
                finding_for(r, "DUP", Evidence(events["t3"].id, events["t3"].source_locator)),
                finding_for(
                    r,
                    "DUP",
                    Evidence(events["t2"].id, events["t2"].source_locator),
                    observed_pattern="another pattern",
                ),
            ]

        report = run_rules(run, [Rule(meta=meta("DUP", thresholds={"k": 1}), run=body)])
        assert [f.observed_pattern for f in report.findings] == ["pattern", "another pattern"]
        merged = report.findings[0]
        assert [e.event_id for e in merged.evidence] == ["t1", "t3"]
        assert merged.thresholds == {"k": 1}
        assert merged.fingerprint == finding_fingerprint("DUP", run.id, merged.evidence, {"k": 1})

    def test_output_is_deterministic_regardless_of_rule_order(self) -> None:
        run = load_rule_run("npc_positive")
        forward = run_rules(run, GENERIC_RULES).to_dict()
        backward = run_rules(run, list(reversed(GENERIC_RULES))).to_dict()
        assert json.dumps(forward, sort_keys=True) == json.dumps(backward, sort_keys=True)
        assert forward["summary"] is None
        assert forward["rules_run"] == sorted(r.meta.id for r in GENERIC_RULES)

    def test_report_to_dict_is_json_serialisable_with_sorted_thresholds(self) -> None:
        run = load_rule_run("cg_aggregate_only")
        data = run_rules(run, GENERIC_RULES).to_dict()
        text = json.dumps(data, sort_keys=True)
        assert "CONTEXT_GROWTH" in data["incomplete_for_rules"]
        assert list(data["thresholds"]) == sorted(data["thresholds"])
        assert "incomplete for rules: [" in text


class TestConfig:
    def test_parse_config_reads_rule_sections_only(self) -> None:
        config = parse_config(
            "[output]\nformat = 'json'\n[rules.REPEATED_TOOL_RESULT]\nmin_results = 2\n"
        )
        assert config.overrides == {"REPEATED_TOOL_RESULT": {"min_results": 2}}
        effective = config.for_rule(
            "REPEATED_TOOL_RESULT", {"min_results": 3, "min_result_bytes": 8192}
        )
        assert effective.thresholds == {"min_result_bytes": 8192, "min_results": 2}

    def test_non_numeric_threshold_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="must be a number"):
            parse_config("[rules.X]\nmin_calls = 'three'\n")
        with pytest.raises(ValueError, match="invalid TOML"):
            parse_config("[rules.X\n")

    def test_lowered_threshold_changes_the_outcome(self) -> None:
        run = load_rule_run("rtr_small")
        config = parse_config("[rules.REPEATED_TOOL_RESULT]\nmin_result_bytes = 1024\n")
        report = run_rules(run, GENERIC_RULES, config)
        found = [f for f in report.findings if f.rule_id == "REPEATED_TOOL_RESULT"]
        assert len(found) == 1
        assert found[0].thresholds == {"min_result_bytes": 1024, "min_results": 3}


def test_fingerprint_helper_never_hashes_short_values() -> None:
    assert fingerprint("ok") is None
