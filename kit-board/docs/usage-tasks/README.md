# Usage collection and interface tasks

Created: 2026-09-13

**34 filesystem tasks: 26 core delivery tasks, seven follow-ups, and one optional task awaiting a decision.** Twenty-one are Done, three are In progress, nine are Planned, and one waits on a decision. The [release status](#release-status) below states what is finished and what still stands between here and the release; the per-stage tables carry the authoritative status for each task. Creating and maintaining this backlog does not itself run collection, change settings, schedule work, or authorize a deployment.

Planning and tracking for this work live in these files. Do not use Jira. The USG identifiers are local backlog IDs, not Linear issue IDs. If the user later chooses Linear, carry these scopes and acceptance criteria across and record the mapping rather than creating duplicate sources of truth.

The [direction document](../usage-direction.md) defines the intended experience. The [current-system audit](../usage-system.md) is dated evidence of working and missing collection. Recheck that evidence during implementation; these tasks do not claim a fresh production audit.

## Release status

Updated 2026-09-16, after the Tokens and Allowances interface work merged to `main`, deployed to production, and both pending migrations were applied.

### Done (21)

Foundations and collection: [USG-001](usg-001-metric-and-source-contract.md), [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md), [USG-005](usg-005-collect-agent-lineage.md), [USG-006](usg-006-collect-tool-invocations.md), [USG-007](usg-007-map-project-identities.md), [USG-008](usg-008-collect-knowledge-source-access.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md), [USG-014](usg-014-truthful-settings-and-collection-health.md).

Read models: [USG-011](usg-011-reconcile-historical-ledgers.md), [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-019](usg-019-environmental-action-recommendations.md).

Interface: [USG-015](usg-015-global-settings-and-navigation.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md), [USG-018](usg-018-cost-and-model-cards.md), [USG-020](usg-020-environmental-impact-section.md), [USG-021](usg-021-project-and-agent-breakdowns.md), [USG-022](usg-022-tool-and-knowledge-cards.md), [USG-023](usg-023-allowance-account-accordions.md), [USG-024](usg-024-reset-calendar-and-feed-relocation.md).

Done here means the acceptance criteria are met in the repository and verified locally. The September 16 merge to `main` carried all of it except USG-021 and USG-022, committed later that day, to production and the two migrations behind it were applied the same day; [USG-025](usg-025-activate-backfill-and-verify-release.md) still owns source-to-screen verification against production.

### In progress (3)

- [USG-002](usg-002-preserve-history-and-recover-publication.md) — unattended Windows publication is verified; the inaccessible-host inventory and production-wide reconciliation are open.
- [USG-016](usg-016-shared-filters-and-interactive-charts.md) — the filter bar, interval charts, legend toggles, persisted graph/table preferences, and design-system alignment shipped through USG-017 and USG-018. What remains is its own verification pass: filter URL round trips, timezone boundaries, touch and keyboard paths, long labels, and narrow screens.
- [USG-025](usg-025-activate-backfill-and-verify-release.md) — the September 16 merge deployed the server build to production and both migrations are applied. Everything else this task owns is open: the detail-level change at the source, backfill and receipts, scheduled-cycle and source-to-screen verification, and the release record.

### Left before the release gate (4 core)

| Task | What it blocks | Note |
| --- | --- | --- |
| [USG-010](usg-010-replace-browser-quota-bridge.md) | Claude allowance readings | Every Claude allowance row still comes from the legacy v1 browser extension, which emits `five_hour` and `seven_day` only. No companion-produced Claude reading exists, so model-scoped weekly windows never arrive for Claude. Codex already produces them through the embedded reader. |
| [USG-016](usg-016-shared-filters-and-interactive-charts.md) | Nothing further | Implementation shipped; verification remains. |
| [USG-025](usg-025-activate-backfill-and-verify-release.md) | The release itself | The migrations are applied; the detail-level change and source-to-screen verification remain. Until `execution.detail_level` leaves `buckets_only` and `project_attribution` is on, the delivered project, agent, tool, and knowledge cards show their empty states in production. See the deployment prerequisites below. |
| [USG-026](usg-026-retire-redundant-usage-pipelines.md) | v1 retirement | Gated on USG-025 parity. |

### Deployment prerequisites owned by USG-025

Neither is a code change. The first is now done:

1. **Both migrations are applied to production.** Done on September 16 with `supabase db push --linked`, after the merge to `main` deployed the server build that reads them: `20260914030000_reconcile_historical_ledgers.sql` (USG-011: `token_bucket_canonical`, and `allowance_percent_view` carrying `history_only`) and `20260914040000_usage_report_subjects.sql` (USG-012: the monthly report-subject crosswalk). That order was safe because `lib/telemetry-store.ts` and `lib/usage-query.ts` catch SQLSTATE `42P01` and `42703` and fall back; those fallbacks stay for the next such window. `supabase migration list --linked` shows local and remote matching through `20260914040000`, and a post-apply read as `personal_hub_app` returned `token_bucket_canonical` and `allowance_percent_view.history_only` rows and accepted a rolled-back `usage_report_subjects` insert. Disabled-producer history is visible again, monthly snapshots can merge, and mapping a report subject in Settings no longer errors.
2. **Request detail is off at the source.** Both companions run `execution.detail_level: "buckets_only"` at settings version 4 while advertising `requests` and `requests_with_tools`, so `personal_hub.activity_requests` is empty across all recorded history. Cost, reasoning effort, service tier, surface, project, agent, and tool surfaces stay empty until the setting changes, and only from the next run forward — the retained monthly reports hold a precomputed `api_equivalent_estimate` rollup, not per-request rows, so there is nothing per-request to backfill.

### Follow-ups, not release gates (7 + 1 optional)

[USG-027](usg-027-cursor-usage-collection.md), [USG-028](usg-028-account-allowance-reader.md), [USG-029](usg-029-additional-account-allowance-reader.md), [USG-030](usg-030-organization-usage-and-cost-reader.md), [USG-031](usg-031-additional-organization-usage-and-cost-reader.md), [USG-032](usg-032-cloud-and-browser-token-coverage.md), [USG-033](usg-033-environmental-methodology-research.md) remain Planned; [USG-034](usg-034-optional-compensation-budget.md) waits on the optional compensation-dollar decision. A setting that names one of these readers must never imply it collects: `oauth_usage`, `app_server`, `web_backend`, and both Cursor readers are stubs reporting `not_implemented`.


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
| [USG-003: Extend the usage contract and storage for the missing attribution detail](usg-003-extend-detail-contract-and-storage.md) | P0 | [USG-001](usg-001-metric-and-source-contract.md) | Done |

## 2. Collection

| Task | Priority | Depends on | Status |
| --- | --- | --- | --- |
| [USG-004: Collect request detail and pricing evidence from supported local histories](usg-004-collect-request-and-pricing-evidence.md) | P0 | [USG-003](usg-003-extend-detail-contract-and-storage.md) | Done |
| [USG-005: Collect distinct subagents, parent relationships, roles, and token attribution](usg-005-collect-agent-lineage.md) | P0 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md) | Done |
| [USG-006: Collect tool invocations, callers, and outcomes without duplicate counting](usg-006-collect-tool-invocations.md) | P0 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md) | Done |
| [USG-007: Collect and map project identities across machines and worktrees](usg-007-map-project-identities.md) | P0 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md) | Done |
| [USG-008: Identify access to multiple vaults and configured knowledge sources](usg-008-collect-knowledge-source-access.md) | P0 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-006](usg-006-collect-tool-invocations.md), [USG-007](usg-007-map-project-identities.md) | Done |
| [USG-009: Fix account attribution and freshness for existing allowance collection](usg-009-fix-allowance-identity-and-freshness.md) | P0 | [USG-001](usg-001-metric-and-source-contract.md) | Done |
| [USG-010: Build and verify the v2 replacement for the active browser quota bridge](usg-010-replace-browser-quota-bridge.md) | P1 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md) | Planned |
| [USG-014: Make collection settings, cadence, and health reflect actual capabilities](usg-014-truthful-settings-and-collection-health.md) | P1 | [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md) | Done |

