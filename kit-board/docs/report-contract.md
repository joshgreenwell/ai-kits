# Published report contract v0 (observed)

Recorded 2026-09-11 against `373fdbb7` (the post-move tree). This is a **description of what the
code enforces today**, not a specification of what it should enforce. It exists because the
Observatory plan asserted that an existing audit prompt "already fixes the report semantics" and
that this "IS the report contract v0"; that is only partly true, and the difference matters to
anyone adding a second producer. Everything below cites the file that enforces it. Anything a
producer sends that is not cited here is unvalidated free-form data.

The eventual contract v1 (plan Phase 3) is the decision about which of these conventions become
guarantees. Do not treat this file as that decision.

## 1. The two publication endpoints

| Kind | Endpoint | Body | Auth |
| --- | --- | --- | --- |
| `usage` | `POST /api/reports` | the monthly analyzer envelope, passed through unchanged | producer key scoped to `usage` |
| `tasks`, `standup`, `readings`, `audit` | `POST /api/v1/reports/<kind>` | the envelope in §2 | producer key scoped to that kind |

`app/api/v1/reports/[kind]/route.ts:10` explicitly refuses `usage` on the v1 route. The kind list is
closed in three places, one of them the database: `lib/contracts.ts:3`, `scripts/publish.mjs:11`,
and `CHECK (kind IN ('usage','tasks','standup','readings','audit'))` on `report_revisions`
(`supabase/migrations/20260908050538…:6`). **A new report kind is therefore a migration plus two
code changes plus a `lib/catalog.ts` section entry** — never a producer-side decision. A new
*producer* or *subject* on an existing kind needs none of that.

## 2. What the server validates

`reportSchema` in `lib/contracts.ts:6-27` is `.strict()`, so an unknown top-level key is a 400.
The validated fields are exactly:

| Field | Rule | Source |
| --- | --- | --- |
| `schema_version` | literal `1` | contracts.ts:7 |
| `period_key` | `YYYY-MM` or `YYYY-MM-DD`, and a real calendar date | contracts.ts:8, 21-24 |
| `subject_key` | 1–160 chars, `[a-zA-Z0-9._:@+-]` | contracts.ts:5, 9 |
| `idempotency_key` | same charset as `subject_key` | contracts.ts:5, 10 |
| `title` | trimmed, 1–200 chars | contracts.ts:11 |
| `produced_at` | ISO-8601 **with offset**, at most 5 minutes in the future | contracts.ts:12, 18-20 |
| `status` | `complete` \| `partial` \| `failed` | contracts.ts:13 |
| `coverage` | any JSON object, default `{}` — **contents unvalidated** | contracts.ts:14 |
| `payload` | any JSON object, required — **contents unvalidated** | contracts.ts:15 |
| `html` | optional string, ≤ 3,500,000 chars | contracts.ts:16 |

There are **two independent size limits**, and they are easy to confuse. The whole envelope is
capped at 4,000,000 bytes, client-side at `scripts/publish.mjs:32` and server-side in `readJson`
(`lib/contracts.ts:34-37`, which also requires `Content-Type: application/json`). Separately,
`html` alone is capped at 3,500,000 **characters** by the schema (`contracts.ts:16`). A large
HTML audit can therefore clear the byte check and still fail schema validation on `html`, and a
multi-byte-heavy report can do the reverse. Size a report against both.

### What the server does *not* validate

Run id, commit SHA, rubric version, scores, baseline and limitations are **producer convention
inside `payload`**. No schema names them, and no code in `kit-board/` reads them. They are
durable because producers keep sending them, not because anything enforces them.

The one exception is `coverage.presentation`. `lib/report-selection.ts:8` prefers the newest
non-failed audit whose `coverage.presentation === 'full-audit'` as the default view for `/audit`.
That single string is load-bearing: an audit published without it will not be chosen as the
default report even if it is the most complete one. Any other value is accepted silently.

## 3. Publisher CLI surface

`scripts/publish.mjs:10` is authoritative:

- **Required always:** `--kind`, `--producer`, `--file`
- **Required for every non-`usage` kind:** `--period`, `--produced-at` (publish.mjs:30, which
  states the reason: observation time must not be replaced by upload time)
- **Optional:** `--html`, `--subject` (defaults to `josh`, publish.mjs:21), `--title` (defaults
  to the kind string, publish.mjs:23), `--status` (defaults to `complete`, publish.mjs:25),
  `--config`, `--dry-run`

