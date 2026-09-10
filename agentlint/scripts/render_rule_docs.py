"""Render ``docs/rules/<RULE_ID>.md`` (and an index) from the generic rules' metadata.

Usage, from inside ``agentlint/``::

    uv run python scripts/render_rule_docs.py          # write the files
    uv run python scripts/render_rule_docs.py --check  # exit 1 if any file differs

The committed docs are checked against this output by ``tests/test_rule_docs.py``
so they can never drift from the metadata. This script never touches the
network and writes only under ``docs/rules``.
"""

from __future__ import annotations

import sys
from pathlib import Path

from agentlint.rules.base import render_rule_doc, validate_meta
from agentlint.rules.generic import GENERIC_RULES

DOCS_DIR = Path(__file__).resolve().parents[1] / "docs" / "rules"
INDEX_NAME = "README.md"


def render_index() -> str:
    """The rule index page: one line per generic rule with its category and tier."""
    lines = [
        "# Generic rules",
        "",
        "Generated from rule metadata by `scripts/render_rule_docs.py`; do not edit by hand.",
        "",
        "| Rule | Category | Tier / Confidence | Requirements |",
        "| -- | -- | -- | -- |",
    ]
    for rule in GENERIC_RULES:
        meta = rule.meta
        requirements = ", ".join(f"`{r}`" for r in meta.requirements) or "none"
        lines.append(
            f"| [{meta.id}]({meta.id}.md) | {meta.category} | "
            f"{meta.tier} / {meta.confidence} | {requirements} |"
        )
    lines.append("")
    lines.append(
        "Generic rules never read `Event.scope` beyond the neutral `agentlint` tag "
        "namespace; app-specific rules read their own namespace only "
        "(see `examples/rules/grouped_request_scope_loss.py`)."
    )
    return "\n".join(lines) + "\n"


def render_all() -> dict[str, str]:
    """File name to Markdown content for every generic rule plus the index."""
    files: dict[str, str] = {}
    for rule in GENERIC_RULES:
        validate_meta(rule.meta)
        files[f"{rule.meta.id}.md"] = render_rule_doc(rule.meta)
    files[INDEX_NAME] = render_index()
    return files


def main(argv: list[str] | None = None) -> int:
    """Write (default) or check (``--check``) the rendered docs; return an exit status."""
    args = list(sys.argv[1:] if argv is None else argv)
    check = "--check" in args
    files = render_all()
    stale: list[str] = []
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    for name in sorted(files):
        path = DOCS_DIR / name
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if current == files[name]:
            continue
        if check:
            stale.append(name)
        else:
            path.write_text(files[name], encoding="utf-8")
            print(f"wrote {path}")
    if stale:
        print("stale rule docs: " + ", ".join(stale) + " (run scripts/render_rule_docs.py)")
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