## 3. Read models

| Task | Priority | Depends on | Status |
| --- | --- | --- | --- |
| [USG-011: Reconcile historical usage and preserve history when sources are disabled](usg-011-reconcile-historical-ledgers.md) | P0 | [USG-002](usg-002-preserve-history-and-recover-publication.md), [USG-003](usg-003-extend-detail-contract-and-storage.md) | Done |
| [USG-012: Build one filtered usage query layer with explicit coverage](usg-012-unified-filtered-usage-queries.md) | P0 | [USG-004](usg-004-collect-request-and-pricing-evidence.md), [USG-005](usg-005-collect-agent-lineage.md), [USG-006](usg-006-collect-tool-invocations.md), [USG-007](usg-007-map-project-identities.md), [USG-008](usg-008-collect-knowledge-source-access.md), [USG-011](usg-011-reconcile-historical-ledgers.md) | Done |
| [USG-013: Reuse pricing and environmental calculations on the unified data](usg-013-reuse-cost-and-environment-calculations.md) | P0 | [USG-001](usg-001-metric-and-source-contract.md), [USG-012](usg-012-unified-filtered-usage-queries.md) | Done |
| [USG-019: Research concrete environmental reduction and compensation recommendations](usg-019-environmental-action-recommendations.md) | P1 | [USG-001](usg-001-metric-and-source-contract.md) | Done |

