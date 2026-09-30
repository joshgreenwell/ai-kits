# Fixtures

Every file here is a complete request body for `POST /api/v1/reports/:kind`, written by hand. None is copied, trimmed or sanitized from a stored report. People, hosts and addresses use `example.com`, `example.org` or `example.net`, and the subject is `example-owner`. [`MANIFEST.json`](MANIFEST.json) holds the declaration that `CONTRIBUTING.md` asks of every fixture (origin, ref, completeness, excerpt or raw), because the envelope is closed and a body cannot carry one itself.

- **`valid/`** bodies pass the contract copy and the board's own checks. The manifest says what each one proves.
- **`invalid/`** bodies each fail at exactly one path, which the manifest records along with the part that refuses it:
  - `envelope`: the board answers 400 and stores nothing.
  - `contract`: the payload does not match. While the contract is observed, the board stores the report and says so in the receipt. Once it is enforced, it answers 422.

`test/fixtures.test.mjs` checks all of this, and that the manifest lists exactly the files present.

## What the schema cannot say

`contract/validate.mjs` checks everything in the schema. The board checks three more things, which JSON Schema cannot express the same way:

- `produced_at` may not be more than five minutes in the future. The tests check the valid fixtures against the clock, so their dates stay in the past.
- `period_key` must be a real calendar date.
- The board trims `title` before it checks the 200-character limit, so the schema is stricter there: a 200-character title followed by spaces fails the schema and passes the board. A title of spaces fails both.
