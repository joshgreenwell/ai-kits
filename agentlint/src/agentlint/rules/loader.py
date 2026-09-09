"""Rule discovery: built-ins, ``--rules-module`` files and ``agentlint.rules`` entry points.

An app adds rules without a framework (plan §2.7): a module exposes either
a module-level ``RULES`` list or a single ``META`` / ``run`` pair. Rules are
loaded from a file path (:func:`load_rules_module`) or from the Python entry
point group ``agentlint.rules`` (:func:`load_entry_point_rules`), and
:func:`all_rules` combines them with the built-ins, noting each rule's
``source``.

What this module never does:

* never imports a module the caller did not name (paths and entry points only);
* never runs a rule — loading only inspects metadata;
* never accepts two rules with the same ID; the conflict names both sources.
"""

from __future__ import annotations

import hashlib
import importlib.util
from collections.abc import Iterable, Mapping
from dataclasses import replace
from importlib.metadata import entry_points
from pathlib import Path
from types import ModuleType
from typing import Any

from agentlint.rules.base import Rule, RuleMeta
from agentlint.rules.generic import GENERIC_RULES

ENTRY_POINT_GROUP = "agentlint.rules"


class RuleLoadError(ValueError):
    """A module or entry point did not yield well-formed rules."""


def coerce_meta(value: Any, source: str) -> RuleMeta:
    """Accept a :class:`RuleMeta` or a mapping with id / title / category / requirements."""
    if isinstance(value, RuleMeta):
        return value
    if isinstance(value, Mapping):
        missing = [k for k in ("id", "title", "category", "requirements") if k not in value]
        if missing:
            raise RuleLoadError(f"{source}: rule metadata lacks {', '.join(missing)}")
        try:
            return RuleMeta.from_dict(value)
        except (KeyError, TypeError, ValueError) as exc:
            raise RuleLoadError(f"{source}: bad rule metadata: {exc}") from exc
    raise RuleLoadError(
        f"{source}: META must be a RuleMeta or a mapping, got {type(value).__name__}"
    )


def coerce_rule(value: Any, source: str) -> Rule:
    """Turn a :class:`Rule`, an object with ``meta``/``run`` or a ``(meta, run)`` pair into one."""
    if isinstance(value, Rule):
        return replace(value, source=source)
    if isinstance(value, tuple) and len(value) == 2:
        meta, run = value
    elif hasattr(value, "meta") and hasattr(value, "run"):
        meta, run = value.meta, value.run
    elif isinstance(value, Mapping) and "meta" in value and "run" in value:
        meta, run = value["meta"], value["run"]
    else:
        raise RuleLoadError(f"{source}: cannot interpret {value!r} as a rule")
    if not callable(run):
        raise RuleLoadError(f"{source}: rule run must be callable")
    return Rule(meta=coerce_meta(meta, source), run=run, source=source)


def rules_from_object(obj: Any, source: str) -> list[Rule]:
    """Rules exposed by a module-like object: a ``RULES`` list or a ``META``/``run`` pair."""
    if hasattr(obj, "RULES"):
        rules_attr = obj.RULES
        if not isinstance(rules_attr, Iterable) or isinstance(rules_attr, str | bytes):
            raise RuleLoadError(f"{source}: RULES must be a list of rules")
        rules = [coerce_rule(item, source) for item in rules_attr]
    elif hasattr(obj, "META") and hasattr(obj, "run"):
        rules = [coerce_rule((obj.META, obj.run), source)]
    elif isinstance(obj, Iterable) and not isinstance(obj, str | bytes | ModuleType):
        rules = [coerce_rule(item, source) for item in obj]
    else:
        raise RuleLoadError(f"{source}: expected a RULES list or a META/run pair")
    if not rules:
        raise RuleLoadError(f"{source}: no rules found")
    return rules


def load_rules_module(path: str | Path) -> list[Rule]:
    """Import the Python file at ``path`` and return the rules it exposes.

    The module is loaded under a private name derived from its path so two
    files with the same basename do not collide. Each rule's ``source`` is
    ``module:<path>``. Raises :class:`RuleLoadError` when the file cannot be
    imported or exposes no well-formed rules.
    """
    path = Path(path)
    source = f"module:{path}"
    if not path.is_file():
        raise RuleLoadError(f"{source}: no such file")
    digest = hashlib.sha256(str(path.resolve()).encode("utf-8")).hexdigest()[:16]
    module_name = f"agentlint_rules_module_{digest}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuleLoadError(f"{source}: cannot create an import spec")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        raise RuleLoadError(f"{source}: import failed: {type(exc).__name__}: {exc}") from exc
    return rules_from_object(module, source)


def load_entry_point_rules(group: str = ENTRY_POINT_GROUP) -> list[Rule]:
    """Rules registered under the ``agentlint.rules`` entry point group.

    Each entry point may resolve to a module, a ``RULES`` list, a ``Rule``
    or a ``META``/``run`` object. Entry points are visited in name order and
    each rule's ``source`` is ``entry-point:<name>``. A broken entry point
    raises :class:`RuleLoadError` naming it.
    """
    rules: list[Rule] = []
    for ep in sorted(entry_points(group=group), key=lambda e: e.name):
        source = f"entry-point:{ep.name}"
        try:
            loaded = ep.load()
        except Exception as exc:
            raise RuleLoadError(f"{source}: load failed: {type(exc).__name__}: {exc}") from exc
        if isinstance(loaded, Rule) or (hasattr(loaded, "meta") and hasattr(loaded, "run")):
            rules.append(coerce_rule(loaded, source))
        else:
            rules.extend(rules_from_object(loaded, source))
    return rules


def check_unique_ids(rules: Iterable[Rule]) -> None:
    """Raise :class:`RuleLoadError` when two rules share an ID, naming both sources."""
    seen: dict[str, str] = {}
    for rule in rules:
        rule_id = rule.meta.id
        if rule_id in seen:
            raise RuleLoadError(
                f"duplicate rule id {rule_id}: {seen[rule_id]} and {rule.source}"
            )
        seen[rule_id] = rule.source


def all_rules(
    extra_modules: Iterable[str | Path] = (), include_entry_points: bool = True
) -> list[Rule]:
    """Built-in rules, then rules from ``extra_modules``, then entry-point rules.

    Order is deterministic: built-ins in documentation order, module rules in
    the order the paths were given, entry points by name. Every rule's
    ``source`` is set. Duplicate IDs raise :class:`RuleLoadError`.
    """
    rules: list[Rule] = list(GENERIC_RULES)
    for path in extra_modules:
        rules.extend(load_rules_module(path))
    if include_entry_points:
        rules.extend(load_entry_point_rules())
    check_unique_ids(rules)
    return rules
