"""REPEATED_TOOL_RESULT (TL-C5): the same sizeable result enters the context repeatedly.

Groups tool results by their ``full`` result fingerprint regardless of the
arguments that produced them. Results that were never fingerprinted (short
status strings, placeholders) or whose fingerprint is not ``full`` support
no equality claim and are left out.

Never reads ``Event.scope`` beyond the neutral ``reread`` tag.
"""

from __future__ import annotations

from agentlint.fingerprint import fingerprints_equal
from agentlint.model import Event, Finding, Run
from agentlint.rules.base import TAG_REREAD, RuleDoc, RuleMeta, has_tag
from agentlint.rules.config import DEFAULT_THRESHOLDS, RuleConfig
from agentlint.rules.generic._common import cite, claimable, short_hash

RULE_ID = "REPEATED_TOOL_RESULT"

META = RuleMeta(
    id=RULE_ID,
    title="Identical sizeable result entered the context repeatedly",
    category="cost",
    requirements=["result_fingerprint(full)", "result_bytes"],
    tier="proven",
    confidence="medium",
    thresholds=dict(DEFAULT_THRESHOLDS[RULE_ID]),
    doc=RuleDoc(
        problem=(
            "The same sizeable result enters the context multiple times, even when the "
            "arguments that produced it differ."
        ),
        detection=(
            "At least `min_results` (N) distinct tool-call events with an equal `full` "
            "result fingerprint and `result_bytes` of at least `min_result_bytes` (B), "
            "regardless of tool name or arguments."
        ),
        prerequisites=(
            "`result_fingerprint(full)` and `result_bytes` on tool-call events. Events whose "
            "fingerprint is not `full` are skipped and listed in a `rule_partial` note; no "
            "equality claim is made about them."
        ),
        evidence=(
            "The locator of every repeated result, the shared result hash (excerpt), each "
            "result's size, and the tool name and args fingerprint that produced it."
        ),
        exclusions=(
            "Empty or status results (under 16 bytes or placeholders are never "
            "fingerprinted, so never equal); deliberate rereads tagged `reread` by the "
            "loader; redaction or truncation collisions (fingerprints that are not `full`)."
        ),
        thresholds=(
            "`min_results` — N, how many identical results it takes; `min_result_bytes` — "
            "B, the smallest size that counts, in bytes. Provisional; never tuned per run."
        ),
        limitations=(
            "Identical bytes can be legitimately needed repeatedly (a schema, a manifest); "
            "the rule cannot judge necessity."
        ),
        remediation="Cache at the tool boundary or reference the earlier result.",
        tier_confidence=(
            "`proven` / `medium`: equality and size are arithmetic on fingerprints and byte "
            "counts; necessity is unknown."
        ),
        fixtures=(
            "`tests/fixtures/rules/rtr_positive.json` (three 10 KiB results with one hash "
            "and different args), `rtr_small.json` (2 KiB, no finding), "
            "`rtr_status_strings.json` (`\"ok\"` results never hashed, no finding), "
            "`rtr_truncated.json` (one side truncated, no claim, partial note)."
        ),
    ),
)


def _eligible(event: Event, min_bytes: int, config: RuleConfig) -> bool:
    return (
        event.kind == "tool_call"
        and event.result_bytes is not None
        and event.result_bytes >= min_bytes
        and not has_tag(event, (TAG_REREAD,), config.token)
        and claimable(event.result_fingerprint)
    )


def run(run: Run, config: RuleConfig) -> list[Finding]:
    """One finding per result hash shared by at least ``min_results`` sizeable results."""
    min_results = int(config.threshold("min_results"))
    min_bytes = int(config.threshold("min_result_bytes"))
    groups: list[list[Event]] = []
    for event in run.sorted_events():
        if not _eligible(event, min_bytes, config):
            continue
        for group in groups:
            if fingerprints_equal(group[0].result_fingerprint, event.result_fingerprint):
                if all(m.id != event.id for m in group):
                    group.append(event)
                break
        else:
            groups.append([event])

    findings: list[Finding] = []
    for group in groups:
        if len(group) < min_results:
            continue
        result_hash = group[0].result_fingerprint.hash if group[0].result_fingerprint else None
        evidence = [
            cite(
                e,
                field="result_fingerprint",
                value=result_hash,
                note=(
                    f"result {i}/{len(group)}: tool {e.name or 'unnamed'}, "
                    f"args_fingerprint "
                    f"{short_hash(e.args_fingerprint.hash if e.args_fingerprint else None)}, "
                    f"result_bytes {e.result_bytes}"
                ),
            )
            for i, e in enumerate(group, start=1)
        ]
        tools = sorted({e.name or "unnamed" for e in group})
        findings.append(
            Finding(
                rule_id=RULE_ID,
                title=META.title,
                category=META.category,
                tier="proven",
                confidence="medium",
                run_id=run.id,
                observed_pattern=(
                    f"{len(group)} results with identical bytes ({short_hash(result_hash)}, "
                    f"{min(e.result_bytes or 0 for e in group)} bytes or more each) entered "
                    f"the context from tool(s) {', '.join(tools)}"
                ),
                impact=f"{len(group) - 1} copy(ies) of the same result were paid for again",
                evidence=evidence,
                limitations=["identical bytes can be legitimately needed repeatedly"],
                thresholds=dict(config.thresholds),
            )
        )
    return findings
