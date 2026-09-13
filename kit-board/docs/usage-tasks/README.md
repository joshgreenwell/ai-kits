# Usage collection and interface tasks

Created: 2026-09-13

**34 filesystem tasks: 26 core delivery tasks, seven follow-ups, and one optional task awaiting a decision.** USG-001 is complete and USG-002 is in progress; the remaining tasks are unstarted unless their files say otherwise. Creating and maintaining this backlog does not itself run collection, change settings, schedule work, or authorize a deployment.

Planning and tracking for this work live in these files. Do not use Jira. The USG identifiers are local backlog IDs, not Linear issue IDs. If the user later chooses Linear, carry these scopes and acceptance criteria across and record the mapping rather than creating duplicate sources of truth.

The [direction document](../usage-direction.md) defines the intended experience. The [current-system audit](../usage-system.md) is dated evidence of working and missing collection. Recheck that evidence during implementation; these tasks do not claim a fresh production audit.

## Delivery scope

Core work fixes the supported local collection, preserves/reconciles history, replaces the active browser quota bridge, and delivers Tokens, Allowances, and global Settings. Environmental impact is required, using the current methodology first, with researched actionable recommendations.

Follow-ups explicitly capture the missing Cursor, account-reader, organization-API, cloud/browser, and environmental-method capabilities. They remain unfinished backlog work, but do not gate the supported-source UI release. A setting or source discovery must never imply one of those collectors already works. If the desired release scope expands to require a provider, promote its task into the core release gate.

USG-034 is conditional because the optional compensation-dollar choice has not been answered. Physical estimates and concrete recommendations remain in the core release regardless of that choice.

The broad settings redesign, automatic offset purchases, personal compensation transaction history, new report exports, and changes to unrelated report areas are outside these tasks.

## Recommended sequence

1. Start with [USG-001](usg-001-metric-and-source-contract.md) and [USG-002](usg-002-preserve-history-and-recover-publication.md): establish meanings, source precedence, recoverability, and the known collection gaps.
2. Extend the contract, then implement missing local request, agent, tool, project, resource, and allowance facts. Make settings and health truthful.
3. Reconcile historical records and build shared queries/calculations. Research the environmental action destinations without replacing the footprint method.
4. Build global navigation/settings, shared chart/filter controls, and all requested Tokens/Allowances sections.
5. Complete [USG-025](usg-025-activate-backfill-and-verify-release.md) to prove source-to-screen collection and the release; only then finish [USG-026](usg-026-retire-redundant-usage-pipelines.md) retirement.
6. Advance the explicitly tracked additional-source and methodology work as their source/access prerequisites are established.

Task numbers are stable identifiers. The dependency links, rather than numerical order alone, determine what can be completed next. Interface scaffolding can be developed earlier, but unfinished pages must not replace functioning production navigation.

## Tracking and common completion requirements

Use Planned, In progress, Blocked, Done, or Cancelled in the task file. Decision pending is reserved for the optional choice. Update this index when a task changes state; record evidence and any remaining dependency in the task's Execution record. Priorities are suggested: P0 is a core data/cutover prerequisite, P1 is required delivery, P2 is follow-up coverage/research, and P3 is optional.

A task is Done only when its acceptance criteria and relevant verification are satisfied. An inaccessible host, unavailable source, coverage-only receipt, or unimplemented API option is not evidence of a completed collector. Record a concrete blocker or an explicit reviewed scope decision.

Every implementation task inherits these requirements:

- Read the repository instructions and the applicable operating guides before editing. Follow fixture hygiene and repository attribution conventions. These local IDs do not pretend to satisfy a future Linear-specific PR convention; resolve any necessary tracking mapping when that workflow is actually used.
- Preserve existing unrelated working-tree changes. The reset-feed files already have concurrent work; reconcile it before touching them.
- Keep full traces, credentials, raw vault content, and private paths out of committed fixtures and reports. Use synthetic/sanitized examples with provenance.
- Preserve source identities, original observation times, append-only history, idempotency, canonical deduplication, and unknown values. Tokens, allowances, actual money, and derived estimates remain distinct.
- Preserve private access boundaries, limited database grants, same-origin browser mutations, and the serialized database queue. Use focused meaningful verification and the required checks for the eventual change.
- Update capability/operation documentation when collection behavior changes. Keep inspected source state separate from successful production receipts.
- Reuse environmental methodology 2026-08-20.1 for the core release; [USG-033](usg-033-environmental-methodology-research.md) owns improved modeling.
- Follow the [retirement runbook](../usage-v1-retirement.md) before removing any current or historical dependency.

## 1. Foundations

