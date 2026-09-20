# USG-010: Build and verify the v2 replacement for the active browser quota bridge

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: In progress
Priority: P1
Scope: Core
Stage: 2. Collection
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md)
Created: 2026-09-13

## Outcome

Replace the existing Claude browser quota dependency with a working paired v2 collector.

## Current gap

The v2 collector is implemented in this checkout and proven against the server contract and a disposable database; no production receipt from a real browser profile exists yet, and no profile has been cut over.

## Acceptance criteria

1. Implement a usable installation/pairing path and allowance-only upload flow for the currently supported Claude browser accounts using verified source fixtures.
2. Respect account identity, source enable/disable, settings, credential scope, and local/session isolation; do not upload token counters, browsing content, or arbitrary page text.
3. Expose reader health, recognized windows, last actual observation, pairing failures, and unsupported browser/provider states truthfully.
4. Run the replacement alongside the old bridge only for a controlled reconciliation period, with a defined duplicate-selection policy. Keep the old source available until new readings and preserved history are verified.
5. Document installation and per-profile cutover on each used browser/machine. Leave unrelated browser integrations intact; remove the old extension only in USG-026.

## Verification

Test pairing/auth, account changes, quota-only restrictions, failed reads, duplicate old/new observations, and a real new scheduled/automatic reading from each accessible supported browser profile.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [browser/claude-quota](<../../browser/claude-quota>)
- [components/browser-connections.tsx](<../../components/browser-connections.tsx>)
- [app/api/v1/companion](<../../app/api/v1/companion>)
- [app/api/v1/usage/route.ts](<../../app/api/v1/usage/route.ts>)
- [tests/browser-collector.test.ts](<../../tests/browser-collector.test.ts>)
- [docs/usage-v1-retirement.md](<../../docs/usage-v1-retirement.md>)

## Execution record

### 2026-09-20 · implementation in this checkout (branch `kit-board/usg-010-browser-collector-v2`)

**Implemented.** The Claude quota extension (`browser/claude-quota/`) is now version 2.0.0 at the same unpacked path, so a profile moves to v2 by reloading the extension, not by reinstalling it.

- `collector.js` (new, pure, shared with the tests): pair request and response handling, the companion-compatible identity hash (`sha256(stableJson(["claude", account uuid]))`, the same value `observatory-core::discovery::identity_hash` posts), the binding request (label may never be an email), `allowance.reading` construction with the companion's meter keys, labels, window lengths, reset anchors, basis `reported`, and scope (`window_label` / `window_slug` mirrored from `observatory-core::inbox`), deterministic record ids per (binding, meter, observation), envelope v2 and coverage rows, a coverage-only failure envelope, the settings gate over the config document, the outbox policy, and the health derivation.
- `background.js`: pairs through `POST /api/v1/companion/pair` (kind `browser`), binds through `POST /api/v1/companion/bindings` and re-confirms through the identity route when the Observatory holds no hash, reads `GET /api/v1/companion/config` on every run (kill switch, pause, `providers.claude`, binding enabled, cadence 15/30/60 applied to the alarm), uploads envelope v2 to `POST /api/v1/usage` with the install key, keeps the v1 path when a v1 connection is configured (both bodies from one read), posts a coverage-only body naming the reason when the tab cannot be read, and keeps the account pin and the running guards. Audit finding WEB-6 is fixed: the outbox retains and stops on 5xx/429/408/network, stops without dropping on 401/403, and drops any other 4xx (recording status and observation in the last error) and continues.
- `options.html/js/css`: pairing (code and label), binding (find the signed-in account, Observatory account id, organization), collect, a health block (pairing, bound account and identity state, recognized windows, last observation, last upload receipt, retained bodies, gate, last error) with named unsupported states, and the legacy bridge section with the cutover step (`removeLegacy`).
- Site: `components/companion-installs.tsx` gives the browser pairing code its real instructions and a kind-aware detail line; `components/browser-connections.tsx` is labelled as the legacy bridge with the cutover note; `lib/usage-store.ts` judges a browser install's binding rung over the providers a browser collector exists for (Claude), so a bound browser install reads `complete` rather than `partial` against the global Codex switch. No contract or migration change.
- Docs: `browser/claude-quota/README.md` (installation, pairing, cutover, retry behaviour), `docs/usage-collection.md` (Add browser, capability table, reader cadence and meter mapping), `docs/usage-v1-retirement.md` (browser rows and steps), `lib/allowance-meters.ts` comment.

**Duplicate-selection policy (criterion 4).** During dual publication both bodies carry one observation time, value, and reset anchor per window. `allowance_percent_view` shows such a pair once, as the v2 reading: v2 wins on a tie. The v1 sample stays in `quota_samples` as preserved history; a paused v1 source keeps its rows as `history_only`. Cutover per profile: pause the v1 source on the legacy card, then remove the legacy connection on the options page.

**What the tests prove.** `tests/browser-collector.test.ts` (9 tests) loads the pure module and the service worker in Node: the pair request and response, the identity hash against `stableJson`, envelope v2 built from `tests/fixtures/browser/claude-web-usage.json` validating against `usageEnvelopeSchema` and `allowanceReadingSchema` with the pinned companion meter keys and labels (`five_hour`, `seven_day`, `seven_day_claude_opus_4`, `extra_usage`) and no forbidden content (sentinel org, email, token counters), stable record ids, the outbox disposition table and drain, the settings gate, every health state, a full paired run (bind, upload, 400 dropped and continued, 503 retained, 401 stopped, missing tab reported as coverage only, paused, identity changed, unpair), and dual publication with matching observations followed by the cutover step. `tests/browser-collector.integration.test.ts` runs against the disposable database: a browser pairing code claimed with the collector's request, the binding with the collector's hash, the config gate, an envelope accepted then duplicated on retry, the readings read back through `allowance_percent_view`, `usageDashboard`, and `listInstalls` (kind `browser`, health `paired · complete · confirmed · ok`, newest reading by reader `web_backend`), the v1 duplicate hidden and older v1 history kept, the paused-source `history_only` flag, the coverage-only failure body, the pause and binding-disable gates, and the disabled install refusing its key.

**Remaining before Done (owner verification in production).** A real scheduled reading from each accessible browser profile: reload the extension in each profile, pair it from Connections, bind the account, confirm the paired install shows fresh `web_backend` readings beside the v1 source for the same account, then cut that profile over. The extension has not been loaded in a browser in this checkout; only Node tests ran. Codex and Cursor browser adapters remain contracts without a collector.
