# USG-021: Build project and agent breakdown cards with drill-down

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
Priority: P1
Scope: Core
Stage: 4. Interface
Dependencies: [USG-005](usg-005-collect-agent-lineage.md), [USG-007](usg-007-map-project-identities.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md)
Created: 2026-09-13

## Outcome

Explain which projects and agents account for the selected usage.

## Current gap

Existing monthly classifications do not provide the unified mapped project and independent agent detail.

## Acceptance criteria

1. Show project and agent cards side by side on wide screens and stacked on narrow screens, after environmental impact.
2. Project rows show mapped name, token totals/share, and supported calls/conversations, with separate No project and Unknown project buckets and visible attribution coverage.
3. Agent content shows observed distinct children, main/subagent token share, built-in/custom/unknown roles, parent, actual model, and depth where recorded.
4. Selecting a project or supported agent dimension applies the common filter and produces a reversible drill-down.
5. Keep missing identity explicit and agent tokens within overall totals; do not present custom-role classification as proof of user-versus-model initiation.

## Verification

Exercise cross-machine mappings, worktrees, missing identity, nested/resumed agents, partial attribution, drill-down/reset, and reconciled totals.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [app/(private)/usage/page.tsx](<../../app/(private)/usage/page.tsx>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)

## Execution record

Completed September 16, 2026 on the USG-012 read model, USG-017 filter state, and USG-020 card placement.

- `components/usage-breakdown-cards.tsx` adds `ProjectAgentBreakdown`: a Projects card and an Agents card side by side from `xl` up and stacked below it, rendered by `components/tokens-overview.tsx` after the environmental impact section and before the coverage card, from the same `GET /api/usage-query` result as every card above. The "Next in this order" placeholder paragraph is gone; `TOKENS_SECTIONS` still declares the agreed order.
- Projects: one sortable row per result row with the mapped label or the agreed state label, exact tokens, share, calls, and conversations; No project and Unknown project are separate rows kept inside the total. Stats show the named-project count, attribution coverage (tokens carrying a project over headline tokens), and registry mapping (attributed tokens mapped to a named project), plus a badge naming the headline share without request detail. The empty state explains that hourly buckets name no project and links to project settings.
- Agents: the summary band shows main, subagent, and unattributed tokens with their share of the same total, distinct observed children, and spawn events; the role-class line shows main, built-in, custom, and unknown tokens; the table shows each agent's name or class with a short key, role, parent (named from the same rows, otherwise the short key, `session root` for the main agent, `not recorded` where absent), recorded model, depth, tokens, share, and calls. Unattributed rows are shown but not selectable.
- Drill-down: selecting a project row sets `filters.projects` to the registry id or state code; selecting an agent row sets `filters.agents` to the key; "Main agent only" and "Subagents only" toggle `agent_scope`. Every change goes through the common `onFiltersChange`, lands in the private URL, and appears as a removable chip in the filter bar; selecting the same row again or removing the chip restores the wider scope. `FilterLabels` gained `agents`, so an agent chip reads as the agent's name rather than a bare key.
- Wording keeps the acceptance limits explicit: agent tokens divide the headline and are never added; missing identity stays unattributed rather than main; a role class describes the child, not who started it, and the logs do not record user-versus-model delegation.
- `tests/tokens-overview.test.tsx` extends the synthetic result with project, agent, tool, and knowledge rows and checks every displayed figure, the card order, the selected-row state, the chip labels for a drilled-down filter set, the pure helpers `projectFilterValue` and `agentLabel`, and the empty states. `npm run typecheck`, `npm test` (127 passing), and `npm run build` pass.
- Remaining blocker, owned by USG-025: production still collects `buckets_only` with project attribution off, so both cards show their empty states there until the detail level changes at the source.
