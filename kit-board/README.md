# Personal Observatory

Private personal dashboard at https://personal-observatory-jg.vercel.app, hosted on Vercel with Supabase Postgres. It combines AI usage, daily tasks, standup, Claude readings, and Luumen AI audits while retaining each report's internal navigation. Palette and fonts match Token Observatory.

- **[Startup, recovery, external scripts, and Obsidian locations](docs/startup-and-recovery.md)**
- [Migration provenance and exclusions](docs/repository-migration.md)
- [Architecture and data ownership](docs/architecture.md)
- [Schedules, publishers, and migration status](docs/schedules.md)
- [Agent handoff and operating map](docs/agent-handoff.md)
- [Unified usage system architecture (design, non-browser collection)](docs/unified-usage-architecture.md)

Run commands from `ai-kits/kit-board` (the runtime package name and `personal_hub` schema intentionally remain unchanged). Use `npm ci`, configure `.env.local`, then run `npm run dev`. Validate with `npm test`, `npm run typecheck`, and `npm run build`. Node 22 is the deployed runtime. Schema migrations are in `supabase/migrations/`, aligned with the applied Supabase versions. Apply them with an administrative connection; the app's database identity deliberately cannot change schema or update/delete report history. Set its database password through a protected administrative channel rather than a tracked migration.

The login uses a salted password hash, signed seven-day HttpOnly cookie, same-origin login/logout checks, and shared database rate limits. Each publisher has a separate report-kind credential. Database connections verify Supabase's certificate. No database or publisher credential reaches browser code.

Private imports, credentials, publisher receipts, and the generated login handoff remain under `.local/`, excluded from Git and Vercel uploads. Never place report content in `public/`. Reports and supporting files are stored in an unexposed schema with RLS and a restricted application role. HTML artifacts use a separate sandboxed document with embedded fonts, so report navigation and evidence remain usable without sharing the portal's origin privileges.

The shared rounded shadcn theme lives in `app/theme.css`; checked-in components live in `components/ui/`. `npm run report-ui` compiles that theme and the same Select component for sandboxed HTML reports, and runs automatically before development and production builds. Commit the generated `lib/generated/report-ui.json` alongside changes to its inputs. The document adapter preserves each source select's options, disabled state, and change events; its inline bundle is covered by the report's exact-script content security policy.

The old usage site is temporarily read once daily for reports from computers not yet migrated. Claude's cloud readings generation is unchanged; a Mac-based relay publishes its completed edition at 12:15 PM Central. See the schedule registry for operational dependencies and retirement steps.
