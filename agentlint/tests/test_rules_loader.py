"""TL-C6 (JG-131): app-rule loading, the shipped example rule, and the scope contract."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentlint.model import Evidence, Finding, replace_run
from agentlint.rules import (
    GENERIC_RULE_IDS,
    GENERIC_RULES,
    RuleLoadError,
    all_rules,
    load_entry_point_rules,
    load_rules_module,
    run_rules,
    validate_meta,
)
from agentlint.rules import loader as loader_module
from tests.conftest import load_bundle_run

EXAMPLE = (
    Path(__file__).resolve().parents[1] / "examples" / "rules" / "grouped_request_scope_loss.py"
)
EXAMPLE_ID = "EXAMPLEAPP_GROUP_TO_SINGLE_SCOPE_LOSS"


class FakeEntryPoint:
    def __init__(self, name: str, value) -> None:
        self.name = name
        self._value = value

    def load(self):
        if isinstance(self._value, Exception):
            raise self._value
        return self._value


class TestModuleLoading:
    def test_example_module_loads_with_its_source_noted(self) -> None:
        rules = load_rules_module(EXAMPLE)
        assert [r.meta.id for r in rules] == [EXAMPLE_ID]
        assert rules[0].source == f"module:{EXAMPLE}"
        validate_meta(rules[0].meta)
        assert rules[0].meta.requirements == ["args_fingerprint(full)", "status", "ordering"]

    def test_all_rules_lists_builtins_and_module_rules_with_sources(self) -> None:
        rules = all_rules(extra_modules=[EXAMPLE], include_entry_points=False)
        assert [r.meta.id for r in rules] == [*GENERIC_RULE_IDS, EXAMPLE_ID]
        assert {r.source for r in rules[:5]} == {"builtin"}
        assert rules[-1].source.startswith("module:")

    def test_module_with_meta_run_pair_and_dict_metadata(self, tmp_path) -> None:
        path = tmp_path / "pack.py"
        path.write_text(
            "META = {'id': 'PACK_RULE', 'title': 'Pack', 'category': 'test', "
            "'requirements': ['status']}\n"
            "def run(run, config):\n    return []\n",
            encoding="utf-8",
        )
        rules = load_rules_module(path)
        assert rules[0].meta.id == "PACK_RULE"
        assert rules[0].meta.tier == "unresolved"
        assert rules[0].source == f"module:{path}"

    def test_module_without_rules_or_with_import_error_is_reported(self, tmp_path) -> None:
        empty = tmp_path / "empty.py"
        empty.write_text("X = 1\n", encoding="utf-8")
        with pytest.raises(RuleLoadError, match="expected a RULES list or a META/run pair"):
            load_rules_module(empty)
        broken = tmp_path / "broken.py"
        broken.write_text("raise ImportError('nope')\n", encoding="utf-8")
        with pytest.raises(RuleLoadError, match="import failed"):
            load_rules_module(broken)
        with pytest.raises(RuleLoadError, match="no such file"):
            load_rules_module(tmp_path / "missing.py")

    def test_duplicate_rule_ids_name_both_sources(self, tmp_path) -> None:
        path = tmp_path / "dup.py"
        path.write_text(
            "from agentlint.rules.generic import no_progress_cycle as m\n"
            "RULES = [(m.META, m.run)]\n",
            encoding="utf-8",
        )
        with pytest.raises(RuleLoadError, match="duplicate rule id NO_PROGRESS_CYCLE: builtin"):
            all_rules(extra_modules=[path], include_entry_points=False)


class TestEntryPoints:
    def test_entry_point_rules_are_loaded_with_their_source(self, monkeypatch) -> None:
        import importlib.util

        spec = importlib.util.spec_from_file_location("example_pack", EXAMPLE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        fakes = [FakeEntryPoint("zeta", module), FakeEntryPoint("alpha", GENERIC_RULES[0])]
        monkeypatch.setattr(loader_module, "entry_points", lambda group: fakes)
        rules = load_entry_point_rules()
        assert [(r.meta.id, r.source) for r in rules] == [
            ("NO_PROGRESS_CYCLE", "entry-point:alpha"),
            (EXAMPLE_ID, "entry-point:zeta"),
        ]

    def test_all_rules_includes_entry_points_and_rejects_duplicates(self, monkeypatch) -> None:
        monkeypatch.setattr(
            loader_module, "entry_points", lambda group: [FakeEntryPoint("dup", GENERIC_RULES[0])]
        )
        with pytest.raises(RuleLoadError, match="entry-point:dup"):
            all_rules()

    def test_broken_entry_point_is_reported_by_name(self, monkeypatch) -> None:
        monkeypatch.setattr(
            loader_module,
            "entry_points",
            lambda group: [FakeEntryPoint("broken", ImportError("missing dependency"))],
        )
        with pytest.raises(RuleLoadError, match="entry-point:broken"):
            load_entry_point_rules()

    def test_real_entry_point_group_is_empty_in_this_checkout(self) -> None:
        assert [r.meta.id for r in load_entry_point_rules()] == []


class TestExampleRule:
    def test_two_group_failures_reissued_as_singles_give_one_finding(self) -> None:
        run = load_bundle_run("exampleapp_scope_loss")
        rules = all_rules(extra_modules=[EXAMPLE], include_entry_points=False)
        report = run_rules(run, rules)
        assert report.errors == []
        found = [f for f in report.findings if f.rule_id == EXAMPLE_ID]
        assert len(found) == 1
        finding = found[0]
        assert finding.tier == "proven"
        assert [e.event_id for e in finding.evidence] == [
            "row-0003",
            "row-0005",
            "row-0007",
            "row-0009",
        ]
        locators = {e.id: e.source_locator for e in run.events}
        assert all(e.source_locator == locators[e.event_id] for e in finding.evidence)
        assert finding.impact == "final run status: failed"
        assert "2 failed group request(s)" in finding.observed_pattern
        assert finding.thresholds == {}

    def test_evidence_counts_targets_but_never_quotes_them(self) -> None:
        run = load_bundle_run("exampleapp_scope_loss")
        report = run_rules(run, load_rules_module(EXAMPLE))
        text = json.dumps(report.findings[0].to_dict())
        assert "target-" not in text
        assert "targets 3" in text
        assert "targets 1" in text

    def test_generic_rules_never_fire_on_the_scope_loss_pairs(self) -> None:
        run = load_bundle_run("exampleapp_scope_loss")
        report = run_rules(run, GENERIC_RULES)
        assert report.findings == []
        assert report.errors == []

    def test_intervening_user_scope_change_gives_no_finding(self) -> None:
        run = load_bundle_run("exampleapp_scope_change")
        report = run_rules(run, load_rules_module(EXAMPLE))
        assert report.findings == []
        assert report.errors == []

    def test_absent_selection_data_is_possible_scope_contraction_incomplete(self) -> None:
        run = load_bundle_run("exampleapp_scope_loss_unresolved")
        report = run_rules(run, load_rules_module(EXAMPLE))
        assert len(report.findings) == 1
        finding = report.findings[0]
        assert finding.tier == "unresolved"
        assert finding.confidence == "low"
        assert finding.observed_pattern.startswith("possible scope contraction / incomplete")
        assert [e.event_id for e in finding.evidence] == ["row-0003", "row-0005"]

    def test_requirements_gate_the_app_rule_like_any_other(self) -> None:
        run = load_bundle_run("exampleapp_scope_loss")
        stripped = replace_run(
            run,
            events=[
                e if e.kind != "tool_call" else replace_event(e, args_fingerprint=None)
                for e in run.events
            ],
        )
        report = run_rules(stripped, load_rules_module(EXAMPLE))
        assert report.findings == []
        note = next(n for n in report.abstentions if n.rule_id == EXAMPLE_ID)
        assert note.fields == ["args_fingerprint(full)"]
        assert report.incomplete_for_rules == [EXAMPLE_ID]

    def test_module_source_is_reported_in_rule_listing_dict(self) -> None:
        rule = load_rules_module(EXAMPLE)[0]
        listing = rule.to_dict()
        assert listing["source"] == f"module:{EXAMPLE}"
        assert listing["id"] == EXAMPLE_ID
        assert set(listing["doc"]) == {
            "problem",
            "detection",
            "prerequisites",
            "evidence",
            "exclusions",
            "thresholds",
            "limitations",
            "remediation",
            "tier_confidence",
            "fixtures",
        }


def replace_event(event, **changes):
    """``dataclasses.replace`` for a frozen Event."""
    from dataclasses import replace

    return replace(event, **changes)


class TestScopeContract:
    def test_app_rule_reads_only_its_own_namespace(self) -> None:
        run = load_bundle_run("exampleapp_scope_loss")
        renamed = replace_run(
            run,
            events=[
                replace_event(e, scope={"otherapp": next(iter(e.scope.values()))})
                if e.scope
                else e
                for e in run.events
            ],
        )
        report = run_rules(renamed, load_rules_module(EXAMPLE))
        assert report.findings == []

    def test_generic_rules_do_not_change_when_app_scope_is_removed(self) -> None:
        run = load_bundle_run("exampleapp_scope_loss")
        bare = replace_run(run, events=[replace_event(e, scope={}) for e in run.events])
        with_scope = run_rules(run, GENERIC_RULES).to_dict()
        without_scope = run_rules(bare, GENERIC_RULES).to_dict()
        assert with_scope == without_scope

    def test_finding_with_evidence_outside_raw_records_is_rejected(self) -> None:
        run = load_bundle_run("exampleapp_scope_loss")
        example = load_rules_module(EXAMPLE)[0]

        def body(r, config):
            return [
                Finding(
                    rule_id=EXAMPLE_ID,
                    title="x",
                    category="scope",
                    tier="proven",
                    confidence="medium",
                    run_id=r.id,
                    observed_pattern="p",
                    evidence=[Evidence(event_id="row-9999", source_locator="made-up#1")],
                )
            ]

        from dataclasses import replace

        report = run_rules(run, [replace(example, run=body)])
        assert report.findings == []
        assert "evidence must cite original identifiers" in report.errors[0].message
