"""Renderers for the analysis document (plan §2.8).

All three read the same document produced by :func:`agentlint.analysis.Analysis.to_dict`
and print, in this order: everything that could not be loaded (``incomplete``),
then per run the coverage block, the findings (one per pattern, evidence
collapsed, thresholds and tier / confidence shown) and the run stats.
``incomplete`` is never rendered as "clean" or "no findings".

Nothing here reads content: the document holds identifiers, hashes, counts
and sizes, plus redacted snippets only when they were explicitly requested.
"""

from __future__ import annotations

from agentlint.render.json import render_json
from agentlint.render.markdown import render_markdown
from agentlint.render.text import render_text

FORMATS: tuple[str, ...] = ("text", "json", "md")
"""Accepted ``--format`` values."""


def render(document: dict, output_format: str) -> str:
    """Render ``document`` in ``output_format`` (``text``, ``json`` or ``md``)."""
    if output_format == "text":
        return render_text(document)
    if output_format == "json":
        return render_json(document)
    if output_format == "md":
        return render_markdown(document)
    raise ValueError(f"unknown format {output_format!r}; valid formats: {', '.join(FORMATS)}")


__all__ = ["FORMATS", "render", "render_json", "render_markdown", "render_text"]
