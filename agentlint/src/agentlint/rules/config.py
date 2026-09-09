"""Rule thresholds: provisional defaults and the ``agentlint.toml`` loader.

Every generic rule's default thresholds live here (plan §2.6) so there is one
place to read them and one place a config file can override them. Defaults
are provisional and are never tuned against a particular bad run.

What this module never does:

* never invents a threshold for a rule that declares none;
* never silently ignores an unknown threshold name — a typo in
  ``agentlint.toml`` is reported, not swallowed;
* never reads any file other than the one path it is given.
"""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentlint.tokens import DEFAULT_TOKEN_CONFIG, TokenConfig

DEFAULT_THRESHOLDS: dict[str, dict[str, Any]] = {
    "NO_PROGRESS_CYCLE": {"min_calls": 3},
    "IDENTICAL_RETRY_AFTER_FAILURE": {"min_failures": 3, "min_failures_strong": 2},
    "CONTEXT_GROWTH": {"min_delta_tokens": 8000, "min_ratio": 1.5},
    "OVERSIZED_TOOL_RESULT": {"min_result_bytes": 65536},
    "REPEATED_TOOL_RESULT": {"min_results": 3, "min_result_bytes": 8192},
}
"""Default thresholds per generic rule ID.

``min_calls`` is the story's N for NO_PROGRESS_CYCLE; ``min_failures`` /
``min_failures_strong`` are N for the weak and strong retry forms;
``min_delta_tokens`` and ``min_ratio`` are Δ and x for CONTEXT_GROWTH;
``min_result_bytes`` is B (bytes) for the size rules; ``min_results`` is N
for REPEATED_TOOL_RESULT.
"""

CONFIG_FILE_NAME = "agentlint.toml"
"""Conventional config file name; ``[rules.<RULE_ID>]`` sections hold thresholds."""


@dataclass(frozen=True, slots=True)
class RuleConfig:
    """What one rule receives when it runs: its effective thresholds and the token config.

    ``thresholds`` is the rule's defaults merged with any ``agentlint.toml``
    override; rules copy it verbatim into every :class:`agentlint.model.Finding`.
    """

    thresholds: dict[str, Any] = field(default_factory=dict)
    token: TokenConfig = DEFAULT_TOKEN_CONFIG

    def threshold(self, name: str) -> Any:
        """The configured value of threshold ``name``; raises ``KeyError`` when unknown."""
        return self.thresholds[name]

    def to_dict(self) -> dict[str, Any]:
        return {
            "thresholds": {k: self.thresholds[k] for k in sorted(self.thresholds)},
            "token": self.token.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class RulesConfig:
    """Per-rule threshold overrides plus the shared token configuration.

    ``overrides`` maps a rule ID to the threshold values a config file set;
    it is empty when no file was loaded. Overrides for rule IDs that are not
    loaded are kept but unused, so a config file may mention rules from an
    optional rule pack.
    """

    overrides: dict[str, dict[str, Any]] = field(default_factory=dict)
    token: TokenConfig = DEFAULT_TOKEN_CONFIG
    source: str | None = None

    def for_rule(self, rule_id: str, defaults: Mapping[str, Any]) -> RuleConfig:
        """Merge ``defaults`` (the rule's own) with this config's overrides for ``rule_id``.

        Raises ``ValueError`` naming the offending keys when the override
        mentions a threshold the rule does not declare; a rule with no
        thresholds accepts no overrides at all.
        """
        override = self.overrides.get(rule_id, {})
        unknown = sorted(k for k in override if k not in defaults)
        if unknown:
            known = ", ".join(sorted(defaults)) or "none"
            raise ValueError(
                f"unknown threshold(s) {', '.join(unknown)} for rule {rule_id}; known: {known}"
            )
        merged = {k: defaults[k] for k in sorted(defaults)}
        merged.update({k: override[k] for k in sorted(override)})
        return RuleConfig(thresholds=merged, token=self.token)

    def to_dict(self) -> dict[str, Any]:
        return {
            "overrides": {
                rule_id: {k: values[k] for k in sorted(values)}
                for rule_id, values in sorted(self.overrides.items())
            },
            "token": self.token.to_dict(),
            "source": self.source,
        }


DEFAULT_RULES_CONFIG = RulesConfig()


def _check_threshold_value(rule_id: str, name: str, value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(
            f"threshold {name} for rule {rule_id} must be a number, got {type(value).__name__}"
        )


def parse_config(text: str, source: str | None = None) -> RulesConfig:
    """Parse ``agentlint.toml`` text into a :class:`RulesConfig`.

    Only ``[rules.<RULE_ID>]`` tables are read; each key inside is a threshold
    name and its numeric value. Anything else in the file is ignored. Raises
    ``ValueError`` on malformed TOML or non-numeric threshold values.
    """
    label = source or "config"
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise ValueError(f"invalid TOML in {label}: {exc}") from exc
    rules_table = data.get("rules", {})
    if not isinstance(rules_table, Mapping):
        raise ValueError(f"[rules] in {label} must be a table")
    overrides: dict[str, dict[str, Any]] = {}
    for rule_id in sorted(rules_table):
        values = rules_table[rule_id]
        if not isinstance(values, Mapping):
            raise ValueError(f"[rules.{rule_id}] in {label} must be a table")
        section: dict[str, Any] = {}
        for name in sorted(values):
            _check_threshold_value(rule_id, name, values[name])
            section[name] = values[name]
        overrides[rule_id] = section
    return RulesConfig(overrides=overrides, source=source)


def load_config(path: str | Path) -> RulesConfig:
    """Read ``path`` as ``agentlint.toml`` (see :func:`parse_config`)."""
    path = Path(path)
    return parse_config(path.read_text(encoding="utf-8"), source=str(path))