| Task | Priority | Depends on | Status |
| --- | --- | --- | --- |
| [USG-001: Define metric semantics, source precedence, and remaining display decisions](usg-001-metric-and-source-contract.md) | P0 | None | Done |
| [USG-002: Preserve usage history and recover missing current collection evidence](usg-002-preserve-history-and-recover-publication.md) | P0 | None | In progress |
| [USG-003: Extend the usage contract and storage for the missing attribution detail](usg-003-extend-detail-contract-and-storage.md) | P0 | [USG-001](usg-001-metric-and-source-contract.md) | Planned |

## 2. Collection

| Task | Priority | Depends on | Status |
| --- | --- | --- | --- |
| [USG-004: Collect request detail and pricing evidence from supported local histories](usg-004-collect-request-and-pricing-evidence.md) | P0 | [USG-003](usg-003-extend-detail-contract-and-storage.md) | Planned |
| [USG-005: Collect distinct subagents, parent relationships, roles, and token attribution](usg-005-collect-agent-lineage.md) | P0 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md) | Planned |
| [USG-006: Collect tool invocations, callers, and outcomes without duplicate counting](usg-006-collect-tool-invocations.md) | P0 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md) | Planned |
| [USG-007: Collect and map project identities across machines and worktrees](usg-007-map-project-identities.md) | P0 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md) | Planned |
| [USG-008: Identify access to multiple vaults and configured knowledge sources](usg-008-collect-knowledge-source-access.md) | P0 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-006](usg-006-collect-tool-invocations.md), [USG-007](usg-007-map-project-identities.md) | Planned |
| [USG-009: Fix account attribution and freshness for existing allowance collection](usg-009-fix-allowance-identity-and-freshness.md) | P0 | [USG-001](usg-001-metric-and-source-contract.md) | Planned |
| [USG-010: Build and verify the v2 replacement for the active browser quota bridge](usg-010-replace-browser-quota-bridge.md) | P1 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md) | Planned |
| [USG-014: Make collection settings, cadence, and health reflect actual capabilities](usg-014-truthful-settings-and-collection-health.md) | P1 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md) | Planned |

## 3. Read models

| Task | Priority | Depends on | Status |
| --- | --- | --- | --- |
| [USG-011: Reconcile historical usage and preserve history when sources are disabled](usg-011-reconcile-historical-ledgers.md) | P0 | [USG-002](usg-002-preserve-history-and-recover-publication.md), [USG-003](usg-003-extend-detail-contract-and-storage.md) | Planned |
| [USG-012: Build one filtered usage query layer with explicit coverage](usg-012-unified-filtered-usage-queries.md) | P0 | [USG-004](usg-004-collect-request-and-pricing-evidence.md), [USG-005](usg-005-collect-agent-lineage.md), [USG-006](usg-006-collect-tool-invocations.md), [USG-007](usg-007-map-project-identities.md), [USG-008](usg-008-collect-knowledge-source-access.md), [USG-011](usg-011-reconcile-historical-ledgers.md) | Planned |
| [USG-013: Reuse pricing and environmental calculations on the unified data](usg-013-reuse-cost-and-environment-calculations.md) | P0 | [USG-001](usg-001-metric-and-source-contract.md), [USG-012](usg-012-unified-filtered-usage-queries.md) | Planned |
| [USG-019: Research concrete environmental reduction and compensation recommendations](usg-019-environmental-action-recommendations.md) | P1 | [USG-001](usg-001-metric-and-source-contract.md) | Planned |

## 4. Interface

| Task | Priority | Depends on | Status |
| --- | --- | --- | --- |
| [USG-015: Move configuration into global Settings and establish two Usage subtabs](usg-015-global-settings-and-navigation.md) | P1 | [USG-007](usg-007-map-project-identities.md), [USG-008](usg-008-collect-knowledge-source-access.md), [USG-014](usg-014-truthful-settings-and-collection-health.md) | Planned |
| [USG-016: Build shared filters, chart interactions, and table preferences](usg-016-shared-filters-and-interactive-charts.md) | P1 | [USG-001](usg-001-metric-and-source-contract.md) | Planned |
| [USG-017: Build the Tokens overview, composition bar, and activity chart](usg-017-tokens-overview-and-daily-volume.md) | P1 | [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-015](usg-015-global-settings-and-navigation.md), [USG-016](usg-016-shared-filters-and-interactive-charts.md) | Planned |
| [USG-018: Add interactive API-cost and tokens-by-model cards](usg-018-cost-and-model-cards.md) | P1 | [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md) | Planned |
| [USG-020: Build environmental impact using existing estimates and actionable recommendations](usg-020-environmental-impact-section.md) | P1 | [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md), [USG-019](usg-019-environmental-action-recommendations.md) | Planned |
| [USG-021: Build project and agent breakdown cards with drill-down](usg-021-project-and-agent-breakdowns.md) | P1 | [USG-005](usg-005-collect-agent-lineage.md), [USG-007](usg-007-map-project-identities.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md) | Planned |
| [USG-022: Build tool-call summaries and the multi-source knowledge breakdown](usg-022-tool-and-knowledge-cards.md) | P1 | [USG-006](usg-006-collect-tool-invocations.md), [USG-008](usg-008-collect-knowledge-source-access.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md) | Planned |
| [USG-023: Build account allowance accordions with per-window burn charts](usg-023-allowance-account-accordions.md) | P1 | [USG-009](usg-009-fix-allowance-identity-and-freshness.md), [USG-011](usg-011-reconcile-historical-ledgers.md), [USG-015](usg-015-global-settings-and-navigation.md), [USG-016](usg-016-shared-filters-and-interactive-charts.md) | Planned |
| [USG-024: Place reset calendar and feed beneath the account allowances](usg-024-reset-calendar-and-feed-relocation.md) | P1 | [USG-015](usg-015-global-settings-and-navigation.md), [USG-023](usg-023-allowance-account-accordions.md) | Planned |

