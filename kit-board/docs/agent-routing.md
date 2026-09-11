# Agent routing telemetry API

The Personal Observatory accepts a small, append-only record of routing decisions. It is an observability ledger, not a prompt archive: the versioned event contract has no prompt, transcript, attachment, account identifier, or free-text reason fields.

`POST /api/v1/agent-events` accepts `application/json` with a local telemetry-source bearer key:

```json
{"schema_version":1,"events":[{"schema_version":1,"event_id":"uuid","task_id":"uuid","attempt_id":null,"sequence":1,"event_type":"task.registered","occurred_at":"2026-09-10T19:30:00Z","payload":{"task_type":"implementation","complexity":"medium","risk":"low","workload":"work","parent_task_id":null,"request_hash":"sha256"}}]}
```

The batch limit is 100 events and 256 KB. The server derives the source, account, and provider from its bearer key. Browser telemetry keys cannot use this endpoint. A successful write returns `{ "ok": true, "schema_version": 1, "receipts": [{ "event_id": "…", "duplicate": false }] }`, one receipt for each submitted event, so an outbox can delete only acknowledged IDs. An event is replay-safe when its source event ID or task sequence has identical content; a reused key with different content returns `409`, and the whole batch rolls back.

`GET /api/v1/agent-events?task_id=<uuid>` returns only events written by the authenticated local source. `GET /api/v1/quota-state` returns the authenticated account's latest quota windows across its active telemetry sources. Each window reports the observed percentage, source freshness, and one of `usable`, `insufficient`, `stale`, or `discontinuous`. A fresh direct reading is `usable` even when pace is `null`; pace is omitted whenever the observations cannot safely support a rate. Missing windows stay absent rather than becoming zero usage.

The exact routing event JSON schema and its dependency-free validator are vendored in `lib/routing-contract/`. Do not edit either copy here; update the canonical workspace contract and re-vendor both files with byte parity.

Run `npm run test:routing:db` to apply migrations and execute the routing unit and integration tests against a disposable local PostgreSQL cluster. It requires `initdb`, `pg_ctl`, `psql`, and `createdb` on `PATH`, accepts no production connection string, listens only on an ephemeral Unix socket, and removes its own temporary cluster after stopping it.

Attempt-start events carry a `configuration_hash`. Runtime outcomes may only record `unknown` with null human-quality fields; test, CI, and benchmark outcomes require an evidence hash. Task registration never carries an attempt ID. The task-events read is capped at the first 500 events; pagination and routing-outcome UI are outside V1.