`--file` is read as JSON; if it does not parse it is wrapped as `{markdown: <text>}`
(publish.mjs:16-17). `coverage` is lifted out of that payload — an array becomes
`{sources: [...]}`, an object is passed through (publish.mjs:26). **There is no CLI flag for
`coverage.presentation`**; it must be set inside the `--file` JSON.

`--dry-run` prints `{valid, kind, bytes, content_hash}` and exits before reading credentials
(publish.mjs:33). It proves envelope construction and size only — not server acceptance.

Credentials come from `--config`, else `$PERSONAL_HUB_CONFIG`, else
`~/.config/personal-hub/publish.json` (publish.mjs:34). The config directory name is deliberately
unchanged by the repository move. The only audit producer key this repository documents is
`audit-local` (`docs/startup-and-recovery.md`); `lib/catalog.ts:14` records the Tuesday job's
*scheduler* source id as `weekly-luumen-ai-audit`. Those are different namespaces and neither is
a value the server validates — the producer name is whatever key the operator's `publish.json`
maps to a credential, and the server returns whichever `INGEST_KEYS_JSON` entry matches the
bearer token (`lib/auth.ts:17-24`).

## 4. Publication outcomes

There is no asynchronous accept step. A publish is resolved in one request:

| Outcome | Status | Body | Source |
| --- | --- | --- | --- |
| accepted | 201 | `{ok:true, id, duplicate:false}` | db.ts:49, route.ts:14 |
| duplicate | 200 | `{ok:true, id (the original), duplicate:true}` | db.ts:50-52 |
| conflict | 409 | `This idempotency key already names different content; use a new revision key` | db.ts:51 |
| rejected | 400 / 401 / 404 / 413 / 415 / 503 | validation, auth, unknown kind, size, content type, no database | contracts.ts, auth.ts, http.ts |

Idempotency is `ON CONFLICT (producer_id, kind, idempotency_key) DO NOTHING`, then a content-hash
comparison (`lib/db.ts:47-52`), backed by the `UNIQUE(producer_id, kind, idempotency_key)`
constraint on `report_revisions` (`supabase/migrations/20260908050538…:20`). Two consequences worth stating plainly:

1. **Idempotency is scoped per producer.** Two producers may use identical keys without
   colliding. A second audit producer needs no key-namespace coordination.
2. **The 409 path is unreachable through `publish.mjs`.** The CLI derives
   `idempotency_key` from a SHA-256 of the content itself (publish.mjs:17), so changed content
   always produces a new key and lands as an additional revision rather than a conflict. Only a
   producer that posts to `/api/v1/reports/<kind>` directly with its own stable key can trigger
   it. The plan's "same key with different content is a conflict" is implemented, but nothing
   currently exercises it.

Nothing is ever updated or deleted: `report_revisions` is append-only and the application role
holds no `DELETE` grant. A correction is a new revision.

The CLI spools the body to `<config-dir>/outbox/` before the first attempt and renames it to
`.published` after a receipt (publish.mjs:41, 44, 58), retrying 3× on 5xx/429 only. A failed upload
is replayable without regenerating the report.

## 5. Deep links and receipts

`publish.mjs:59` prints `{ok, id, duplicate, url}` where `url` is built as
`new URL('/' + args.kind, config.url)` — the bare **section** URL, e.g. `https://<host>/audit`,
with no `?report=` query. A publisher that wants to hand back a link to the revision it just
created has to assemble `<url>?report=<id>` itself.

The deep link is real and works. `app/(private)/[section]/page.tsx:13-16` accepts `?report=<id>`,
404s if the id is unknown or belongs to another kind, and otherwise falls back to `defaultReport`;
the in-page history picker emits exactly that form (`components/report-view.tsx:17`). Only the
publisher's printed line omits it.

### What the page actually receives

`app/(private)/[section]/page.tsx:19` sends the client `payload: { markdown: report.payload.markdown }`
and replaces `html` with the literal string `'available'`. So **no other `payload` field reaches the
browser at all** — run id, SHA, scores and limitations are not merely unvalidated, they are not
delivered. `components/report-view.tsx:26` then renders the sandboxed artifact iframe when HTML
exists, and otherwise falls back to that `markdown` string.

