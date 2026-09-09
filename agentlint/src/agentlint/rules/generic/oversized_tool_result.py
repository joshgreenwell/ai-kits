"""OVERSIZED_TOOL_RESULT (TL-C4): one result large enough to dominate the next request.

Size is ``result_bytes`` — the model-visible serialized size. ``preview_bytes``
is a lower bound kept by some exports and never triggers this rule. When
per-call usage exists, the next comparable model call's token delta is
attached as a ``projected`` correlation line.

Never reads ``Event.scope`` beyond the neutral ``large_read`` tag.
"""

from __future__ import annotations

from itertools import pairwise

from agentlint.model import Event, Finding, Run
from agentlint.rules.base import TAG_LARGE_READ, RuleDoc, RuleMeta, has_tag
from agentlint.rules.config import DEFAULT_THRESHOLDS, RuleConfig
from agentlint.rules.generic._common import cite, interval
from agentlint.tokens import comparable_model_calls

RULE_ID = "OVERSIZED_TOOL_RESULT"

META = RuleMeta(
    id=RULE_ID,
    title="Single tool result large enough to dominate the next request",
    category="cost",
    requirements=["result_bytes"],
    tier="proven",
    confidence="high",
    thresholds=dict(DEFAULT_THRESHOLDS[RULE_ID]),
    doc=RuleDoc(
        problem=(
            "A single tool result is large enough to dominate the next request's context, "
            "paying for it on every later call."
        ),
        detection=(
            "A tool-call event whose `result_bytes` (the model-visible serialized size) is "
            "at least `min_result_bytes` (B). `preview_bytes` is never used. When per-call "
            "usage exists, the next comparable model call after the result and its "
            "predecessor are located and their `tokens_in` delta is attached as a "
            "`projected` correlation line."
        ),
        prerequisites=(
            "`result_bytes` on tool-call events. Exports that only kept `preview_bytes` "
            "make the rule abstain with a coverage note naming `result_bytes`; events "
            "without it in a run that otherwise qualifies are skipped and listed in a "
            "`rule_partial` note."
        ),
        evidence=(
            "The result's locator, `result_bytes`, the tool name, and — when per-call usage "
            "exists — the locator of the next comparable model call with its `tokens_in` "
            "delta, marked projected."
        ),
        exclusions=(
            "Deliberately requested large reads tagged `large_read` by the loader; "
            "preview-only sizes (`preview_bytes` is a lower bound and never triggers)."
        ),
        thresholds=(
            "`min_result_bytes` — B, the smallest model-visible size that counts, in "
            "bytes. Provisional; never tuned per run."
        ),
        limitations=(
            "Size is not harm: a large result may be exactly what was needed. The token "
            "correlation is a projection from ordering, not an attribution."
        ),
        remediation="Paginate, filter or summarize at the tool boundary.",
        tier_confidence=(
            "`proven` / `high` for the size claim (a measured byte count against a "
            "threshold); the correlation evidence line is `projected`."
        ),
        fixtures=(
            "`tests/fixtures/rules/otr_positive.json` (70 KiB result with per-call usage), "
            "`otr_preview_only.json` (only `preview_bytes`, abstention), "
            "`otr_tagged_large_read.json` (tagged deliberate large read, no finding)."
        ),
    ),
)


def _next_comparable_pair(
    run: Run, config: RuleConfig, result: Event
) -> tuple[Event, Event] | None:
    """``(previous, next)`` comparable model calls around the first call after ``result``."""
    result_interval = interval(result)
    for series in comparable_model_calls(run, config.token):
        for previous, following in pairwise(series):
            if result.id in following.included_result_ids:
                return previous, following
            following_interval = interval(following)
            if result_interval is not None and following_interval is not None:
                if following_interval[0] >= result_interval[1] > interval_start(previous):
                    return previous, following
            elif (
                result.seq is not None
                and following.seq is not None
                and previous.seq is not None
                and previous.seq < result.seq < following.seq
            ):
                return previous, following
    return None


def interval_start(event: Event) -> int:
    """Start of ``event``'s interval, or a value that never satisfies the comparison."""
    bounds = interval(event)
    return bounds[0] if bounds is not None else -1


def run(run: Run, config: RuleConfig) -> list[Finding]:
    """One finding per tool result whose ``result_bytes`` reaches ``min_result_bytes``."""
    min_bytes = int(config.threshold("min_result_bytes"))
    findings: list[Finding] = []
    for event in run.sorted_events():
        if event.kind != "tool_call" or event.result_bytes is None:
            continue
        if event.result_bytes < min_bytes or has_tag(event, (TAG_LARGE_READ,), config.token):
            continue
        evidence = [
            cite(
                event,
                field="result_bytes",
                value=event.result_bytes,
                note=f"tool {event.name or 'unnamed'} result, model-visible size",
            )
        ]
        pattern = (
            f"tool {event.name or 'unnamed'} returned a result of {event.result_bytes} bytes "
            f"(threshold {min_bytes})"
        )
        pair = _next_comparable_pair(run, config, event)
        if pair is not None and pair[0].tokens_in is not None and pair[1].tokens_in is not None:
            delta = pair[1].tokens_in - pair[0].tokens_in
            evidence.append(
                cite(
                    pair[1],
                    field="tokens_in",
                    value=pair[1].tokens_in,
                    note=(
                        f"projected correlation: next comparable model call tokens_in "
                        f"{pair[0].tokens_in} -> {pair[1].tokens_in} ({delta:+d}, "
                        f"token_basis {pair[1].token_basis})"
                    ),
                )
            )
            pattern += f"; the next comparable model call grew by {delta:+d} tokens (projected)"
        findings.append(
            Finding(
                rule_id=RULE_ID,
                title=META.title,
                category=META.category,
                tier="proven",
                confidence="high",
                run_id=run.id,
                observed_pattern=pattern,
                impact="the result is carried by every later request in the same context",
                evidence=evidence,
                limitations=["size is not harm; the result may be exactly what was needed"],
                thresholds=dict(config.thresholds),
            )
        )
    return findings
