"""TL-C2 (JG-127): IDENTICAL_RETRY_AFTER_FAILURE weak and strong forms."""

from __future__ import annotations

from agentlint.fingerprint import fingerprint
from agentlint.rules import GENERIC_RULES, RulesConfig, run_rules, validate_meta
from agentlint.rules.generic.identical_retry_after_failure import META, RULE_ID
from tests.conftest import load_rule_run, make_event, make_run

CMD = fingerprint({"command": "build --target all --verbose"})


def findings_for(name: str, normalize: bool = True):
    run = load_rule_run(name, normalize=normalize)
    report = run_rules(run, GENERIC_RULES)
    return run, report, [f for f in report.findings if f.rule_id == RULE_ID]


def failed(id: str, start: int, tokens: str = "call") -> object:
    return make_event(
        id,
        kind="tool_call",
        name="run_command",
        status="error",
        error_type="ExitStatus",
        error_code="1",
        start_ms=start,
        end_ms=start + 1000,
        tool_call_id=f"{tokens}-{id}",
        args_fingerprint=CMD,
        result_bytes=40,
    )


def model(id: str, start: int) -> object:
    return make_event(
        id,
        kind="model_call",
        status="ok",
        model="model-a",
        token_basis="input_includes_cache_read",
        tokens_in=1000,
        start_ms=start,
        end_ms=start + 500,
    )


class TestPositive:
    def test_weak_form_three_identical_failures(self) -> None:
        _, report, found = findings_for("irf_weak_positive")
        assert len(found) == 1
        finding = found[0]
        assert finding.tier == "proven"
        assert finding.confidence == "medium"
        assert finding.observed_pattern.startswith("weak form:")
        assert [e.event_id for e in finding.evidence] == ["t1", "t2", "t3"]
        assert all("error_type ExitStatus" in (e.note or "") for e in finding.evidence)
        assert all("error_code 1" in (e.note or "") for e in finding.evidence)
        assert finding.thresholds == {"min_failures": 3, "min_failures_strong": 2}
        assert report.thresholds[RULE_ID] == finding.thresholds

    def test_strong_form_two_failures_with_model_calls_between_is_projected(self) -> None:
        _, _, found = findings_for("irf_strong_positive")
        assert len(found) == 1
        finding = found[0]
        assert finding.tier == "projected"
        assert finding.observed_pattern.startswith("strong form:")
        assert [e.event_id for e in finding.evidence] == ["t1", "m2", "t2"]
        model_call = next(e for e in finding.evidence if e.event_id == "m2")
        assert model_call.note == "model call between attempt 1 and attempt 2"
        assert "ordering only" in " ".join(finding.limitations)

    def test_both_forms_are_reported_when_both_hold(self) -> None:
        run = make_run(
            model("m0", 0),
            failed("t1", 1000),
            model("m1", 2500),
            failed("t2", 3500),
            model("m2", 5000),
            failed("t3", 6000),
        )
        report = run_rules(run, GENERIC_RULES)
        found = [f for f in report.findings if f.rule_id == RULE_ID]
        assert sorted(f.tier for f in found) == ["projected", "proven"]

    def test_strong_form_works_with_seq_only_ordering(self) -> None:
        run = make_run(
            make_event(
                "t1",
                kind="tool_call",
                name="run_command",
                status="error",
                seq=1,
                args_fingerprint=CMD,
            ),
            make_event("m1", kind="model_call", status="ok", seq=2),
            make_event(
                "t2",
                kind="tool_call",
                name="run_command",
                status="error",
                seq=3,
                args_fingerprint=CMD,
            ),
        )
        report = run_rules(run, [r for r in GENERIC_RULES if r.meta.id == RULE_ID])
        assert [f.tier for f in report.findings] == ["projected"]


class TestNegative:
    def test_same_error_with_different_commands_is_not_a_retry(self) -> None:
        _, report, found = findings_for("irf_different_commands")
        assert found == []
        assert RULE_ID not in report.incomplete_for_rules

    def test_sdk_retries_sharing_one_tool_call_id_collapse_to_one_attempt(self) -> None:
        run, _, found = findings_for("irf_sdk_retries_same_tool_call_id", normalize=True)
        assert run.coverage.events_dropped_dedup == 2
        assert found == []

    def test_sdk_retries_are_ignored_even_before_dedup(self) -> None:
        _, _, found = findings_for("irf_sdk_retries_same_tool_call_id", normalize=False)
        assert found == []

    def test_blocked_approval_then_reissue_is_not_a_failed_retry(self) -> None:
        _, report, found = findings_for("irf_blocked_approval")
        assert found == []
        assert RULE_ID not in report.incomplete_for_rules

    def test_loader_tagged_retries_and_backoff_are_excluded(self) -> None:
        events = [failed(f"t{i}", i * 2000) for i in range(1, 4)]
        tagged = [
            make_event(
                e.id,
                kind="tool_call",
                name=e.name,
                status="error",
                start_ms=e.start_ms,
                end_ms=e.end_ms,
                tool_call_id=e.tool_call_id,
                args_fingerprint=CMD,
                scope={"agentlint": {"tags": ["retry" if i else "backoff"]}},
            )
            for i, e in enumerate(events)
        ]
        report = run_rules(make_run(*tagged), GENERIC_RULES)
        assert [f for f in report.findings if f.rule_id == RULE_ID] == []

    def test_differing_scope_is_a_different_failure(self) -> None:
        events = [
            make_event(
                f"t{i}",
                kind="tool_call",
                name="run_command",
                status="error",
                start_ms=i * 2000,
                end_ms=i * 2000 + 1000,
                tool_call_id=f"call-{i}",
                args_fingerprint=CMD,
                scope={"exampleapp": {"target": f"target-{i}"}},
            )
            for i in range(1, 4)
        ]
        report = run_rules(make_run(*events), GENERIC_RULES)
        assert [f for f in report.findings if f.rule_id == RULE_ID] == []

    def test_higher_threshold_from_config_suppresses_the_weak_form(self) -> None:
        run = load_rule_run("irf_weak_positive")
        config = RulesConfig(overrides={RULE_ID: {"min_failures": 4}})
        report = run_rules(run, GENERIC_RULES, config)
        assert [f for f in report.findings if f.rule_id == RULE_ID] == []
        assert report.thresholds[RULE_ID]["min_failures"] == 4


class TestAbstention:
    def test_absent_status_abstains_with_a_note(self) -> None:
        _, report, found = findings_for("irf_status_absent")
        assert found == []
        note = next(n for n in report.abstentions if n.rule_id == RULE_ID)
        assert note.code == "rule_abstained"
        assert "status" in note.fields
        assert RULE_ID in report.incomplete_for_rules


class TestMetadata:
    def test_doc_follows_appendix_a_template(self) -> None:
        validate_meta(META)
        assert META.requirements == ["args_fingerprint(full)", "status", "ordering"]