`payload.markdown` is also what `publish.mjs:16-17` produces when `--file` is not valid JSON: the
raw text is wrapped as `{markdown: <text>}`. That fallback is the only thing that sets the one
payload field the section page can render.

HTML is fetched separately, authenticated, from `/api/artifacts/<id>`, which applies
`rewriteAssetLinks` and `prepareArtifact` on every view (`app/api/artifacts/[id]/route.ts:11`).

## 6. Assets

`publish-assets.mjs --report-id --html --allowed-root --producer` uploads evidence files to
`POST /api/v1/reports/audit/<report-id>/assets`, one request per asset, path and key in headers.

| Rule | Client (`publish-assets.mjs`) | Server (`lib/assets.ts`, `lib/assets-store.ts`) |
| --- | --- | --- |
| media types | `json,csv,md,txt,html` | same five (assets.ts:4-10) |
| size cap | 4 MB per asset | 4 MB per asset (assets.ts:14, 49-61) |
| filename | `^[A-Za-z0-9._-]{1,200}$` | same (assets.ts:45) |
| encoding | any file it can read as UTF-8 | **must decode as UTF-8 or 415** (assets.ts:62-63) |
| containment | realpath must stay inside `--allowed-root` (publish-assets.mjs:35-38, 49-58) | **not enforced** — the path is stored only as an opaque SHA-256 key |
| discovery | scans `href=` only | n/a |
| kind | audit only (publish-assets.mjs:73) | any kind |

Two consequences: **binary evidence cannot be published at all** — no PDF, PNG or ZIP survives the
UTF-8 decode — and `--allowed-root` is a producer-side guarantee, not a server-side one. Do not
describe containment as part of the contract the host enforces.

Assets are idempotent per `(report_id, asset_key)` and 409 on different content
(`assets-store.ts:12-19`) — but the asset key is `sha256(path)` (`assets.ts:36-37`), **not** a hash
of the content. That inverts the report behaviour: where a corrected *report* silently becomes a new
revision, a corrected *asset* re-uploaded at the same relative path is **rejected with 409**. Fixing
an evidence file therefore means publishing it under a new path or publishing a new report. This is
worth knowing before the first time a producer tries to patch one file.

`rewriteAssetLinks` (`assets.ts:66-85`) rewrites `<a href>` to
`/api/artifacts/<reportId>/files/<assetKey>` and strips `target`/`rel`, applied at render time on
every view. **`src=` is never rewritten**, so an image or stylesheet referenced by a report will not
resolve.

## 7. What a second audit producer would require

The intake side needs nothing: a new `INGEST_KEYS_JSON` entry scoped to `audit`, and the producer
supplies its own `--subject`. Idempotency, receipts and asset storage already separate producers.

The presentation side is where the work is. `/audit` today is a single history dropdown of every
audit revision, labelled with title, timestamp and status only (`components/report-view.tsx:17-21`).
It shows no producer and no subject, and `lib/db.ts:55-59` (`reportHistory`) fetches the newest 200
revisions of a kind with no subject or producer predicate — though it does already select
`producer_id` and `subject_key`, so the data reaches the client and only the rendering omits it.
`lib/report-selection.ts:5-11` picks one default across the whole kind, so a portfolio report and a
codebase report would compete for the same default slot. `lib/catalog.ts:14` hard-codes the section
title "Luumen AI audit" and its empty-state copy.

Distinguishing two producers is therefore a four-file change — `lib/db.ts`, `lib/report-selection.ts`,
`app/(private)/[section]/page.tsx`, `components/report-view.tsx` — plus catalog copy. None of it is
schema work.

## 8. Known gaps between this and a real contract v1

Recorded so Phase 3 starts from the list rather than rediscovering it:

- No named metadata fields. Run id, SHA, rubric version, scores and limitations are conventions.
- No subject registry. `subject_key` is a free string; nothing declares which subjects exist.
- No producer registry. Producer identity exists only as an `INGEST_KEYS_JSON` key.
- No declared `coverage` vocabulary beyond the single `presentation: 'full-audit'` marker.
- No binary assets, and no `src=` rewriting.
- No way to correct one evidence file: the same relative path 409s, so a fix means a new path or a
  new report.
- No payload beyond `markdown` reaches the section page, so any metadata promoted to the contract
  in v1 also needs a delivery path.
- No way for a reader to tell a disabled producer from a revoked one (see the plan, §4).
