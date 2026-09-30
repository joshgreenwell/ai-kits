# Daily tech intel snapshot

The part of the `daily-tech-intel-snapshot` task that the board depends on. The task's own prompt still decides which newsletters and pages it reads; this template covers what it writes, how it renders, and how it publishes. Paths are relative to a checkout of this repository.

| | |
|---|---|
| Scheduler | Claude Desktop scheduled task `daily-tech-intel-snapshot`, on the Mac, with the app running |
| When | Daily at 9:00 AM America/Chicago. The app starts it at about 9:08 AM, and on the next launch when it was closed |
| Producer | `claude-readings`, scoped to `readings` |
| Contract | [`readings-v1`](../contract/readings-v1.schema.json), in observe mode |
| Board view | `/readings` |

The Claude cloud routine for this snapshot is disabled, not deleted. Its prompt still posts to Slack, so do not re-enable it alongside the Mac task.

## What the run writes

The task keeps its editions and `state.json` under `kit-board/.local/readings/`, which Git ignores. `kit-readings/.local/` is ignored too, for when that state moves into the kit. The examples below use one dated folder per edition.

1. **`edition.json`**: the `readings-v1` payload.
   ```json
   {
     "markdown": "# Daily Tech / AI / Crypto Snapshot — 2026-09-28\n…",
     "source": "Daily tech intel snapshot",
     "coverage": { "window": "2026-09-27T09:08:00-05:00/2026-09-28T09:08:00-05:00" }
   }
   ```
   - `markdown` is required and must not be blank. Standard headings and Slack-style `<https://…|label>` links both render.
   - `source` is optional and is shown under the HTML edition.
   - `coverage` is copied into the envelope. Its `window` runs from the last successful run's time in `state.json` to this run's.
2. **`edition.html`**, rendered from the same file:
   ```bash
   node kit-readings/render-readings.mjs --file kit-board/.local/readings/2026-09-28/edition.json --output kit-board/.local/readings/2026-09-28/edition.html
   ```
   The renderer makes only `https:` links clickable and exits 1 on a blank edition.

## Publish

Check first. `--dry-run` sends the body to `POST /api/v1/reports/readings/validate`, which stores nothing:

```bash
node kit-board/scripts/publish.mjs --kind readings --producer claude-readings --file kit-board/.local/readings/2026-09-28/edition.json --html kit-board/.local/readings/2026-09-28/edition.html --title "Daily readings" --period 2026-09-28 --produced-at 2026-09-28T09:08:00-05:00 --dry-run
```

Then run the same command without `--dry-run`, and record this run's time in `state.json` only after the receipt arrives.

- **`--period`** is the edition's day, as `YYYY-MM-DD`.
- **`--produced-at`** is when the sources were read, with a UTC offset, never the upload time.
- **`--status`** is `partial` when a source could not be read, and `failed` when there is no edition to publish.

## When publishing fails

Run the same command again with the same files. The same content produces the same idempotency key, so the board answers with a duplicate receipt rather than a second revision. The publisher keeps the failed body in its `outbox/`. Do not advance `state.json` and do not fetch the sources again: the next run's window then starts where the stored edition ended.
