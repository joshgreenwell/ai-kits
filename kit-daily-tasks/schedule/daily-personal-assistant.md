# Daily personal assistant

The part of the `daily-personal-assistant` task that the board depends on. The live task's own prompt still decides which mailboxes, calendars and trackers it reads; this template covers what it writes and how it publishes. Paths are relative to a checkout of this repository.

| | |
|---|---|
| Scheduler | Codex task `daily-personal-assistant` |
| When | Daily at 9:00 AM America/Chicago; the standup on weekdays only |
| Producer | one key scoped to `tasks` and `standup` (`INGEST_KEYS_JSON` on the board, `~/.config/personal-hub/publish.json` on the machine) |
| Contracts | [`tasks-v1`](../contract/tasks-v1.schema.json), [`standup-v1`](../contract/standup-v1.schema.json); both in observe mode |
| Board view | `/tasks`, that day's standup above its briefing |

## What the run writes

Keep every file under a dated folder, so a retry can publish the same bytes again.

1. **`briefing.json`**: the `tasks-v1` payload only. The publisher wraps it in the envelope.
   - `sections` is required, even as `{}`. Each key is a domain, an object holding `items`, `queue` and `empty_note`. The board draws `work`, `personal` and `aa` first, in that order, then any other domain under its own key.
   - Every item needs a `title`.
     - `priority` is `urgent`, `today`, `soon` or `later`.
     - `kind` is `reply`, `deadline`, `followup` or `information`.
     - Links are `https:`, `http:` or `linear:`. The board drops any other address.
   - Every queue entry needs an `id`. Its `updated` is whole days since the last change, like `4d`.
   - `markdown`, `notice`, `date_label`, `time_label`, `week`, `inbox`, `candidates` and `coverage` are optional.
   - A `coverage` array (`[{ source, status, detail }]`) is copied into the envelope as `coverage.sources`. Put a source there when it was stale or unreadable.
   - A field the board does not read yet is kept and passes the contract. Add fields there first.
2. **`briefing.html`**: optional, the complete HTML edition. The board shows it in an isolated frame.
3. **`standup.md`**, on weekdays: the exact final standup text. A plain-text file is published as `{ "markdown": <the text> }`.

## Publish

Check first. `--dry-run` sends the body to `POST /api/v1/reports/tasks/validate`, which answers what ingestion would decide and stores nothing:

```bash
node kit-board/scripts/publish.mjs --kind tasks --producer <producer> --file briefing.json --html briefing.html --title "Daily briefing" --period 2026-09-28 --produced-at 2026-09-28T09:04:00-05:00 --dry-run
```

Then run the same command without `--dry-run`. On weekdays, publish the standup with the same `--period`:

```bash
node kit-board/scripts/publish.mjs --kind standup --producer <producer> --file standup.md --title "Standup" --period 2026-09-28 --produced-at 2026-09-28T09:07:00-05:00
```

- **`--period`** is the day the briefing is for, as `YYYY-MM-DD`. The standup uses the same day, so `/tasks` shows the two together.
- **`--produced-at`** is when the sources were read, with a UTC offset. It is never the upload time. The board refuses a time more than five minutes in the future.
- **`--status`** is `complete` by default. Use `partial` when a source could not be read, and name it in `coverage`. Use `failed` when the run produced nothing usable, and publish anyway so the day has a record. `/tasks` skips failed revisions when it picks a day's default.
- **The receipt** carries `contract: { id, valid, issues }`. A mismatch is stored while the contract is observed, and the publisher warns on stderr. Fix the prompt before the kind is enforced; after that the board answers 422.

## When publishing fails

Run the same command again with the same files. The same content produces the same idempotency key, so a report the board already stored comes back as a duplicate, never as a second revision. The publisher keeps each failed body in the `outbox/` beside its config. Never gather the sources again to recover a failed upload.

## Checking by hand

`kit-daily-tasks/fixtures/` holds synthetic request bodies that pass or fail each contract, and its `MANIFEST.json` says why. To check a whole request body without the board:

```bash
node kit-daily-tasks/contract/validate.mjs kit-daily-tasks/contract/tasks-v1.schema.json body.json
```

It checks the whole envelope. The board also refuses a future `produced_at` and a `period_key` that is not a real date.
