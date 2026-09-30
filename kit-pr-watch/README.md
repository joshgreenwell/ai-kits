# kit-pr-watch

The PR watch kit runs the Observatory's `/reviews` queue. A runner on the Mac, started by launchd every 5 minutes, asks the board for the watched pull requests and reads each one through `gh`. On someone else's PR it starts a follow-up AI review when the author changes the diff; on the owner's own PR it starts a session that works through new review comments. It reports what it saw on each watch back to the board. The runner spends no tokens: a model runs only when a session is due.

| Path | What it is |
|---|---|
| [`pr-watch.mjs`](pr-watch.mjs) | The runner: `tick`, `check`, `keygen`, `install`, `uninstall`, `status`. No dependencies |
| [`pr-watch-core.mjs`](pr-watch-core.mjs) | Every decision the runner makes (`decide`, `decideAddress`, the prompts), with no network access |
| [`contract/`](contract/) | Copies of the board's `pr-watch-work-v1` and `pr-watch-report-v1` schemas and examples, and `validate.mjs` |
| [`fixtures/`](fixtures/) | Synthetic work lists and reports that pass or fail the contracts; [`MANIFEST.json`](fixtures/MANIFEST.json) says why |
| [`test/`](test/) | `npm test`: both decision tables, every report they build against the contract copy, the fixtures, and the runner's CLI, with nothing but Node 22 |

[`kit-board/docs/pr-watch.md`](../kit-board/docs/pr-watch.md) explains every rule the runner follows and how to operate it.

## Setup

The runner needs `gh` signed in, `claude` on the `PATH`, and the workspace the sessions run in (`~/github/luumen-workspace` by default). Run these from this folder:

```bash
node pr-watch.mjs keygen
```

It saves the key to `~/.config/personal-hub/publish.json` under `producers["pr-watch"]` and prints only a hash entry. Merge that entry into `INGEST_KEYS_JSON` on Vercel.

```bash
node pr-watch.mjs install
```

It checks the key, `gh auth status`, `claude --version` and the workspace, then loads `com.personal-observatory.pr-watch`. The agent runs this file in place, so run `install` again after moving the checkout. An update to the script needs no reinstall.

`kit-board/scripts/pr-watch.mjs` forwards to this runner, so a LaunchAgent installed from the old path keeps working. Running `install` through it writes this kit's path. It will be removed once the LaunchAgent runs this copy.

## Contracts

- **`pr-watch-work-v1`** is what `GET /api/v1/pr-watches` answers: the work list for one tick. It is open, so the board can add a key without breaking an older runner.
- **`pr-watch-report-v1`** is the body of `POST /api/v1/pr-watches/:id`: what the runner saw on one watch, and what it did. It is strict. The board answers 400 to a body that does not match and changes nothing; there is no observe mode. [`fixtures/README.md`](fixtures/README.md) lists the refusals the schema cannot express.

The signed-in `/kits/pr-watch` page shows each field of both.

The files in `contract/` are copies. Never edit them here: change the zod source in `kit-board/lib/pr-watch-contract.ts`, run `npm run contracts` in `kit-board/`, and copy the regenerated files into this folder in the same commit. [`contracts.yml`](../.github/workflows/contracts.yml) fails when a copy drifts.

## Local state

The key, optional settings and the runner's state live in `~/.config/personal-hub/`: `publish.json`, `pr-watch.json`, `pr-watch-state.json`, and `logs/pr-watch.log`. They are the owner's and never enter Git.

## Tests

```bash
cd kit-pr-watch && npm test
```

[`kit-pr-watch.yml`](../.github/workflows/kit-pr-watch.yml) runs the same on every change to this folder.
