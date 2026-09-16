# USG-025: Activate supported detail, backfill retained data, and verify the complete release

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: In progress
Priority: P0
Scope: Core
Stage: 5. Cutover
Dependencies: [USG-010](usg-010-replace-browser-quota-bridge.md), [USG-011](usg-011-reconcile-historical-ledgers.md), [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-014](usg-014-truthful-settings-and-collection-health.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md), [USG-018](usg-018-cost-and-model-cards.md), [USG-020](usg-020-environmental-impact-section.md), [USG-021](usg-021-project-and-agent-breakdowns.md), [USG-022](usg-022-tool-and-knowledge-cards.md), [USG-024](usg-024-reset-calendar-and-feed-relocation.md)
Created: 2026-09-13

## Outcome

Demonstrate that scheduled collection powers every required view using real supported evidence.

## Current gap

A successful build or a coverage-only upload would not prove that the missing data or replacement UI is working.

## Acceptance criteria

1. Roll out compatible collector/server versions using the reviewed settings choices; enable the required request/tool/project/resource detail only on intended bindings while honoring local restrictions.
2. Backfill retained evidence with progress and retry receipts, preserve unrecoverable gaps, and reconcile totals and rich attribution against the baseline and representative previous monthly outputs.
3. Verify a scheduled collection cycle per required accessible machine/provider and the browser replacement, including nonzero relevant record types when activity occurred; document unavailable hosts as unfinished verification.
4. Run authenticated complete-flow checks from source event through ingest/store to filtered token, cost, environmental, project, agent, tool, allowance, and reset displays.
5. Exercise partial/stale/error/unknown states, month rollover, historical windows, navigation, keyboard/touch, responsive layout, and permissions. Run focused tests and the required build/typecheck suite.
6. Record deployment/collector versions, scoped receipts, data parity, residual gaps, and a tested rollback path. Core completion requires all requested sections and honest coverage, not just the new tab names.

## Verification

Produce a sanitized release receipt linked to source/store/UI evidence and a completed direction-document acceptance checklist. Deployment and machine changes occur only in a later authorized implementation run.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [docs/usage-direction.md](<../../docs/usage-direction.md>)
- [docs/startup-and-recovery.md](<../../docs/startup-and-recovery.md>)
- [docs/usage-collection.md](<../../docs/usage-collection.md>)
- [docs/usage-system.md](<../../docs/usage-system.md>)
- [docs/usage-v1-retirement.md](<../../docs/usage-v1-retirement.md>)
- [tests](<../../tests>)

## Execution record

Partly executed on 2026-09-16 from `main`, under the owner's explicit authorization to merge the usage stack, let Vercel deploy production from it, and apply the pending migrations with the Supabase CLI. No collector, machine, or account setting was changed.

Done:

- The usage stack merged into `main` as `8dc9c7a` (`--no-ff`), and Vercel's GitHub integration built and promoted the Production deployment for that commit; its deployment status reads success and the production alias answers with its authenticated redirect. The `kit-board` CI workflow passed on the merge commit.
- Both pending migrations applied with `supabase db push --linked` after that deploy: `20260914030000_reconcile_historical_ledgers.sql` (USG-011) and `20260914040000_usage_report_subjects.sql` (USG-012). `supabase migration list --linked` then showed local and remote matching through `20260914040000`, with none of the version drift the recovery guide warns about.
- Deploy-then-migrate was deliberate, not an accident of ordering: `lib/telemetry-store.ts` and `lib/usage-query.ts` catch SQLSTATE `42P01` and `42703`, so the window between the two served the pre-migration view instead of failing. `PUT /api/usage-report-subjects` was the one path that would have errored in that window, and nothing called it.
- Post-apply validation ran as `personal_hub_app`, the restricted application role, rather than as an administrator: `token_bucket_canonical` and `allowance_percent_view` both read, the view exposed `history_only`, and an `usage_report_subjects` insert succeeded inside a transaction that was then rolled back. The table is empty; no row was written to production.

Remaining: criteria 2 through 6 in full, and the collector half of criterion 1. `execution.detail_level` is still `buckets_only` on both companions with `project_attribution` off, so request, tool, project, and resource evidence is still not produced and cannot be verified end to end; USG-010 still owns the Claude allowance reader. Also open: backfill activation with progress and retry receipts, a scheduled cycle verified per accessible machine and provider, authenticated source-to-screen checks against production rather than local, the partial/stale/error/rollover/navigation/keyboard/touch/responsive pass, and the release receipt with parity, residual gaps, and a tested rollback path.