## 4. Interface

| Task | Priority | Depends on | Status |
| --- | --- | --- | --- |
| [USG-015: Move configuration into global Settings and establish two Usage subtabs](usg-015-global-settings-and-navigation.md) | P1 | [USG-007](usg-007-map-project-identities.md), [USG-008](usg-008-collect-knowledge-source-access.md), [USG-014](usg-014-truthful-settings-and-collection-health.md) | Done |
| [USG-016: Build shared filters, chart interactions, and table preferences](usg-016-shared-filters-and-interactive-charts.md) | P1 | [USG-001](usg-001-metric-and-source-contract.md) | In progress |
| [USG-017: Build the Tokens overview, composition bar, and activity chart](usg-017-tokens-overview-and-daily-volume.md) | P1 | [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-015](usg-015-global-settings-and-navigation.md), [USG-016](usg-016-shared-filters-and-interactive-charts.md) | Done |
| [USG-018: Add interactive API-cost and tokens-by-model cards](usg-018-cost-and-model-cards.md) | P1 | [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md) | Done |
| [USG-020: Build environmental impact using existing estimates and actionable recommendations](usg-020-environmental-impact-section.md) | P1 | [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md), [USG-019](usg-019-environmental-action-recommendations.md) | Done |
| [USG-021: Build project and agent breakdown cards with drill-down](usg-021-project-and-agent-breakdowns.md) | P1 | [USG-005](usg-005-collect-agent-lineage.md), [USG-007](usg-007-map-project-identities.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md) | Done |
| [USG-022: Build tool-call summaries and the multi-source knowledge breakdown](usg-022-tool-and-knowledge-cards.md) | P1 | [USG-006](usg-006-collect-tool-invocations.md), [USG-008](usg-008-collect-knowledge-source-access.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md) | Done |
| [USG-023: Build account allowance accordions with per-window burn charts](usg-023-allowance-account-accordions.md) | P1 | [USG-009](usg-009-fix-allowance-identity-and-freshness.md), [USG-011](usg-011-reconcile-historical-ledgers.md), [USG-015](usg-015-global-settings-and-navigation.md), [USG-016](usg-016-shared-filters-and-interactive-charts.md) | Done |
| [USG-024: Place reset calendar and feed beneath the account allowances](usg-024-reset-calendar-and-feed-relocation.md) | P1 | [USG-015](usg-015-global-settings-and-navigation.md), [USG-023](usg-023-allowance-account-accordions.md) | Done |

## 5. Cutover

| Task | Priority | Depends on | Status |
| --- | --- | --- | --- |
| [USG-025: Activate supported detail, backfill retained data, and verify the complete release](usg-025-activate-backfill-and-verify-release.md) | P0 | [USG-010](usg-010-replace-browser-quota-bridge.md), [USG-011](usg-011-reconcile-historical-ledgers.md), [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-014](usg-014-truthful-settings-and-collection-health.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md), [USG-018](usg-018-cost-and-model-cards.md), [USG-020](usg-020-environmental-impact-section.md), [USG-021](usg-021-project-and-agent-breakdowns.md), [USG-022](usg-022-tool-and-knowledge-cards.md), [USG-024](usg-024-reset-calendar-and-feed-relocation.md) | In progress |
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

