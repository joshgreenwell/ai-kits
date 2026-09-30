# kit-daily-tasks

The daily tasks kit feeds the Observatory's `/tasks` page. A scheduled agent reads mail, calendar and the work queue each morning, publishes the briefing as a `tasks` report, and on weekdays publishes the standup as a `standup` report. The board stores and draws them; this kit holds what the agent needs to know to produce them.

| Path | What it is |
|---|---|
| [`schedule/daily-personal-assistant.md`](schedule/daily-personal-assistant.md) | The schedule template: when it runs, what it writes, and how it checks and publishes |
| [`contract/`](contract/) | Copies of the board's `tasks-v1` and `standup-v1` schemas and examples, and `validate.mjs` |
| [`fixtures/`](fixtures/) | Synthetic request bodies that pass or fail each contract; [`MANIFEST.json`](fixtures/MANIFEST.json) says why |
| [`test/`](test/) | `npm test`: the fixtures against the contract copies, with nothing but Node 22 |

## Contracts

Both contracts are in observe mode. The board stores a report whose payload does not match and returns the mismatch in the receipt. It refuses a bad envelope with 400. The signed-in `/kits/daily-tasks` page shows each field, how many recent revisions match, and a form that checks a pasted body.

The files in `contract/` are copies. Never edit them here: change the zod source in `kit-board/lib/report-contracts.ts`, run `npm run contracts` in `kit-board/`, and copy the regenerated files into this folder in the same commit. [`contracts.yml`](../.github/workflows/contracts.yml) fails when a copy drifts.

## Publishing

The publisher stays with the board, at [`kit-board/scripts/publish.mjs`](../kit-board/scripts/publish.mjs), because it is the reference client for the envelope. `--dry-run` asks the board's validate endpoint and stores nothing. The schedule template has the commands.

## Tests

```bash
cd kit-daily-tasks && npm test
```

[`kit-daily-tasks.yml`](../.github/workflows/kit-daily-tasks.yml) runs the same on every change to this folder.