## 5. Cutover

| Task | Priority | Depends on | Status |
| --- | --- | --- | --- |
| [USG-025: Activate supported detail, backfill retained data, and verify the complete release](usg-025-activate-backfill-and-verify-release.md) | P0 | [USG-010](usg-010-replace-browser-quota-bridge.md), [USG-011](usg-011-reconcile-historical-ledgers.md), [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-014](usg-014-truthful-settings-and-collection-health.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md), [USG-018](usg-018-cost-and-model-cards.md), [USG-020](usg-020-environmental-impact-section.md), [USG-021](usg-021-project-and-agent-breakdowns.md), [USG-022](usg-022-tool-and-knowledge-cards.md), [USG-024](usg-024-reset-calendar-and-feed-relocation.md) | Planned |
| [USG-026: Retire superseded usage publishers, collectors, and schedules after parity](usg-026-retire-redundant-usage-pipelines.md) | P1 | [USG-002](usg-002-preserve-history-and-recover-publication.md), [USG-010](usg-010-replace-browser-quota-bridge.md), [USG-011](usg-011-reconcile-historical-ledgers.md), [USG-025](usg-025-activate-backfill-and-verify-release.md) | Planned |

## 6. Provider coverage

| Task | Priority | Depends on | Status |
| --- | --- | --- | --- |
| [USG-027: Implement Cursor usage collection from validated source evidence](usg-027-cursor-usage-collection.md) | P2 | [USG-001](usg-001-metric-and-source-contract.md), [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-014](usg-014-truthful-settings-and-collection-health.md) | Planned |
| [USG-028: Implement the Codex account allowance reader](usg-028-account-allowance-reader.md) | P2 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md), [USG-014](usg-014-truthful-settings-and-collection-health.md) | Planned |
| [USG-029: Implement the Claude account allowance reader](usg-029-additional-account-allowance-reader.md) | P2 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md), [USG-014](usg-014-truthful-settings-and-collection-health.md) | Planned |
| [USG-030: Implement OpenAI organization usage and cost collection](usg-030-organization-usage-and-cost-reader.md) | P2 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-014](usg-014-truthful-settings-and-collection-health.md) | Planned |
| [USG-031: Implement Anthropic organization usage and cost collection](usg-031-additional-organization-usage-and-cost-reader.md) | P2 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-014](usg-014-truthful-settings-and-collection-health.md) | Planned |
| [USG-032: Assess and scope missing cloud and browser activity sources](usg-032-cloud-and-browser-token-coverage.md) | P2 | [USG-001](usg-001-metric-and-source-contract.md), [USG-003](usg-003-extend-detail-contract-and-storage.md) | Planned |

## 7. Later environmental work

| Task | Priority | Depends on | Status |
| --- | --- | --- | --- |
| [USG-033: Improve environmental estimation after the current method is preserved](usg-033-environmental-methodology-research.md) | P2 | [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-019](usg-019-environmental-action-recommendations.md), [USG-020](usg-020-environmental-impact-section.md) | Planned |

## 8. Optional environmental work

| Task | Priority | Depends on | Status |
| --- | --- | --- | --- |
| [USG-034: Add an optional environmental compensation budget if selected](usg-034-optional-compensation-budget.md) | P3 | [USG-019](usg-019-environmental-action-recommendations.md), [USG-020](usg-020-environmental-impact-section.md) | Decision pending |

## Coverage map

