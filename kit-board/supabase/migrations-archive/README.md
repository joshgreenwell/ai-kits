# Archived migrations

These seventeen files are the migration history of the `personal_hub` schema, from the first
report table on September 8, 2026 to the request-ledger revision key on September 21, 2026.
They were squashed on **September 22, 2026** and moved here verbatim; nothing in them was
edited on the way.

**The production database was built by running these seventeen in sequence.** That is the
only history it has, and these files are the record of it. They are kept so the reasoning
behind a column, a constraint or a backfill stays readable, and so the upgrade path can be
replayed against a copy of production if one is ever needed.

**Any new database gets `../migrations/00000000000000_baseline.sql` instead.** That single
file recreates the state these seventeen leave behind: schema, role guard, tables, generated
columns, constraints, indexes, views, RLS, policies, grants and the one seeded
`collection_settings` row. It was derived from these files, not written from them — all
seventeen were applied to a throwaway PostgreSQL 17 database and the result was dumped — and
a database built from the baseline alone produces a `pg_dump --schema-only --no-owner` that
is byte-identical to one built from this sequence.

Never apply the baseline to a database that already ran these files, and never apply these
files to a database that started from the baseline.

## The sequence

| File | What it added |
| --- | --- |
| `20260908050538_personal_hub_report_history.sql` | The `personal_hub` schema, `report_revisions`, `login_limits`, RLS |
| `20260908051221_personal_hub_app_role.sql` | The `personal_hub_app` login role and its first grants and policies |
| `20260908052915_report_assets.sql` | `report_assets` for audit evidence files |
| `20260909184129_usage_telemetry_and_reset_feeds.sql` | v1 telemetry: accounts, sources, token buckets, quota samples, reset feeds |
| `20260909200659_cloud_usage_calibrations.sql` | `usage_calibrations` |
| `20260910193058_agent_routing_events.sql` | `agent_routing_events` |
| `20260912230000_unified_usage.sql` | Envelope v2: collection settings, companion installs/pairing/bindings/runs, the first four ledgers, `allowance_percent_view` |
| `20260913230451_extend_usage_detail_contract.sql` | USG-003 detail fields, token accounting states, `agent_events`, `tool_events`, `resource_accesses` |
| `20260913235900_project_registry.sql` | Project identities, labels, mapping revisions, `activity_request_project_resolution` |
| `20260914003000_knowledge_source_registry.sql` | Knowledge-source identities, labels, mapping revisions, `resource_access_source_resolution` |
| `20260914010000_allowance_basis_and_run_counts.sql` | `allowance_readings.basis`, `companion_runs.accepted_by_type`, the two binding-recent indexes |
| `20260914020000_companion_capabilities.sql` | Capability reports on `companion_installs` |
| `20260914030000_reconcile_historical_ledgers.sql` | USG-011: `token_bucket_canonical`, `allowance_percent_view` with `history_only` |
| `20260914040000_usage_report_subjects.sql` | USG-012: the monthly report subject crosswalk |
| `20260918090000_usage_query_read_indexes.sql` | Tokens read-shape indexes |
| `20260919090000_drop_duplicate_agent_events_index.sql` | Drops `agent_events_semantic_time`, a column-for-column duplicate |
| `20260921090000_request_ledger_revision_uniqueness.sql` | Collapses the Cursor `local_db` replay rows and names the request ledger's revision key |

## Replaying them

Three of these files are not pure DDL. `20260913235900`, `20260914003000` and `20260921090000`
transform rows that were already in the ledgers, and `20260913230451` adds a `NOT VALID` check
so the rows production had already accepted survive it. Those transformations are why the
sequence cannot be re-derived from the baseline, and why it is kept.

To replay the sequence, apply every `.sql` file here in lexicographic filename order with
`ON_ERROR_STOP` on. Two things need handling:

- `20260908051221_personal_hub_app_role.sql` issues a bare `CREATE ROLE personal_hub_app`,
  which fails on a cluster that already has the role. Drop the role first or wrap that one
  statement in a `DO` block that swallows `duplicate_object`, the way the baseline does.
- These files `REVOKE ... FROM anon, authenticated`, the two Supabase browser roles. On a
  cluster without them, create both as bare `NOLOGIN` roles first. The baseline does not
  need them; see its header.

`../../scripts/test-db.mjs` applies `../migrations/`, which is now the baseline alone. It still
carries the four fixtures that exercised the upgrade behaviour of the files here, each keyed to
the archived filename it belongs before, so they stay dormant against the baseline and fire
again if this sequence is ever applied through that runner. `tests/usage-migration.integration.test.ts`
and `tests/request-ledger-migration.integration.test.ts` read those fixture rows, and skip
themselves when the fixtures were not seeded.
