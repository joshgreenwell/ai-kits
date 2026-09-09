"""NO_PROGRESS_CYCLE (TL-C1): the same call, the same result, no progress.

Never reads ``Event.scope`` except to compare it for equality and to honour
the neutral ``polling`` / ``reread`` tags. Never judges whether the repeated
result was correct or the repetition intentional.
"""

from __future__ import annotations

from agentlint.fingerprint import fingerprints_equal
from agentlint.model import Event, Finding, Run
from agentlint.rules.base import TAG_POLLING, TAG_REREAD, RuleDoc, RuleMeta, has_tag
from agentlint.rules.config import DEFAULT_THRESHOLDS, RuleConfig
from agentlint.rules.generic._common import (
    cite,
    claimable,
    scope_key,
    short_hash,
    strictly_after,
)

RULE_ID = "NO_PROGRESS_CYCLE"

META = RuleMeta(
    id=RULE_ID,
    title="Same call, same result, repeated without progress",
    category="reliability",
    requirements=["args_fingerprint(full)", "result_fingerprint(full)", "ordering"],
    tier="proven",
    confidence="medium",
    thresholds=dict(DEFAULT_THRESHOLDS[RULE_ID]),
    doc=RuleDoc(
        problem=(
            "The agent re-issues the same tool call and gets the same result back, "
            "making no progress while spending calls and tokens."
        ),
        detection=(
            "At least `min_calls` (N) sequential, non-overlapping calls to the same tool "
            "with an equal `full` args fingerprint AND an equal `full` result fingerprint "
            "and byte-identical `scope`. A cycle requires strictly ordered, non-overlapping "
            "intervals (each call starts at or after the previous one ended); when only "
            "`seq` is available the sequence order is used. Other calls may occur between "
            "the members of a cycle."
        ),
        prerequisites=(
            "`args_fingerprint(full)`, `result_fingerprint(full)` and `ordering` "
            "(`start_ms` with `end_ms`/`duration_ms`, or `seq`). When no event provides one "
            "of these the rule abstains with a coverage note naming it; events lacking "
            "them in a run that otherwise qualifies are skipped and listed in a "
            "`rule_partial` note."
        ),
        evidence=(
            "The locator of every call in the cycle, the shared args and result hashes "
            "(excerpts), the tool name, and the statement that `scope` was identical. "
            "Scope values themselves are never quoted."
        ),
        exclusions=(
            "Calls tagged `polling` or `reread` by the loader (app-declared polling and "
            "explicit rereads); fan-out (overlapping intervals); differing `scope`; "
            "fingerprints that are not `full` (redaction or truncation collisions); "
            "placeholder or under-16-byte values (never fingerprinted, so never equal)."
        ),
        thresholds=(
            "`min_calls` — the story's N: the smallest number of identical sequential "
            "calls that counts as a cycle. Provisional; never tuned per run."
        ),
        limitations=(
            "Cannot tell whether the repetition was intentional and does not judge whether "
            "the result was correct. A cycle interleaved with other work is still reported."
        ),
        remediation=(
            "Add a stop condition or memoization at the tool boundary; surface the prior "
            "result to the model so it can see nothing changed."
        ),
        tier_confidence=(
            "`proven` / `medium`: the repetition is arithmetic on fingerprints and ordering; "
            "the confidence is medium because intent is unknown."
        ),
        fixtures=(
            "`tests/fixtures/rules/npc_positive.json` (three ordered identical calls), "
            "`npc_fanout.json` (overlapping intervals, no finding), `npc_progress.json` "
            "(result changes, no finding), `npc_scope_differs.json` (scope differs, no "
            "finding), `npc_polling_tag.json` (tagged polling, no finding), "
            "`npc_redacted_results.json` (redacted results, abstention)."
        ),
    ),
)


def _eligible(event: Event, config: RuleConfig) -> bool:
    return (
        event.kind == "tool_call"
        and event.name is not None
        and not has_tag(event, (TAG_POLLING, TAG_REREAD), config.token)
        and claimable(event.args_fingerprint)
        and claimable(event.result_fingerprint)
    )


def _same_pattern(a: Event, b: Event) -> bool:
    return (
        a.name == b.name
        and fingerprints_equal(a.args_fingerprint, b.args_fingerprint)
        and fingerprints_equal(a.result_fingerprint, b.result_fingerprint)
        and scope_key(a) == scope_key(b)
    )


def _chains(events: list[Event]) -> list[list[Event]]:
    """Maximal chains of same-pattern calls where each member strictly follows the last."""
    chains: list[list[Event]] = []
    for event in events:
        placed = False
        for chain in chains:
            if _same_pattern(chain[-1], event):
                if strictly_after(chain[-1], event):
                    chain.append(event)
                    placed = True
                break
        if not placed:
            chains.append([event])
    return chains


def run(run: Run, config: RuleConfig) -> list[Finding]:
    """One finding per cycle of at least ``min_calls`` identical sequential calls."""
    min_calls = int(config.threshold("min_calls"))
    eligible = [e for e in run.sorted_events() if _eligible(e, config)]
    findings: list[Finding] = []
    for chain in _chains(eligible):
        if len(chain) < min_calls:
            continue
        first = chain[0]
        args_hash = first.args_fingerprint.hash if first.args_fingerprint else None
        result_hash = first.result_fingerprint.hash if first.result_fingerprint else None
        evidence = [
            cite(
                e,
                field="result_fingerprint",
                value=result_hash,
                note=(
                    f"call {i}/{len(chain)}: tool {first.name}, "
                    f"args_fingerprint {short_hash(args_hash)}, scope identical"
                ),
            )
            for i, e in enumerate(chain, start=1)
        ]
        findings.append(
            Finding(
                rule_id=RULE_ID,
                title=META.title,
                category=META.category,
                tier=META.tier,
                confidence=META.confidence,
                run_id=run.id,
                observed_pattern=(
                    f"{len(chain)} sequential non-overlapping calls to tool {first.name} "
                    f"with identical arguments ({short_hash(args_hash)}) and identical "
                    f"results ({short_hash(result_hash)}) in the same scope"
                ),
                impact=f"{len(chain) - 1} call(s) after the first produced nothing new",
                evidence=evidence,
                limitations=[
                    "cannot tell whether the repetition was intentional",
                    "does not judge whether the result was correct",
                ],
                thresholds=dict(config.thresholds),
            )
        )
    return findings
