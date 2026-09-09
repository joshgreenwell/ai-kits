# Golden fixture suite (JG-158)

Each case directory holds:

- `base/` and `head/` — the repository content on each side (synthetic, headered files);
- `expected.json` — the exact `check --base <base> --head <head> --json` output;
- `expected.txt` — the exact text output of the same command;
- `expected.exit` — the exit code;
- optionally `case.json` with `{"variants": [{"name": "<n>", "args": [...]}]}`; a variant
  is run with the extra arguments and compared with `expected.<n>.json`,
  `expected.<n>.txt` and `expected.<n>.exit`.

## Placeholder rule

The test harness (`test/golden-helpers.ts`) builds a temporary git repository, commits
`base/` then `head/`, runs the compiled CLI (and the exported `run()` in-process), and
replaces every occurrence of the base commit SHA with `<base-sha>` and of the head commit
SHA with `<head-sha>` before comparing. These are the only volatile bytes; they appear as
`base.sha`, `head.sha`, `origin.sha`, `origin.spec`, `sources[].sha` and the deltas'
entries' `source_sha`. Blob ids are content-addressed and stable, so they are compared
verbatim.

## Regenerating

```
npm run golden            # every case
node scripts/update-golden.mjs add-hook   # one case (after npm run build)
```

Review the diff of every regenerated file: the expected output is the specification.
A hygiene test fails when an expected file carries a real-looking secret that is not
marked `SYNTHETIC`.
