# Fixtures

Every file here is written by hand. None is copied, trimmed or sanitized from a stored watch, a runner log or a real pull request. Pull requests are `example-owner/example-app` on github.com, the author is `example-author`, the session is `example-session`, and every commit or fingerprint is one repeated hex digit. [`MANIFEST.json`](MANIFEST.json) holds the declaration that `CONTRIBUTING.md` asks of every fixture (origin, ref, completeness, excerpt or raw), because a report is a closed object and cannot carry one itself.

- **`report-*`** files are bodies the runner posts to `POST /api/v1/pr-watches/:id`, checked against `pr-watch-report-v1`.
- **`work-*`** files are what `GET /api/v1/pr-watches` answers, checked against `pr-watch-work-v1`.
- **`valid/`** files pass their contract copy. The manifest says what each one proves.
- **`invalid/`** files each fail at exactly one path, which the manifest records. The board answers 400 to a report like this and changes nothing. There is no observe mode here: the runner is the only producer and ships with the board.

`test/fixtures.test.mjs` checks all of this, and that the manifest lists exactly the files present.

## What the schema cannot say

`contract/validate.mjs` checks everything in the schema. The board checks the rest against the watch itself, so a report that passes here can still be refused:

- An unknown watch id answers 404.
- A report for the other kind of watch, such as `addressed` on a review watch, answers 409.
- A `started` event while a session is running, or a finish event when none is, answers 409.

The board also cleans what it keeps: control characters in `note`, `error` and `title` become spaces, and a `summary` keeps its line breaks but not runs of blank lines. The schema accepts those characters, so the runner does not need to strip them first.
