# Personal Observatory · Claude quota (browser collector 2.0.0)

An unpacked Chrome/Edge extension that reads Claude allowance percentages and reset times from a
signed-in `claude.ai` tab and uploads them to the Observatory as `allowance.reading` records
(envelope v2, adapter `claude_browser`, channel `browser_session`, reader `web_backend`). It never
reads conversations, exports cookies, or uploads token counts, organization names, or email
addresses. Version 2.0.0 keeps the v1 upload path as a legacy bridge for the reconciliation period.

No build step, no dependencies: `manifest.json`, `background.js` (service worker), `collector.js`
(pure logic shared with the tests), `normalize.js` (the claude.ai usage shapes), and the options page.

## What it uploads

One read costs three requests in the Claude tab (`/api/account`, `/api/organizations`,
`/api/organizations/<pinned org>/usage`). From the usage response, `normalize.js` recognizes:

| Window | Meter key | Label | Length |
| --- | --- | --- | --- |
| Session (`limits[].kind = session`, or top-level `five_hour`) | `five_hour` | `Claude · 5h` | 300 min |
| Pooled weekly (`weekly_all`, or top-level `seven_day`) | `seven_day` | `Claude · weekly` | 10080 min |
| Model-scoped weekly (`weekly_scoped` with a model or surface scope) | `seven_day_<slug of the display name>` | `Claude · weekly · <Display Name>` | 10080 min |
| Extra usage credits (`extra_usage.is_enabled`) | `extra_usage` | `Claude · extra usage` | weekly anchor |

Keys, labels, window lengths, reset anchors, basis (`reported`), and scope are the same the
companion's statusline and OAuth readers produce for those windows (`observatory-core::inbox`), so
the Allowances page treats a browser reading and a companion reading of one window as the same
meter. Each record id is a function of the binding, meter, and observation, so a retried body is a
duplicate on the server, never a second reading. The body carries nothing else from the tab.

## Install (once per browser profile)

1. Check out the repository on the machine (or copy this directory to it). The directory must stay
   in place: an unpacked extension loads from its path, and every later update is a reload of the
   same path, not a reinstall.
2. In the profile that is signed into `claude.ai`: `chrome://extensions` (or `edge://extensions`)
   → enable Developer mode → **Load unpacked** → choose `kit-board/browser/claude-quota`.
   Note the extension id; it stays constant for that path in that profile.
3. Keep a `claude.ai` tab open in that profile. The collector reads only through an open tab.

## Pair and bind

1. Observatory → Settings → Connections → **Add browser**: label the profile (for example
   `Chrome · personal`) and issue a code (single use, ten minutes).
2. Open the extension's options page (click its toolbar icon). Under **1. Pair**, paste the code and
   the label, then **Pair**. The install id and key are stored in the extension's local storage of
   that profile only (`chrome.storage.local`, trusted contexts).
3. Under **2. Bind**, **Find my Claude account**, enter the **Observatory account id** the readings
   belong to (`claude-personal`, `claude-work`: the same id the legacy connection used, so the
   history stays on one card), optionally a label (never an email), and **Bind** the organization.
   The collector posts the binding with the identity hash of the signed-in claude.ai account
   (`sha256(["claude", account uuid])`, the hash the companion posts for the same sign-in), confirms
   it, pins the account and organization, and collects once.
4. Connections lists the install with kind `browser`, its binding, the health ladder, and the newest
   reading. Settings → Collection applies to it: the kill switch, a pause, `providers.claude`, and the
   cadence (15, 30, or 60 minutes) are read from `GET /api/v1/companion/config` on every run; a
   disabled binding or install stops uploads.

The options page states the profile's health from stored facts only: pairing, bound account and
identity state, the windows recognized by the last read, the last actual observation time, the last
upload receipt (accepted, duplicate, rejected reasons), the last error with its HTTP status and the
observation it concerned, and the unsupported states by name: no `claude.ai` tab, signed out, account
mismatch with the pinned account, organization unavailable, unrecognized usage shape, install key
refused, identity refused.

## Reconciliation and per-profile cutover

A profile that still holds a v1 connection publishes both bodies from one read: v1 to
`/api/v1/telemetry` under the v1 source key and v2 to `/api/v1/usage` under the install key. Both
carry the same observation time, value, and reset anchor per window. The compatibility view shows
such a pair once, as the v2 reading (**v2 wins on a tie**); the v1 sample stays in its ledger as
preserved history and the v1 source's own contact and reading lines keep moving on the legacy card.

Cut a profile over when the paired install shows fresh readings for the same account:

1. Observatory → Settings → Connections → **Legacy browser bridge**: **Pause** that profile's v1
   source. Its history stays visible (`history_only`); new v1 uploads are refused.
2. Extension options → **Legacy v1 bridge** → **Remove legacy connection**. The profile now publishes
   v2 only; its outbox for v1 is discarded (a paused source would refuse it anyway).
3. Repeat per browser profile and machine. Leave unrelated Claude browser integrations alone. The
   extension directory itself is removed only in USG-026, after the retirement runbook.

To move an existing v1-only profile to v2: reload the extension from the same path
(`chrome://extensions` → reload) so version 2.0.0 runs, then pair and bind as above. The stored v1
connection and the pinned account survive the reload.

## Upload and retry behaviour

Readings are queued oldest first (at most 168 bodies per path) and drained on every run. A body is
kept and the drain stops on a network fault, 408, 429, or any 5xx; it is kept and the drain stops on
401 or 403 (install key refused, or the install disabled: disable and pair again); any other 4xx is a
permanently rejected body, which is dropped and recorded in the last error with its status and
observation time so it can no longer block the readings behind it. When the tab cannot be read, a
coverage-only body states why (`prerequisite_missing/no_tab`, `credential_unavailable`,
`identity_changed/account_mismatch`, `failed/unrecognized_shape`) so Connections shows it; that is
contact, not a reading, and it is never queued.

## Tests

`tests/browser-collector.test.ts` loads `collector.js` and the service worker in Node against a
stubbed `chrome` and `fetch`, and `tests/browser-collector.integration.test.ts` runs the pair, bind,
upload, and read-back path against a disposable database (`npm run test:db`). The fixture is
`tests/fixtures/browser/claude-web-usage.json`.
