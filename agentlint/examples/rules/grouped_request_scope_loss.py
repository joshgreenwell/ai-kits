"""Example app rule: EXAMPLEAPP_GROUP_TO_SINGLE_SCOPE_LOSS.

This module shows how an application adds its own rule to agentlint without a
framework (plan §2.7). Load it with ``agentlint --rules-module
examples/rules/grouped_request_scope_loss.py`` or point an ``agentlint.rules``
entry point at it.

Abstract semantics: within one run, ordered, a *grouped* request with an
explicit multi-target selection fails; a later *single* request re-issues
the byte-identical command without the group's target selection; and no
recorded user scope change lies between the two. That is a scope loss: the
agent silently narrowed the work it was asked to do.

App contract (the only thing this rule reads beyond generic fields):

* ``Event.scope["exampleapp"]`` on tool-call events —
  ``request_kind`` (``"group"`` or ``"single"``), ``targets`` (list of target
  identifiers), ``selection_explicit`` (bool);
* ``Event.scope["exampleapp"]["scope_change"]`` (bool) on user events — a
  recorded user scope change;
* ``Event.scope["exampleapp"]["run_status"]`` on any event — the app's final
  run status, reported in the finding when present.

What this rule never does:

* never compares commands semantically — only byte-equal ``full``
  ``args_fingerprint`` values via :func:`agentlint.fingerprint.fingerprints_equal`;
* never reads any scope namespace other than ``exampleapp``;
* never quotes target identifiers — evidence carries counts only;
* never claims scope loss when selection data is absent — it emits a
  ``possible scope contraction / incomplete`` finding tiered ``unresolved``.
"""

from __future__ import annotations

from typing import Any

from agentlint.fingerprint import fingerprints_equal
from agentlint.model import Event, Evidence, Finding, Run
from agentlint.rules.base import RuleDoc, RuleMeta

NAMESPACE = "exampleapp"
RULE_ID = "EXAMPLEAPP_GROUP_TO_SINGLE_SCOPE_LOSS"

META = RuleMeta(
    id=RULE_ID,
    title="Grouped request failed, then re-issued as a single request without its targets",
    category="scope",
    requirements=["args_fingerprint(full)", "status", "ordering"],
    tier="proven",
    confidence="medium",
    thresholds={},
    doc=RuleDoc(
        problem=(
            "A grouped request with an explicit multi-target selection fails and the agent "
            "re-issues the byte-identical command as a single request, silently dropping "
            "the targets the user selected."
        ),
        detection=(
            "Ordered within one run: a tool call whose `exampleapp.request_kind` is `group` "
            "with `selection_explicit` true and more than one target fails "
            "(`status=error`); a later tool call with `request_kind` `single` has an equal "
            "`full` args fingerprint and does not carry the same target set; no user event "
            "with `exampleapp.scope_change` true lies between them. All such pairs of a run "
            "are collected into one finding."
        ),
        prerequisites=(
            "`args_fingerprint(full)`, `status` and `ordering`, plus the `exampleapp` scope "
            "fields `request_kind`, `targets` and `selection_explicit`. When the selection "
            "fields are absent on a failed group request the pair is reported as "
            "`possible scope contraction / incomplete` (tier `unresolved`)."
        ),
        evidence=(
            "For every pair: the group request's locator with its status and target count, "
            "and the single request's locator with the shared args hash and its target "
            "count. The finding's impact line carries the app's final run status when "
            "recorded."
        ),
        exclusions=(
            "A recorded user scope change between the two requests; a single request whose "
            "target set equals the group's; group requests without an explicit selection or "
            "with a single target; arguments that are not byte-identical."
        ),
        thresholds="This rule has no thresholds; every qualifying pair is reported.",
        limitations=(
            "Commands are compared as bytes only; a semantically equal command with different "
            "bytes is not matched. Selection data must be provided by the loader."
        ),
        remediation=(
            "Re-issue the command against the original target selection, or record the scope "
            "change explicitly before narrowing."
        ),
        tier_confidence=(
            "`proven` / `medium` when selection data is present; `unresolved` / `low` "
            "(\"possible scope contraction / incomplete\") when it is absent."
        ),
        fixtures=(
            "`tests/fixtures/rules/exampleapp_scope_loss.json` (two pairs, one finding), "
            "`exampleapp_scope_loss_unresolved.json` (selection data absent), "
            "`exampleapp_scope_change.json` (intervening user scope change, no finding)."
        ),
    ),
)


def _app(event: Event) -> dict[str, Any]:
    return event.scope.get(NAMESPACE) or {}


def _targets(event: Event) -> list[str] | None:
    value = _app(event).get("targets")
    if isinstance(value, list):
        return [str(t) for t in value]
    return None


