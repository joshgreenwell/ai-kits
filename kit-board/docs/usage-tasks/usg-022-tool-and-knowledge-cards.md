# USG-022: Build tool-call summaries and the multi-source knowledge breakdown

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P1
Scope: Core
Stage: 4. Interface
Dependencies: [USG-006](usg-006-collect-tool-invocations.md), [USG-008](usg-008-collect-knowledge-source-access.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md)
Created: 2026-09-13

## Outcome

Show what tools are called and how often each configured knowledge source is accessed.

## Current gap

Current brain counters do not explain general tool use or distinguish multiple vaults.

## Acceptance criteria

1. Add the final Tokens card with total reported invocations, top tools by count/share, and top callers by model/agent where supported.
2. Distinguish tool invocations, model calls, and agent spawns, and show successful/failed/unknown outcome counts only where collected.
3. Provide a dedicated Knowledge sources area with one inspectable row/card per configured source, observed access counts, distinct sessions/agents, and supported read/search/write categories.
4. Show evidence and detection coverage, unconfigured sources, ambiguous attribution, and a link to configure sources in global Settings.
5. Explain overlapping resource counts and keep them separate from the distinct global tool total. Do not claim proof of answer usage or exact resource token cost.

## Verification

Verify two vaults plus another source, a multi-resource call, failures, unknown evidence, partial history, filtered top callers, and empty/configuration states.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [app/(private)/usage/page.tsx](<../../app/(private)/usage/page.tsx>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