| Requested behavior or known gap | Tasks |
| --- | --- |
| Missing Windows detailed publication; retained v1-only history and unknown pending outcomes | [USG-002](usg-002-preserve-history-and-recover-publication.md), [USG-011](usg-011-reconcile-historical-ledgers.md) |
| Normal collection supplies report detail | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md), [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-025](usg-025-activate-backfill-and-verify-release.md), [USG-026](usg-026-retire-redundant-usage-pipelines.md) |
| Pricing effort/tier/context evidence | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md), [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-018](usg-018-cost-and-model-cards.md) |
| Distinct agents, lineage, role, and token share | [USG-005](usg-005-collect-agent-lineage.md), [USG-021](usg-021-project-and-agent-breakdowns.md) |
| Tool calls, outcomes, callers, and deduplication | [USG-006](usg-006-collect-tool-invocations.md), [USG-022](usg-022-tool-and-knowledge-cards.md) |
| Project filters, labels, worktrees, and cross-machine identity | [USG-007](usg-007-map-project-identities.md), [USG-015](usg-015-global-settings-and-navigation.md), [USG-021](usg-021-project-and-agent-breakdowns.md) |
| Several vaults/knowledge sources and supported access evidence | [USG-008](usg-008-collect-knowledge-source-access.md), [USG-015](usg-015-global-settings-and-navigation.md), [USG-022](usg-022-tool-and-knowledge-cards.md) |
| Wrong/ambiguous allowance account identity and stale readings | [USG-009](usg-009-fix-allowance-identity-and-freshness.md), [USG-014](usg-014-truthful-settings-and-collection-health.md), [USG-023](usg-023-allowance-account-accordions.md) |
| Browser pairing with no working v2 replacement | [USG-010](usg-010-replace-browser-quota-bridge.md) |
| Disabled-source allowance history hidden from charts | [USG-011](usg-011-reconcile-historical-ledgers.md) |
| Ineffective cadence changes, unsupported reader switches, false healthy status | [USG-014](usg-014-truthful-settings-and-collection-health.md) |
| Two subtabs, global Settings, and old links | [USG-015](usg-015-global-settings-and-navigation.md) |
| Shared filters, hover, minimal axes, table/graph switching, legend toggles | [USG-016](usg-016-shared-filters-and-interactive-charts.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md), [USG-018](usg-018-cost-and-model-cards.md) |
| Total tokens, composition, daily activity | [USG-017](usg-017-tokens-overview-and-daily-volume.md) |
| Environmental electricity/water/carbon estimates and current method reuse | [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-020](usg-020-environmental-impact-section.md) |
| Concrete reduction/compensation recommendations | [USG-019](usg-019-environmental-action-recommendations.md), [USG-020](usg-020-environmental-impact-section.md) |
| Account accordions, side-by-side windows, hidden Spark, burn/cycle history | [USG-023](usg-023-allowance-account-accordions.md) |
| Reset calendar/feed relocation and settings diagnostics | [USG-024](usg-024-reset-calendar-and-feed-relocation.md) |
| End-to-end activation, scheduled evidence, backfill, and safe retirement | [USG-025](usg-025-activate-backfill-and-verify-release.md), [USG-026](usg-026-retire-redundant-usage-pipelines.md) |
| Cursor readers | [USG-027](usg-027-cursor-usage-collection.md) |
| Account allowance-reader stubs | [USG-028](usg-028-account-allowance-reader.md), [USG-029](usg-029-additional-account-allowance-reader.md) |
| Organization API usage/cost-reader stubs | [USG-030](usg-030-organization-usage-and-cost-reader.md), [USG-031](usg-031-additional-organization-usage-and-cost-reader.md) |
| Missing cloud/browser token sources | [USG-032](usg-032-cloud-and-browser-token-coverage.md) |
| Better future environmental methodology | [USG-033](usg-033-environmental-methodology-research.md) |
| Optional estimated compensation dollars | [USG-034](usg-034-optional-compensation-budget.md) |

The placeholder live `serve` mode is not needed for scheduled collection and remains visibly unsupported under USG-014; a continuously streaming service is outside this release. Other unselected reader alternatives remain unsupported until backed by verified source work.

## Review points and release gates

- [USG-001](usg-001-metric-and-source-contract.md) records outstanding display defaults and metric/classification choices; it is not a request to reapprove settled requirements.
- [USG-007](usg-007-map-project-identities.md) and [USG-008](usg-008-collect-knowledge-source-access.md) define the minimum usable configuration; [USG-015](usg-015-global-settings-and-navigation.md) surfaces it without requiring a complete settings redesign.
- [USG-019](usg-019-environmental-action-recommendations.md) selects and verifies environmental programs; recommendations are not replaced by generic offset claims.
- [USG-034](usg-034-optional-compensation-budget.md) alone waits for the optional dollar-budget choice.
- Core release evidence is recorded in [USG-025](usg-025-activate-backfill-and-verify-release.md); the full transition is unfinished until [USG-026](usg-026-retire-redundant-usage-pipelines.md) passes.
- Additional-provider limitations are documented rather than silently counted as complete.

## Execution record

USG-001 was completed in the filesystem with the shared metric/source contract and domain glossary. No runtime implementation, external issues, app tasks, automations, commits, or pull requests were created by preparing or beginning this backlog.
