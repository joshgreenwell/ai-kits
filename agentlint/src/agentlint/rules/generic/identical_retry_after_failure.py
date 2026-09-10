"""IDENTICAL_RETRY_AFTER_FAILURE (TL-C2): the same failing call, retried unchanged.

Weak form: at least ``min_failures`` distinct failed executions of one tool
with one ``full`` args fingerprint. Strong form: at least
``min_failures_strong`` such failures where a model call begins after each
failure ends and before the next attempt — the model saw the failure and
chose to retry identically. The strong form is ``projected`` because model
involvement is inferred from ordering only.

Never reads ``Event.scope`` except to compare it for equality and to honour
the neutral ``retry`` / ``backoff`` tags. Never counts an approval or a
``blocked`` status as a failure.
"""

from __future__ import annotations

from agentlint.fingerprint import fingerprints_equal
from agentlint.model import Event, Finding, Run
from agentlint.rules.base import TAG_BACKOFF, TAG_RETRY, RuleDoc, RuleMeta, has_tag
from agentlint.rules.config import DEFAULT_THRESHOLDS, RuleConfig
from agentlint.rules.generic._common import (
    begins_between,
    cite,
    claimable,
    scope_key,
    short_hash,
)

RULE_ID = "IDENTICAL_RETRY_AFTER_FAILURE"

META = RuleMeta(
    id=RULE_ID,
    title="Failed call retried with identical arguments",
    category="reliability",
    requirements=["args_fingerprint(full)", "status", "ordering"],
    tier="proven",
    confidence="medium",
    thresholds=dict(DEFAULT_THRESHOLDS[RULE_ID]),
    doc=RuleDoc(
        problem=(
            "After a tool fails, the agent retries the exact same call without changing "
            "anything, so the same failure comes back."
        ),
        detection=(
            "Weak form: at least `min_failures` (N) distinct executions of the same tool "
            "with `status=error`, an equal `full` args fingerprint and byte-identical "
            "`scope`. Strong form: at least `min_failures_strong` such failures where a "
            "`model_call` begins after each failure ends and before the next attempt "
            "starts (by interval, or by `seq` when intervals are absent). Both forms may "
            "be reported for the same group; they are different claims."
        ),
        prerequisites=(
            "`args_fingerprint(full)`, `status` (at least one tool call with a known "
            "status) and `ordering`. The strong form additionally needs `model_call` "
            "events with timing or `seq`; without them only the weak form can fire."
        ),
        evidence=(
            "The locator of every failed attempt with its `error_type` / `error_code`, and "
            "for the strong form the locator of each intervening model call."
        ),
        exclusions=(
            "SDK or network retries that share one `tool_call_id` (collapsed by dedup and "
            "additionally ignored here) or carry the loader tag `retry`; approval waits "
            "(`kind=approval`) and `status=blocked` are never failures; calls tagged "
            "`backoff`; a differing `scope` (for example another host); the same error "
            "produced by different arguments."
        ),
        thresholds=(
            "`min_failures` — N for the weak form; `min_failures_strong` — N for the "
            "strong form. Provisional; never tuned per run."
        ),
        limitations=(
            "Cannot know whether the retry was reasonable (a transient error may deserve "
            "one); the strong form infers model involvement from ordering only."
        ),
        remediation=(
            "Surface the error content to the model; cap identical retries at the tool "
            "boundary."
        ),
        tier_confidence=(
            "Weak form `proven` / `medium` (identical failures are arithmetic on "
            "fingerprints and status). Strong form `projected` / `medium` (the model's "
            "involvement is inferred from ordering)."
        ),
        fixtures=(
            "`tests/fixtures/rules/irf_weak_positive.json` (three identical failures), "
            "`irf_strong_positive.json` (two failures with model calls between), "
            "`irf_different_commands.json` (same error, different args, no finding), "
            "`irf_sdk_retries_same_tool_call_id.json` (one `tool_call_id`, no finding after "
            "dedup), `irf_blocked_approval.json` (blocked approval then re-issue, no "
            "finding), `irf_status_absent.json` (status unknown, abstention)."
        ),
    ),
)


