# Contributing

## Layout

* `kit-board/` — Personal Observatory, Node 22 and Python 3.10+. See its [startup and verification guide](kit-board/docs/startup-and-recovery.md).
* `kit-daily-tasks/`, `kit-readings/` — Observatory producer kits, Node 22 with no dependencies. Run `npm test` in each.
* `agentlint/` — Kit 1, Python. Run `cd agentlint && uv run pytest`.
* `agent-surface/` — Kit 2, TypeScript. Run `cd agent-surface && npm ci && npm test`.

The directories never import from each other. Observatory runtime data and credentials stay outside Git. Fixtures, docs, and CI live inside each kit directory. Root-level files are limited to this file, the README, the license, CI workflow definitions under `.github/`, and `dist-workspace.toml` (the cargo-dist configuration for the companion's release workflow, which must run from the repository root).

## Observatory kits

The Observatory is one board fed by producer kits. [Observatory kits](kit-board/docs/kits.md) has the ownership table and the extraction status.

* **The board, `kit-board/`,** owns sign-in, every ingestion API, storage and migrations, the views, and every wire contract it accepts. Contracts are authored in zod and generated to JSON Schema under `kit-board/lib/generated/contracts/` with `npm run contracts`.
* **A producer kit, `kit-<area>/`,** holds what runs outside the board to feed it: a collector, a runner, or an agent-schedule template. It also holds a copy of its contract, synthetic fixtures, tests, a README, and a workflow named after the directory. Its branch prefix is its directory name.
* **Kits copy contracts; they never import them.** Each file in `kit-<area>/contract/` must be byte-identical to the board file of the same name in `kit-board/lib/generated/contracts/`. `.github/workflows/contracts.yml` is the one job that reads both sides, and it fails when a copy drifts. To update a copy, regenerate it on the board, then copy the file.
* **A contract change starts on the board.** Change the zod source, regenerate, copy into every kit that carries the file, and commit all of it together.

## Branches and pull requests

* One branch per Linear story or small group of stories, named `<kit>/<story-ids>-<short-slug>` (for example `agentlint/tl-a1-a4-core-model`).
* Every PR title starts with the Linear IDs it addresses (for example `TL-A1..A4: core model and normalization`).
* The PR body lists each acceptance criterion from the Linear story and states how the diff satisfies it, or why it does not.
* CI must be green and the story's acceptance criteria met before merge.

## Fixture hygiene

* Fixtures are synthetic or sanitized. Full traces, credentials, and internal identifiers from private systems never enter this repository.
* Every fixture declares origin, ref, completeness, and whether it is a documentary excerpt or a raw export.
* `agentlint/scripts/check_fixture_hygiene.py` enforces this in CI for Kit 1.

## Releasing `agentlint`

1. Bump `version` in `agentlint/pyproject.toml`, date the `CHANGELOG.md` entry, merge to `main`.
2. Tag the merge commit `agentlint-v<version>` (for example `agentlint-v0.0.1`) and push the tag. The `agentlint` workflow builds the sdist and wheel on every push; on a matching tag its `publish` job uploads them to PyPI through trusted publishing (`pypa/gh-action-pypi-publish`, `id-token: write`, GitHub environment `pypi`), so no API token is stored anywhere.
3. One-time setup by the maintainer: register the trusted publisher on PyPI (project `agentlint`, owner `joshgreenwell`, repository `ai-kits`, workflow `agentlint.yml`, environment `pypi`) and create the `pypi` environment in the repository settings.
4. Verify from a fresh directory: `uvx agentlint --version` and `uvx agentlint analyze <fixture>`.

## Releasing the `observatory` companion

1. Bump `version` under `[workspace.package]` in `kit-board/companion/Cargo.toml`, date the entry in `kit-board/companion/CHANGELOG.md`, merge to `main`.
2. Tag the merge commit `observatory-v<version>` and push the tag. cargo-dist's generated `release` workflow (`.github/workflows/release.yml`, owned by `dist generate`; configuration in `dist-workspace.toml`) builds every target on a native runner, publishes the GitHub Release with SHA-256 checksums and artifact attestations, pushes the Homebrew formula to `joshgreenwell/homebrew-tap` (secret `HOMEBREW_TAP_TOKEN`, scoped to that repository), and produces the shell and PowerShell installers.
3. Update `joshgreenwell/scoop-bucket` from `kit-board/companion/packaging/scoop/observatory.json`; the manifest carries `checkver` and `autoupdate`.
4. Verify from a fresh machine: `brew install joshgreenwell/tap/observatory` or `scoop install observatory`, then `observatory version`.
