"""Epic TL-C / TL-D2 (JG-133): rule docs render from metadata and never drift."""

from __future__ import annotations

import importlib.util
import re
from dataclasses import replace
from pathlib import Path

import pytest

from agentlint.rules import (
    DOC_SECTIONS,
    GENERIC_RULES,
    RuleMetaError,
    render_rule_doc,
    validate_meta,
)
from agentlint.rules.base import EMPTY_DOC, RuleMeta

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs" / "rules"
SCRIPT = ROOT / "scripts" / "render_rule_docs.py"

EXPECTED_HEADINGS = [heading for _, heading in DOC_SECTIONS]


def load_script():
    spec = importlib.util.spec_from_file_location("render_rule_docs", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class TestCommittedDocs:
    @pytest.mark.parametrize("rule", GENERIC_RULES, ids=lambda r: r.meta.id)
    def test_committed_doc_equals_rendered_metadata(self, rule) -> None:
        path = DOCS / f"{rule.meta.id}.md"
        assert path.is_file(), f"missing {path}; run scripts/render_rule_docs.py"
        assert path.read_text(encoding="utf-8") == render_rule_doc(rule.meta)

    def test_index_and_file_set_match_the_script(self) -> None:
        script = load_script()
        expected = script.render_all()
        assert sorted(p.name for p in DOCS.glob("*.md")) == sorted(expected)
        for name, content in expected.items():
            assert (DOCS / name).read_text(encoding="utf-8") == content
        assert script.main(["--check"]) == 0

    def test_check_mode_fails_when_a_doc_is_stale(self, monkeypatch, tmp_path) -> None:
        script = load_script()
        monkeypatch.setattr(script, "DOCS_DIR", tmp_path)
        assert script.main(["--check"]) == 1
        assert script.main([]) == 0
        assert script.main(["--check"]) == 0


class TestRendering:
    @pytest.mark.parametrize("rule", GENERIC_RULES, ids=lambda r: r.meta.id)
    def test_sections_appear_in_appendix_a_order(self, rule) -> None:
        text = render_rule_doc(rule.meta)
        headings = re.findall(r"^## (.+)$", text, flags=re.MULTILINE)
        assert headings == EXPECTED_HEADINGS
        assert text.startswith(f"# {rule.meta.id} — {rule.meta.title}\n")
        for requirement in rule.meta.requirements:
            assert f"`{requirement}`" in text

    def test_thresholds_defaults_are_rendered_from_metadata(self) -> None:
        by_id = {r.meta.id: r.meta for r in GENERIC_RULES}
        assert "- `min_calls` = 3" in render_rule_doc(by_id["NO_PROGRESS_CYCLE"])
        assert "- `min_result_bytes` = 65536" in render_rule_doc(by_id["OVERSIZED_TOOL_RESULT"])
        assert "- `min_delta_tokens` = 8000" in render_rule_doc(by_id["CONTEXT_GROWTH"])
        assert "- `min_ratio` = 1.5" in render_rule_doc(by_id["CONTEXT_GROWTH"])
        assert "- `min_results` = 3" in render_rule_doc(by_id["REPEATED_TOOL_RESULT"])
        assert "- `min_failures_strong` = 2" in render_rule_doc(
            by_id["IDENTICAL_RETRY_AFTER_FAILURE"]
        )

    def test_rule_without_thresholds_says_so(self) -> None:
        meta = replace(GENERIC_RULES[0].meta, id="NO_THRESHOLDS", thresholds={})
        assert "This rule has no thresholds." in render_rule_doc(meta)


class TestMetadataValidation:
    @pytest.mark.parametrize("rule", GENERIC_RULES, ids=lambda r: r.meta.id)
    def test_every_generic_rule_has_complete_metadata(self, rule) -> None:
        validate_meta(rule.meta)
        assert rule.meta.tier in {"proven", "projected", "unresolved"}
        assert rule.meta.confidence in {"low", "medium", "high"}

    @pytest.mark.parametrize("section", [name for name, _ in DOC_SECTIONS])
    def test_missing_section_fails_the_metadata_test(self, section) -> None:
        meta = GENERIC_RULES[0].meta
        broken = replace(meta, doc=replace(meta.doc, **{section: "  "}))
        with pytest.raises(RuleMetaError, match=re.escape(f"({section})")):
            validate_meta(broken)

    def test_empty_doc_lists_every_section(self) -> None:
        meta = RuleMeta(id="EMPTY", title="t", category="c", doc=EMPTY_DOC)
        with pytest.raises(RuleMetaError) as info:
            validate_meta(meta)
        for heading in EXPECTED_HEADINGS:
            assert repr(heading) in str(info.value)

    def test_malformed_id_and_requirement_are_reported(self) -> None:
        meta = replace(GENERIC_RULES[0].meta, id="lower-case", requirements=["nope"])
        with pytest.raises(RuleMetaError, match="UPPER_SNAKE_CASE"):
            validate_meta(meta)
        with pytest.raises(RuleMetaError, match="unknown requirement name"):
            validate_meta(meta)

    def test_meta_round_trips_through_dict(self) -> None:
        meta = GENERIC_RULES[2].meta
        assert RuleMeta.from_dict(meta.to_dict()) == meta
