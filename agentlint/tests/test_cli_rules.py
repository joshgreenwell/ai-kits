"""TL-D2 (JG-133): ``agentlint rules``, ``agentlint explain``, metadata, ``--version``."""

from __future__ import annotations

from pathlib import Path

import pytest

from agentlint import __version__
from agentlint.rules import DOC_SECTIONS, GENERIC_RULE_IDS, RuleMetaError, all_rules, validate_meta
from agentlint.rules.base import render_rule_doc
from agentlint.rules.loader import load_rules_module
from tests.conftest import run_cli

EXAMPLE = Path("examples/rules/grouped_request_scope_loss.py")
EXAMPLE_ID = "EXAMPLEAPP_GROUP_TO_SINGLE_SCOPE_LOSS"
HEADINGS = [heading for _, heading in DOC_SECTIONS]


class TestRulesCommand:
    def test_lists_every_generic_rule_with_columns(self) -> None:
        result = run_cli("rules")
        assert result.code == 0, result.err
        lines = result.out.splitlines()
        assert lines[0].split() == [
            "ID",
            "CATEGORY",
            "TIER",
            "CONFIDENCE",
            "REQUIREMENTS",
            "SOURCE",
        ]
        ids = [line.split()[0] for line in lines[1:]]
        assert ids == list(GENERIC_RULE_IDS)
        assert all(line.rstrip().endswith("builtin") for line in lines[1:])
        assert "args_fingerprint(full), result_fingerprint(full), ordering" in result.out
        assert "proven" in result.out and "projected" in result.out

    def test_app_rule_appears_with_its_source(self) -> None:
        assert EXAMPLE.is_file(), "run the tests from inside agentlint/"
        result = run_cli("rules", "--rules-module", str(EXAMPLE))
        assert result.code == 0, result.err
        lines = result.out.splitlines()
        assert lines[-1].startswith(EXAMPLE_ID)
        assert lines[-1].rstrip().endswith(f"module:{EXAMPLE}")
        assert "scope" in lines[-1]

    def test_json_listing_carries_metadata_and_source(self) -> None:
        result = run_cli("rules", "--format", "json", "--rules-module", str(EXAMPLE))
        assert result.code == 0
        rows = result.json()
        assert [r["id"] for r in rows] == [*GENERIC_RULE_IDS, EXAMPLE_ID]
        assert rows[-1]["source"] == f"module:{EXAMPLE}"
        assert set(rows[0]["doc"]) == {name for name, _ in DOC_SECTIONS}
        assert rows[0]["requirements"]

    def test_bad_rules_module_is_a_usage_error(self, tmp_path: Path) -> None:
        broken = tmp_path / "broken.py"
        broken.write_text("raise ImportError('nope')\n", encoding="utf-8")
        result = run_cli("rules", "--rules-module", str(broken))
        assert result.code == 1 and "cannot load rules" in result.err
        result = run_cli("rules", "--rules-module", str(tmp_path / "missing.py"))
        assert result.code == 1 and "no such file" in result.err


class TestExplainCommand:
    @pytest.mark.parametrize("rule_id", GENERIC_RULE_IDS)
    def test_renders_every_appendix_a_section_from_metadata(self, rule_id: str) -> None:
        result = run_cli("explain", rule_id)
        assert result.code == 0, result.err
        assert result.out.startswith(f"# {rule_id} — ")
        positions = [result.out.index(f"## {heading}\n") for heading in HEADINGS]
        assert positions == sorted(positions)
        rule = next(r for r in all_rules(include_entry_points=False) if r.meta.id == rule_id)
        assert result.out == render_rule_doc(rule.meta)
        assert f"Tier: `{rule.meta.tier}`" in result.out

    def test_explain_app_rule_from_module(self) -> None:
        result = run_cli("explain", EXAMPLE_ID, "--rules-module", str(EXAMPLE))
        assert result.code == 0, result.err
        assert result.out.startswith(f"# {EXAMPLE_ID} — ")
        assert "## Fixtures" in result.out

    def test_unknown_rule_id_is_non_zero_and_lists_valid_ids(self) -> None:
        result = run_cli("explain", "NOT_A_RULE")
        assert result.code == 1
        assert result.out == ""
        assert "unknown rule ID 'NOT_A_RULE'" in result.err
        for rule_id in GENERIC_RULE_IDS:
            assert rule_id in result.err

    def test_committed_doc_matches_explain(self) -> None:
        doc = Path("docs/rules/NO_PROGRESS_CYCLE.md").read_text(encoding="utf-8")
        assert run_cli("explain", "NO_PROGRESS_CYCLE").out == doc


class TestMetadata:
    def test_every_registered_rule_passes_validate_meta(self) -> None:
        rules = all_rules(extra_modules=[EXAMPLE], include_entry_points=False)
        assert len(rules) == len(GENERIC_RULE_IDS) + 1
        for rule in rules:
            validate_meta(rule.meta)

    @pytest.mark.parametrize("section", [name for name, _ in DOC_SECTIONS])
    def test_rule_missing_a_section_fails_the_metadata_test(self, section, tmp_path) -> None:
        doc = {name: "text" for name, _ in DOC_SECTIONS}
        doc[section] = ""
        module = tmp_path / "pack.py"
        module.write_text(
            "META = {'id': 'PACK_RULE', 'title': 'Pack', 'category': 'test', "
            f"'requirements': ['status'], 'doc': {doc!r}}}\n"
            "def run(run, config):\n    return []\n",
            encoding="utf-8",
        )
        (rule,) = load_rules_module(module)
        with pytest.raises(RuleMetaError, match=section):
            validate_meta(rule.meta)
        # the CLI still lists it (loading never validates docs), so the metadata test is the gate
        assert run_cli("rules", "--rules-module", str(module)).code == 0


class TestTopLevel:
    def test_version(self) -> None:
        result = run_cli("--version")
        assert result.code == 0
        assert result.out.strip() == f"agentlint {__version__}"

    def test_no_command_prints_help_and_exits_1(self) -> None:
        result = run_cli()
        assert result.code == 1
        assert "analyze" in result.err and "explain" in result.err

    def test_unknown_flag_is_exit_1_not_2(self) -> None:
        result = run_cli("analyze", "--nope", "x")
        assert result.code == 1
        assert "error:" in result.err