USG-001 was completed in the filesystem with the shared metric/source contract and domain glossary. USG-003 completed the compatible envelope-v2 detail contract, cross-language fixtures, append-only storage migration, and server ingestion boundary; its collectors and production activation remain in their dependent stories. USG-002 has verified unattended Windows publication and remains open for the inaccessible-host inventory and production-wide reconciliation. USG-008 added locally configured knowledge sources, privacy-safe access classification for supported Claude and Codex tool calls, and the server registry and naming/mapping route; its UI, and any production activation, remain in dependent stories. USG-009 moved the Claude statusline allowance reader into the `claude_account` adapter, gave every sample an identity stamp so a reading binds to the account that produced it or is quarantined instead of assigned to the first binding, added the `allowance` capability dimension, preserved the readings' `basis`, and put one freshness rule and one selection rule behind every allowance surface; its deployment, and fresh production readings, belong to USG-025. USG-011 made history a canonical read: `allowance_percent_view` keeps disabled producers' rows as `history_only`, the outlook never selects one as current, an exact v1/v2 copy of one observation shows once, `lib/usage-reconciliation.ts` reports the before/after matrix and dry-runs a retired collector's pending envelope, and the production evidence found 3.95 billion tokens on v1-only keys, 219 of 251 hidden samples duplicated by the companion, and nothing new in either Windows outbox. USG-012 built the one filtered read behind the Tokens cards, `GET /api/usage-query` over `lib/usage-query.ts`: local half-open ranges, OR-within and AND-across filters with explicit Unknown, buckets as the headline with request detail narrowing only what it covers and disclosing the rest, monthly snapshots merged only through the new `usage_report_subjects` crosswalk where the hourly ledger has nothing, and every section with its coverage denominators. USG-013 reused both calculations on that layer: `lib/usage-pricing.ts` prices the filtered request detail with the analyzer's catalog rules (OpenAI catalog verbatim, Anthropic list prices beside it) and keeps unpriced tokens visible with their reason, and `lib/environmental-estimate.ts` applies method 2026-08-20.1 per account-and-month cohort, classified once from the whole month and summed under that class through any filter, carrying stored legacy estimates under their own version. USG-017 replaced the Tokens scaffold with the filtered overview on `GET /api/usage-query`: the filter bar with private URL state, the total and exclusive composition, tokens over time with exact interval details and coverage states, and the coverage card; it delivered the filter-bar and interval-chart part of USG-016, which still owns legend toggles and persisted graph/table preferences. USG-023 replaced the per-window allowance cards with one expandable card per account on `/usage/allowances`: every window side by side in the header (remaining, reset countdown, outlook state, its own observation time), expansion showing each window's normalized burn history with other cycles faint, the projection, the even-pace guide, reset and forecast-start markers, and the forecast explanation; the current reading is always the newest live reading of its window, the persisted history range changes only the charts, Spark starts hidden, several accounts stay open as remembered, and only the account and provider selection carries from Tokens. USG-018 and USG-020 added the API-equivalent cost card, the tokens-by-model card, and the environmental impact section on the same filtered read, each card keeping its own graph/table preference and naming its coverage denominators; USG-024 moved the reset calendar and record under the account cards with `/usage/resets` redirecting to the anchor, and feed diagnostics staying in Settings. A September 16 pass brought those surfaces back onto the existing design system after they had drifted: controls must carry the `data-slot` that `app/theme.css` dresses, because copying a primitive's utility classes reproduces none of it. That pass closed criterion 5 of USG-016, which is now In progress with only its verification outstanding. USG-021 and USG-022 completed the Tokens card order on September 16 in `components/usage-breakdown-cards.tsx`: the Projects and Agents cards side by side after the environmental section, each row a reversible drill-down through the common filter state (project id or state code, agent key, main/subagent scope) with agent chips named from the result; and the final Tool calls and knowledge sources card, keeping tool invocations, model calls, and agent spawns as three separate counts, showing outcomes only where collected, and listing one knowledge-source row per configured, unassigned, or unknown source with overlapping access counts labeled and the unduplicated tool-call total kept apart from the global one. Both cards render their empty states against production until USG-025 changes the detail level at the source. No external issue tracker is used.
