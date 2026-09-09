# Contributing

## Layout

* `agentlint/` — Kit 1, Python. Run `cd agentlint && uv run pytest`.
* `agent-surface/` — Kit 2, TypeScript. Run `cd agent-surface && npm ci && npm test`.

The kits never import from each other. Fixtures, docs, and CI live inside each kit directory. Root-level files are limited to this file, the README, the license, and CI workflow definitions under `.github/`.

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
