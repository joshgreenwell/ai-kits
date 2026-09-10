"""Rules: metadata-documented, evidence-backed, abstaining detectors (plan §2.6, §2.7).

* :mod:`agentlint.rules.base` — the rule contract, Appendix A docs, requirement checks.
* :mod:`agentlint.rules.config` — provisional thresholds and the ``agentlint.toml`` loader.
* :mod:`agentlint.rules.engine` — runs rules, validates evidence, collapses findings.
* :mod:`agentlint.rules.generic` — the five built-in rules.
* :mod:`agentlint.rules.loader` — ``--rules-module`` files and ``agentlint.rules`` entry points.

Nothing here touches the network, keeps state, or reads trace content.
"""

from __future__ import annotations

from agentlint.rules.base import (
    DOC_SECTIONS,
    NEUTRAL_TAGS,
    Rule,
    RuleDoc,
    RuleMeta,
    RuleMetaError,
    check_requirements,
    has_tag,
    partial_coverage_notes,
    render_rule_doc,
    validate_meta,
)
from agentlint.rules.config import (
    DEFAULT_RULES_CONFIG,
    DEFAULT_THRESHOLDS,
    RuleConfig,
    RulesConfig,
    load_config,
    parse_config,
)
from agentlint.rules.engine import RuleError, RuleReport, run_rules, validate_finding
from agentlint.rules.generic import GENERIC_RULE_IDS, GENERIC_RULES
from agentlint.rules.loader import (
    RuleLoadError,
    all_rules,
    load_entry_point_rules,
    load_rules_module,
)

__all__ = [
    "DEFAULT_RULES_CONFIG",
    "DEFAULT_THRESHOLDS",
    "DOC_SECTIONS",
    "GENERIC_RULES",
    "GENERIC_RULE_IDS",
    "NEUTRAL_TAGS",
    "Rule",
    "RuleConfig",
    "RuleDoc",
    "RuleError",
    "RuleLoadError",
    "RuleMeta",
    "RuleMetaError",
    "RuleReport",
    "RulesConfig",
    "all_rules",
    "check_requirements",
    "has_tag",
    "load_config",
    "load_entry_point_rules",
    "load_rules_module",
    "parse_config",
    "partial_coverage_notes",
    "render_rule_doc",
    "run_rules",
    "validate_finding",
    "validate_meta",
]
