# Repository migration record

Date: 2026-09-10. Source working-tree import into `joshgreenwell/ai-kits/kit-board`.

Source base: `74abf3ed8db78edb3b6d12b4cdba03ef2a25d6b1`. Destination base: `bfb867ed03ad1b791862ec95390b9ff78775fb9a`. The source inventory contained **145 tracked/untracked nonignored files**. This import includes the source’s uncommitted routing API, schemas, migration, tests and package changes; those are not represented as previously deployed work.

**137 files match the captured source SHA-256 exactly; 7 differ; 1 omitted.** The entire source Git history and ignored private runtime remain in the operator’s separate local recovery archive, not public repository history.

## Adjusted source files

| File | Reason |
| --- | --- |
| `.env.example` | Portable localhost origin, explicit credential shapes and optional cron/legacy variables. |
| `README.md` | New checkout root and recovery/provenance links. |
| `docs/agent-handoff.md` | Relocated root, historical-status qualification, deployment-cutover instructions, private identifier removal. |
| `docs/architecture.md` | Relocated application ownership path; historical deployment IDs omitted. |
| `docs/schedules.md` | Private source/receipt/cloud-task/deployment identifiers omitted; historical behavior retained. |
| `lib/generated/collector-bundles.json` | Rebuilt during the move for source parity; removed on 2026-09-13 when v1 distribution was retired. |
| `scripts/build-collector-bundles.py` | Added deterministic ZIP metadata during the move; removed on 2026-09-13 with the retired bundle path. |

## Omitted source files

`CLAUDE.md`: provider-specific instruction artifact, not application implementation or runtime dependency; preserved with original checkout.

## New setup material

- `docs/startup-and-recovery.md`: verified Obsidian paths, application setup, database role/migration prerequisites, external analyzers, schedules, credentials/state locations, publication and hosting cutover.
- This provenance record and `docs/migration-source-inventory.json`: every original file, hash and disposition.
- Repository-root README/CONTRIBUTING entries and `.github/workflows/kit-board.yml`: independent setup and secret-free CI.

## Private and generated exclusions

No `.git`, `.env.local`, `.local`, `.vercel`, `node_modules`, `.next`, caches, outboxes, SQLite state, credentials, vault/brain notes or private report payloads are imported as public source. The tracked generated UI and licensed embedded fonts are retained; the v1 collector bundle was subsequently removed. Runtime names, production URLs, schema, home configuration directories and API contracts remain unchanged. The working application is still independently configured; cloning does not recover private history or external scheduled jobs.

## Verification at the relocated root

Node 22.19.0 `npm ci` succeeded. JavaScript: 46 passed, one database integration test skipped in ordinary suite; all 12 Python collector tests passed. Typecheck and production build succeeded without private environment files or database access. `npm run test:routing:db` passed against its own disposable local PostgreSQL cluster, including all six migrations. Generated collector output was rebuilt; repeated rebuild byte parity verified separately. Canonical routing contract files remain unchanged from the captured source. No deployment, live provider request, model invocation or production database operation was part of these checks.

## Prior architecture context

The proposed v3 direction remains local historical planning context at `/Users/joshgreenwell/github/luumen-workspace/docs/personal-observatory-architecture-handoff-v3-2026-09-10.md`. This migration implements directory ownership only: Usage first, host receives externally executed workflows, no upfront kit framework. It does not implement or approve the remainder of that roadmap.
