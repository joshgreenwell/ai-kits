"""CONTEXT_GROWTH (TL-C3): input tokens jump sharply between comparable model calls.

Output names *candidates*, never causes: the tool results that entered the
context between two consecutive comparable model calls. Comparability
(same ``token_basis`` and ``model``) comes from
:func:`agentlint.tokens.comparable_model_calls`, so no comparison ever
crosses a basis or model change, and aggregate-only usage never qualifies.

Never reads ``Event.scope`` beyond the neutral tag namespace that the token
helpers use for routing / retrieval / compaction exclusions.
"""

from __future__ import annotations

from itertools import pairwise

from agentlint.model import Event, Finding, Run
from agentlint.rules.base import RuleDoc, RuleMeta
from agentlint.rules.config import DEFAULT_THRESHOLDS, RuleConfig
from agentlint.rules.generic._common import cite
from agentlint.tokens import comparable_model_calls

RULE_ID = "CONTEXT_GROWTH"

META = RuleMeta(
    id=RULE_ID,
    title="Sharp input-token growth between consecutive model calls",
    category="context",
    requirements=[
        "model_call",
        "tokens_in(model_call)",
        "token_basis(model_call)",
        "model(model_call)",
        "ordering",
    ],
    tier="projected",
    confidence="medium",
    thresholds=dict(DEFAULT_THRESHOLDS[RULE_ID]),
    doc=RuleDoc(
        problem=(
            "Input tokens jump sharply between consecutive model calls, usually because "
            "large tool results entered the context."
        ),
        detection=(
            "Between two consecutive comparable model calls (same `token_basis`, same "
            "`model`, routing / retrieval / compaction calls excluded), `tokens_in` rises by "
            "at least `min_delta_tokens` (Δ) AND to at least `min_ratio` (x) times the "
            "previous value. Both conditions are required. Tool-call events ordered between "
            "the two calls, plus any listed in the later call's `included_result_ids`, are "
            "reported as candidates."
        ),
        prerequisites=(
            "Per-call `tokens_in` on `model_call` events with `token_basis` and `model`, and "
            "`ordering`. Aggregate usage without a per-call breakdown does not qualify: the "
            "rule abstains with a coverage note naming `tokens_in(model_call)`."
        ),
        evidence=(
            "The locators of the two model calls with their `tokens_in`, the basis and "
            "model, and the locator of every candidate tool result with its `result_bytes` "
            "where present."
        ),
        exclusions=(
            "Aggregate usage (no per-call breakdown); routing, retrieval and compaction "
            "calls; growth across a `token_basis` change or a `model` change (the series "
            "is split there); calls without a basis; incomplete spans without ordering."
        ),
        thresholds=(
            "`min_delta_tokens` — Δ, the absolute rise in `tokens_in`; `min_ratio` — x, the "
            "rise relative to the previous call. Provisional; never tuned per run."
        ),
        limitations=(
            "Cannot attribute growth to a specific result without `included_result_ids`; "
            "prompt and system changes are invisible; the candidates are candidates, not "
            "causes."
        ),
        remediation=(
            "Truncate or summarize the candidate results; check for duplicated results "
            "(REPEATED_TOOL_RESULT)."
        ),
        tier_confidence=(
            "`projected` / `medium`: the token rise is measured, but which result caused it "
            "is inferred from ordering only."
        ),
        fixtures=(
            "`tests/fixtures/rules/cg_positive.json` (+12,000 tokens and 2x with two tool "
            "results between), `cg_aggregate_only.json` (abstention), "
            "`cg_basis_change.json` and `cg_model_change.json` (growth across a boundary, "
            "no finding), `cg_ratio_too_small.json` (+9,000 but 1.2x, no finding)."
        ),
    ),
)


def _candidates(events: list[Event], before: Event, after: Event) -> list[Event]:
    """Tool calls ordered between ``before`` and ``after``, plus the later call's included IDs."""
    ids = [e.id for e in events]
    lo, hi = ids.index(before.id), ids.index(after.id)
    between = [e for e in events[lo + 1 : hi] if e.kind == "tool_call"]
    by_id = {e.id: e for e in events}
    for included in after.included_result_ids:
        event = by_id.get(included)
        if event is not None and event.kind == "tool_call" and event not in between:
            between.append(event)
    return sorted(between, key=lambda e: e.sort_key)


def run(run: Run, config: RuleConfig) -> list[Finding]:
    """One finding per consecutive comparable pair whose ``tokens_in`` rise meets both bounds."""
    min_delta = int(config.threshold("min_delta_tokens"))
    min_ratio = float(config.threshold("min_ratio"))
    events = run.sorted_events()
    findings: list[Finding] = []
    for series in comparable_model_calls(run, config.token):
        for before, after in pairwise(series):
            if before.tokens_in is None or after.tokens_in is None:
                continue
            delta = after.tokens_in - before.tokens_in
            if delta < min_delta or after.tokens_in < min_ratio * before.tokens_in:
                continue
            ratio = after.tokens_in / before.tokens_in if before.tokens_in else None
            candidates = _candidates(events, before, after)
            evidence = [
                cite(before, field="tokens_in", value=before.tokens_in, note="before"),
                cite(after, field="tokens_in", value=after.tokens_in, note="after"),
            ]
            evidence.extend(
                cite(
                    c,
                    field="result_bytes",
                    value=c.result_bytes,
                    note=f"candidate: tool {c.name or 'unnamed'} result entered the context",
                )
                for c in candidates
            )
            ratio_text = f"x{ratio:.2f}" if ratio is not None else "from zero"
            pattern = (
                f"tokens_in rose from {before.tokens_in} to {after.tokens_in} "
                f"(+{delta}, {ratio_text}) between consecutive comparable model calls "
                f"(token_basis {after.token_basis}, model {after.model or 'absent'}); "
            )
            pattern += (
                f"{len(candidates)} tool result(s) entered the context between them "
                "and are candidates"
                if candidates
                else "no tool result was recorded between them, so candidates are unknown"
            )
            findings.append(
                Finding(
                    rule_id=RULE_ID,
                    title=META.title,
                    category=META.category,
                    tier="projected",
                    confidence="medium",
                    run_id=run.id,
                    observed_pattern=pattern,
                    impact=f"every later call in this series carries at least +{delta} tokens",
                    evidence=evidence,
                    limitations=[
                        "candidates, not causes: attribution is inferred from ordering",
                        "prompt and system changes are invisible",
                    ],
                    thresholds=dict(config.thresholds),
                )
            )
    return findings
