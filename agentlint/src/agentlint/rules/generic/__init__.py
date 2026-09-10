"""The five generic rules (plan §2.6), in their documented order.

Each module exports ``META`` and ``run``; :data:`GENERIC_RULES` wraps them as
:class:`agentlint.rules.base.Rule` objects with ``source="builtin"``. Generic
rules never read ``Event.scope`` beyond the neutral ``agentlint`` tag
namespace, and never judge routing, planning, relevance or correctness.
"""

from __future__ import annotations

from agentlint.rules.base import Rule
from agentlint.rules.generic import (
    context_growth,
    identical_retry_after_failure,
    no_progress_cycle,
    oversized_tool_result,
    repeated_tool_result,
)

GENERIC_RULE_MODULES = (
    no_progress_cycle,
    identical_retry_after_failure,
    context_growth,
    oversized_tool_result,
    repeated_tool_result,
)
"""Rule modules in documentation order."""

GENERIC_RULES: tuple[Rule, ...] = tuple(
    Rule(meta=module.META, run=module.run, source="builtin") for module in GENERIC_RULE_MODULES
)
"""The built-in rules, ready for :func:`agentlint.rules.engine.run_rules`."""

GENERIC_RULE_IDS: tuple[str, ...] = tuple(rule.meta.id for rule in GENERIC_RULES)

__all__ = ["GENERIC_RULES", "GENERIC_RULE_IDS", "GENERIC_RULE_MODULES"]
