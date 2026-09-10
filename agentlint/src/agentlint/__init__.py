"""agentlint — local, offline, deterministic linting of agent run traces.

Public surface: the neutral model (:mod:`agentlint.model`), deduplication
(:mod:`agentlint.dedup`), fingerprints (:mod:`agentlint.fingerprint`) and
token-basis helpers (:mod:`agentlint.tokens`). Nothing here touches the
network, keeps state, or calls a model.
"""

from __future__ import annotations

from agentlint.dedup import dedup_events, merge_events, merge_runs, normalize_run, normalize_runs
from agentlint.fingerprint import (
    MIN_HASH_INPUT_BYTES,
    fingerprint,
    fingerprints_equal,
    is_placeholder,
    is_placeholder_fingerprint,
    utf8_length,
)
from agentlint.model import (
    COMPLETENESS_VALUES,
    CONFIDENCES,
    EVENT_KINDS,
    EVENT_STATUSES,
    FIELD_COVERAGE_VALUES,
    KNOWN_TOKEN_BASES,
    REPRESENTATIONS,
    TIERS,
    TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ,
    TOKEN_BASIS_INPUT_INCLUDES_CACHE_READ,
    Coverage,
    CoverageNote,
    Event,
    Evidence,
    Finding,
    Fingerprint,
    Run,
    canonical_json,
    field_coverage,
    finding_fingerprint,
    sort_events,
    to_json,
)
from agentlint.rules import (
    GENERIC_RULES,
    Rule,
    RuleMeta,
    RuleReport,
    all_rules,
    run_rules,
)
from agentlint.tokens import (
    DEFAULT_EXCLUDED_OPERATION_NAMES,
    DEFAULT_EXCLUDED_TAGS,
    DEFAULT_TOKEN_CONFIG,
    Selection,
    Series,
    TokenConfig,
    TokenTotals,
    calls_without_token_basis,
    comparable_model_calls,
    exclusion_reason,
    select_comparable,
    token_basis_notes,
    token_totals_by_basis,
)

__version__ = "0.0.1"

__all__ = [
    "COMPLETENESS_VALUES",
    "CONFIDENCES",
    "DEFAULT_EXCLUDED_OPERATION_NAMES",
    "DEFAULT_EXCLUDED_TAGS",
    "DEFAULT_TOKEN_CONFIG",
    "EVENT_KINDS",
    "EVENT_STATUSES",
    "FIELD_COVERAGE_VALUES",
    "GENERIC_RULES",
    "KNOWN_TOKEN_BASES",
    "MIN_HASH_INPUT_BYTES",
    "REPRESENTATIONS",
    "TIERS",
    "TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ",
    "TOKEN_BASIS_INPUT_INCLUDES_CACHE_READ",
    "Coverage",
    "CoverageNote",
    "Event",
    "Evidence",
    "Finding",
    "Fingerprint",
    "Rule",
    "RuleMeta",
    "RuleReport",
    "Run",
    "Selection",
    "Series",
    "TokenConfig",
    "TokenTotals",
    "__version__",
    "all_rules",
    "calls_without_token_basis",
    "canonical_json",
    "comparable_model_calls",
    "dedup_events",
    "exclusion_reason",
    "field_coverage",
    "finding_fingerprint",
    "fingerprint",
    "fingerprints_equal",
    "is_placeholder",
    "is_placeholder_fingerprint",
    "merge_events",
    "merge_runs",
    "normalize_run",
    "normalize_runs",
    "run_rules",
    "select_comparable",
    "sort_events",
    "to_json",
    "token_basis_notes",
    "token_totals_by_basis",
    "utf8_length",
]