def _selection_state(event: Event) -> str:
    """``explicit_multi``, ``other`` or ``absent`` for a group request."""
    app = _app(event)
    explicit = app.get("selection_explicit")
    targets = _targets(event)
    if explicit is None or targets is None:
        return "absent"
    return "explicit_multi" if explicit is True and len(targets) > 1 else "other"


def _ordered(events: list[Event], earlier: Event, later: Event) -> list[Event]:
    ids = [e.id for e in events]
    return events[ids.index(earlier.id) + 1 : ids.index(later.id)]


def _scope_change_between(events: list[Event], earlier: Event, later: Event) -> bool:
    return any(_app(e).get("scope_change") is True for e in _ordered(events, earlier, later))


def _final_status(run: Run) -> str | None:
    status = None
    for event in run.sorted_events():
        value = _app(event).get("run_status")
        if isinstance(value, str) and value:
            status = value
    return status


def _pairs(events: list[Event]) -> list[tuple[Event, Event, str]]:
    pairs: list[tuple[Event, Event, str]] = []
    for i, group in enumerate(events):
        if group.kind != "tool_call" or group.status != "error":
            continue
        if _app(group).get("request_kind") != "group":
            continue
        state = _selection_state(group)
        if state == "other":
            continue
        group_targets = set(_targets(group) or [])
        for single in events[i + 1 :]:
            if single.kind != "tool_call" or _app(single).get("request_kind") != "single":
                continue
            if not fingerprints_equal(group.args_fingerprint, single.args_fingerprint):
                continue
            single_targets = _targets(single)
            if (
                state == "explicit_multi"
                and single_targets is not None
                and set(single_targets) == group_targets
            ):
                continue
            if _scope_change_between(events, group, single):
                continue
            pairs.append((group, single, state))
    return pairs


def _finding(run: Run, pairs: list[tuple[Event, Event, str]], unresolved: bool) -> Finding:
    evidence: list[Evidence] = []
    for n, (group, single, _) in enumerate(pairs, start=1):
        group_targets = _targets(group)
        single_targets = _targets(single)
        evidence.append(
            Evidence(
                event_id=group.id,
                source_locator=group.source_locator,
                field="status",
                value=group.status,
                note=(
                    f"pair {n}: failed group request, targets "
                    f"{len(group_targets) if group_targets is not None else 'absent'}, "
                    f"selection_explicit {_app(group).get('selection_explicit')!r}"
                ),
            )
        )
        evidence.append(
            Evidence(
                event_id=single.id,
                source_locator=single.source_locator,
                field="args_fingerprint",
                value=single.args_fingerprint.hash if single.args_fingerprint else None,
                note=(
                    f"pair {n}: later single request with byte-identical arguments, targets "
                    f"{len(single_targets) if single_targets is not None else 'absent'}"
                ),
            )
        )
    status = _final_status(run)
    impact = "final run status: " + (status if status is not None else "not recorded")
    if unresolved:
        return Finding(
            rule_id=RULE_ID,
            title=META.title,
            category=META.category,
            tier="unresolved",
            confidence="low",
            run_id=run.id,
            observed_pattern=(
                f"possible scope contraction / incomplete: {len(pairs)} failed group "
                "request(s) without recorded selection data were followed by a single "
                "request with byte-identical arguments"
            ),
            impact=impact,
            evidence=evidence,
            limitations=["selection data absent: cannot tell whether targets were dropped"],
            thresholds={},
        )
    return Finding(
        rule_id=RULE_ID,
        title=META.title,
        category=META.category,
        tier="proven",
        confidence="medium",
        run_id=run.id,
        observed_pattern=(
            f"{len(pairs)} failed group request(s) with an explicit multi-target selection "
            "were re-issued as single requests with byte-identical arguments and without "
            "the group's target selection, with no recorded scope change between"
        ),
        impact=impact,
        evidence=evidence,
        limitations=["commands compared as bytes only"],
        thresholds={},
    )


def run(run: Run, config: Any) -> list[Finding]:
    """One finding per run collecting every (group failure, later single) pair.

    ``config`` is accepted for the rule contract; this rule has no thresholds.
    Pairs with selection data become one ``proven`` finding; pairs without
    become one ``unresolved`` finding.
    """
    del config
    events = run.sorted_events()
    pairs = _pairs(events)
    resolved = [p for p in pairs if p[2] == "explicit_multi"]
    unresolved = [p for p in pairs if p[2] == "absent"]
    findings: list[Finding] = []
    if resolved:
        findings.append(_finding(run, resolved, unresolved=False))
    if unresolved:
        findings.append(_finding(run, unresolved, unresolved=True))
    return findings


RULES = [(META, run)]
