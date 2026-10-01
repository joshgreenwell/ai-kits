# kit-readings

The readings kit feeds the Observatory's `/readings` page. A scheduled task on the Mac writes the daily tech, AI and crypto snapshot as markdown and publishes it as a `readings` report. The board parses the markdown and draws the page; this kit holds what the task needs to know to produce it.

| Path | What it is |
|---|---|
| [`schedule/daily-tech-intel-snapshot.md`](schedule/daily-tech-intel-snapshot.md) | The schedule template: when it runs, what it writes, and how it checks and publishes |
| [`contract/`](contract/) | A copy of the board's `readings-v1` schema and example, and `validate.mjs` |
| [`fixtures/`](fixtures/) | Synthetic request bodies that pass or fail the contract; [`MANIFEST.json`](fixtures/MANIFEST.json) says why |
| [`test/`](test/) | `npm test`: the fixtures against the contract copy, with nothing but Node 22 |

## Contract

`readings-v1` is in observe mode. The board stores a report whose payload does not match and returns the mismatch in the receipt. It refuses a bad envelope with 400. The signed-in `/kits/readings` page shows each field, how many recent editions match, and a form that checks a pasted body.

The files in `contract/` are copies. Never edit them here: change the zod source in `kit-board/lib/report-contracts.ts`, run `npm run contracts` in `kit-board/`, and copy the regenerated files into this folder in the same commit. [`contracts.yml`](../.github/workflows/contracts.yml) fails when a copy drifts.

## Publishing

The publisher stays with the board, at [`kit-board/scripts/publish.mjs`](../kit-board/scripts/publish.mjs), because it is the reference client for the envelope. The readings task sends the markdown alone. The envelope still accepts an HTML edition, which `/readings` would show under the parsed page, but nothing produces one. The schedule template has the commands.

## Local state

Editions and the task's `state.json`, which sets the next coverage window, are the owner's data and never enter Git. They live under `kit-board/.local/readings/` today. `kit-readings/.local/` is ignored as well.

## Tests

```bash
cd kit-readings && npm test
```

[`kit-readings.yml`](../.github/workflows/kit-readings.yml) runs the same on every change to this folder.