def _failed_attempt(event: Event, config: RuleConfig) -> bool:
    return (
        event.kind == "tool_call"
        and event.status == "error"
        and event.name is not None
        and not has_tag(event, (TAG_RETRY, TAG_BACKOFF), config.token)
        and claimable(event.args_fingerprint)
    )


def _groups(events: list[Event]) -> list[list[Event]]:
    """Failed attempts grouped by tool, args fingerprint and scope, one per `tool_call_id`."""
    groups: list[list[Event]] = []
    for event in events:
        for group in groups:
            head = group[0]
            if (
                head.name == event.name
                and fingerprints_equal(head.args_fingerprint, event.args_fingerprint)
                and scope_key(head) == scope_key(event)
            ):
                if event.tool_call_id is None or all(
                    m.tool_call_id != event.tool_call_id for m in group
                ):
                    group.append(event)
                break
        else:
            groups.append([event])
    return groups


def _strong_chain(group: list[Event], model_calls: list[Event]) -> list[tuple[Event, Event | None]]:
    """The longest run of attempts each followed by a model call before the next attempt.

    Returns ``(attempt, model_call_after)`` pairs; the last attempt of the
    chain has ``None``. Only the longest chain is returned.
    """
    best: list[tuple[Event, Event | None]] = []
    current: list[tuple[Event, Event | None]] = []
    for i, attempt in enumerate(group):
        if i + 1 < len(group):
            between = [m for m in model_calls if begins_between(m, attempt, group[i + 1])]
            if between:
                current.append((attempt, between[0]))
                continue
        current.append((attempt, None))
        if len(current) > len(best):
            best = current
        current = []
    return best


def _finding(
    run: Run, config: RuleConfig, group: list[Event], strong: list[tuple[Event, Event | None]]
) -> Finding:
    head = group[0]
    args_hash = head.args_fingerprint.hash if head.args_fingerprint else None
    is_strong = bool(strong)
    attempts = [a for a, _ in strong] if is_strong else group
    evidence = []
    for i, attempt in enumerate(attempts, start=1):
        evidence.append(
            cite(
                attempt,
                field="status",
                value=attempt.status,
                note=(
                    f"attempt {i}/{len(attempts)}: tool {head.name}, "
                    f"args_fingerprint {short_hash(args_hash)}, "
                    f"error_type {attempt.error_type or 'absent'}, "
                    f"error_code {attempt.error_code or 'absent'}"
                ),
            )
        )
    if is_strong:
        for i, (_, model_call) in enumerate(strong, start=1):
            if model_call is not None:
                evidence.append(
                    cite(
                        model_call,
                        field="kind",
                        value="model_call",
                        note=f"model call between attempt {i} and attempt {i + 1}",
                    )
                )
    form = "strong" if is_strong else "weak"
    pattern = (
        f"{len(attempts)} failed executions of tool {head.name} with identical arguments "
        f"({short_hash(args_hash)}) in the same scope"
    )
    if is_strong:
        pattern += ", each followed by a model call before the next attempt"
    return Finding(
        rule_id=RULE_ID,
        title=META.title,
        category=META.category,
        tier="projected" if is_strong else "proven",
        confidence="medium",
        run_id=run.id,
        observed_pattern=f"{form} form: {pattern}",
        impact=f"{len(attempts) - 1} retry(ies) reproduced the failure",
        evidence=evidence,
        limitations=(
            [
                "cannot know whether the retry was reasonable",
                "model involvement is inferred from ordering only",
            ]
            if is_strong
            else ["cannot know whether the retry was reasonable"]
        ),
        thresholds=dict(config.thresholds),
    )


def run(run: Run, config: RuleConfig) -> list[Finding]:
    """Weak findings (>= ``min_failures``) and strong findings (>= ``min_failures_strong``)."""
    min_weak = int(config.threshold("min_failures"))
    min_strong = int(config.threshold("min_failures_strong"))
    events = run.sorted_events()
    model_calls = [e for e in events if e.kind == "model_call"]
    findings: list[Finding] = []
    for group in _groups([e for e in events if _failed_attempt(e, config)]):
        if len(group) >= min_weak:
            findings.append(_finding(run, config, group, []))
        strong = _strong_chain(group, model_calls)
        if len(strong) >= min_strong:
            findings.append(_finding(run, config, group, strong))
    return findings
