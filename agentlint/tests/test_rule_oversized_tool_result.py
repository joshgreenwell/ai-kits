"""TL-C4 (JG-129): OVERSIZED_TOOL_RESULT size claim, correlation, abstention, config."""

from __future__ import annotations

from agentlint.model import replace_run
from agentlint.rules import (
    GENERIC_RULES,
    RulesConfig,
    load_config,
    parse_config,
    run_rules,
    validate_meta,
)
from agentlint.rules.generic.oversized_tool_result import META, RULE_ID
from tests.conftest import load_rule_run


def findings_for(name: str, config: RulesConfig | None = None):
    run = load_rule_run(name)
    report = run_rules(run, GENERIC_RULES, config or RulesConfig())
    return run, report, [f for f in report.findings if f.rule_id == RULE_ID]


class TestPositive:
    def test_70_kib_result_is_proven_high_with_projected_correlation(self) -> None:
        _, report, found = findings_for("otr_positive")
        assert len(found) == 1
        finding = found[0]
        assert finding.tier == "proven"
        assert finding.confidence == "high"
        assert finding.category == "cost"
        assert [e.event_id for e in finding.evidence] == ["t1", "m2"]
        size, correlation = finding.evidence
        assert (size.field, size.value) == ("result_bytes", 71680)
        assert correlation.field == "tokens_in"
        assert correlation.note is not None
        assert correlation.note.startswith("projected correlation:")
        assert "3000 -> 21000 (+18000" in correlation.note
        assert "(projected)" in finding.observed_pattern
        assert finding.thresholds == {"min_result_bytes": 65536}
        assert report.thresholds[RULE_ID] == {"min_result_bytes": 65536}
        assert RULE_ID not in report.incomplete_for_rules

    def test_without_per_call_usage_only_the_size_claim_is_made(self) -> None:
        run = load_rule_run("otr_positive")
        run = replace_run(run, events=[e for e in run.events if e.kind != "model_call"])
        report = run_rules(run, GENERIC_RULES)
        found = [f for f in report.findings if f.rule_id == RULE_ID]
        assert len(found) == 1
        assert [e.event_id for e in found[0].evidence] == ["t1"]
        assert "projected" not in found[0].observed_pattern
        assert found[0].tier == "proven"


class TestNegative:
    def test_preview_bytes_only_abstains_with_a_note(self) -> None:
        run, report, found = findings_for("otr_preview_only")
        assert all(e.preview_bytes == 71680 for e in run.events if e.kind == "tool_call")
        assert found == []
        note = next(n for n in report.abstentions if n.rule_id == RULE_ID)
        assert note.code == "rule_abstained"
        assert note.fields == ["result_bytes"]
        assert RULE_ID in report.incomplete_for_rules

    def test_loader_tagged_deliberate_large_read_is_excluded(self) -> None:
        _, report, found = findings_for("otr_tagged_large_read")
        assert found == []
        assert RULE_ID not in report.incomplete_for_rules


class TestThresholdConfig:
    def test_threshold_from_toml_text_is_applied_and_visible(self) -> None:
        config = parse_config("[rules.OVERSIZED_TOOL_RESULT]\nmin_result_bytes = 131072\n")
        _, report, found = findings_for("otr_positive", config)
        assert found == []
        assert report.thresholds[RULE_ID] == {"min_result_bytes": 131072}

    def test_threshold_from_agentlint_toml_file(self, tmp_path) -> None:
        path = tmp_path / "agentlint.toml"
        path.write_text(
            "[rules.OVERSIZED_TOOL_RESULT]\nmin_result_bytes = 1024\n", encoding="utf-8"
        )
        config = load_config(path)
        assert config.source == str(path)
        _, _, found = findings_for("rtr_small", config)
        # Three same-size results from one tool share a pattern: one finding, three citations.
        assert len(found) == 1
        assert [e.event_id for e in found[0].evidence] == ["t1", "t2", "t3"]
        assert found[0].thresholds == {"min_result_bytes": 1024}


class TestMetadata:
    def test_doc_follows_appendix_a_template(self) -> None:
        validate_meta(META)
        assert META.requirements == ["result_bytes"]
        assert META.confidence == "high"
