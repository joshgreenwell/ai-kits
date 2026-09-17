# USG-022: Build tool-call summaries and the multi-source knowledge breakdown

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
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

Completed September 16, 2026 on the USG-006 and USG-008 collection, the USG-012 read model, and the USG-015 Settings > Sources registry UI.

- `components/usage-breakdown-cards.tsx` adds `ToolKnowledgeCard`, rendered by `components/tokens-overview.tsx` as the final Tokens card, after the project and agent breakdowns and before the coverage card, from the same `GET /api/usage-query` result.
- The summary band keeps three counts apart and names each: tool invocations (each once; results and status updates are not counted again), model calls (the headline's canonical requests), and agent spawns (delegation attempts), plus caller attribution coverage over reported invocations. Top tools show name, class, namespace, invocations, and share; top callers show the agent (named as in the Agents card) and recorded model with their invocation counts. Outcome counts appear only where the result's outcome coverage has classified invocations, with the unrecorded remainder named; otherwise the card says outcomes were not collected rather than assuming success. An unsupported filter (the model filter) is shown as a warning badge.
- The Knowledge sources area lists one row per source, including unassigned identities and unknown rows, with accesses, distinct tool calls, sessions, agents, read/search/write/unknown counts, and earlier-configuration accesses; badges carry the configured-source count and the unduplicated distinct tool-call total, which is kept separate from the global tool total; "Configure sources" links to `/settings/sources`. The empty state explains the `requests_with_tools` and configured-source prerequisites and that running inside a vault folder is not access.
- The footnotes carry the layer's own coverage notes and the limits: per-source counts overlap, access is not proof the answer used the contents, and no per-source token cost is estimated.
- `tests/tokens-overview.test.tsx` checks the three separate counts, outcomes and their remainder, the unsupported-filter badge, tool and caller rows, the knowledge rows with every column, the Settings link, the overlap wording, and the empty states. `npm run typecheck`, `npm test` (127 passing), and `npm run build` pass.
- Remaining blocker, owned by USG-025: production collects `buckets_only`, and tool and access rows upload only at `requests_with_tools`, so this card shows its empty states there until the detail level changes at the source and the companion build carrying USG-008 is deployed.
