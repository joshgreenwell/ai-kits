"""OTLP JSON Lines loader (``otlp-jsonl``, plan §2.3, story TL-B2).

Record convention: one OTLP/JSON ``resourceSpans`` envelope per line, exactly
as the OpenTelemetry Collector file exporter writes it. Blank lines and a
trailing newline are tolerated. Locators are
``"<file>:<line>#/resourceSpans/i/scopeSpans/j/spans/k"`` (line numbers start
at 1).

Everything after the line split — attribute mapping, span classification,
run grouping, multi-file merge and dedup — is shared with
:mod:`agentlint.loaders.otlp_json`.

What this loader never does:

* never gives up on a file because one line is bad: the line is recorded in
  ``coverage.truncation_notes`` with file and line number, the affected runs
  are marked ``incomplete``, and every other line still loads;
* never opens a path outside the ones it was given;
* never counts the same span twice when exporter rotation wrote it into two
  files — the duplicate is collapsed and counted in ``events_dropped_dedup``.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from agentlint.loaders.base import LoadError, LoadResult
from agentlint.loaders.otlp_json import (
    OtlpConfig,
    Problem,
    SpanCollection,
    build_runs,
    collect_envelope,
    read_head,
    resolve_input_files,
)

FORMAT_LABEL = "otlp-jsonl"

_ENVELOPE_MARKERS = ('"resourceSpans"', '"instrumentationLibrarySpans"')


def detect(path: str | Path) -> bool:
    """Cheap sniff: the first non-blank line is a complete JSON object mentioning
    ``resourceSpans``. A pretty-printed envelope (first line ``{``) is left to
    ``otlp-json``. Never raises.
    """
    try:
        head = read_head(Path(path))
    except OSError:
        return False
    first_line, newline, _rest = head.partition("\n")
    first_line = first_line.strip()
    if not first_line.startswith("{") or not any(m in first_line for m in _ENVELOPE_MARKERS):
        return False
    if not newline and len(head) >= 65535:
        return True  # a single line longer than the sniffed head: accept on shape
    try:
        return isinstance(json.loads(first_line), dict)
    except ValueError:
        return False


def collect_jsonl_file(label: str, path: Path, collection: SpanCollection) -> None:
    """Parse one JSON Lines file into ``collection``, one envelope per line.

    A line that is not valid JSON becomes a truncation :class:`Problem` for
    that file (``"<file>:<line>"``); the remaining lines are still parsed.
    """
    try:
        with path.open(encoding="utf-8-sig") as handle:
            lines = handle.readlines()
    except (OSError, UnicodeDecodeError) as exc:
        collection.errors.append(LoadError(path=label, reason=f"cannot read file: {exc}"))
        return
    collection.files.append(label)
    for number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        locator = f"{label}:{number}"
        try:
            envelope = json.loads(line)
        except ValueError as exc:
            message = exc.msg if isinstance(exc, json.JSONDecodeError) else str(exc)
            collection.problems.append(
                Problem(
                    file=label,
                    locator=locator,
                    reason=f"line {number} is not valid JSON ({message}); line skipped",
                    truncation=True,
                )
            )
            continue
        collect_envelope(envelope, label, f"{locator}#", collection)


def load(
    paths: str | Path | Iterable[str | Path], config: Mapping[str, Any] | None = None
) -> LoadResult:
    """Load OTLP JSON Lines files or a directory of them into normalized runs.

    Accepts the same ``config`` keys as :func:`agentlint.loaders.otlp_json.load`.
    Runs split across files (or repeated across rotated files) are merged by
    run ID and deduplicated by span ID.
    """
    options = OtlpConfig.from_mapping(config)
    files, errors = resolve_input_files(paths, detect)
    collection = SpanCollection(errors=errors)
    for label, path in files:
        collect_jsonl_file(label, path, collection)
    runs, errors = build_runs(collection, options, FORMAT_LABEL)
    return LoadResult(format_label=FORMAT_LABEL, runs=runs, errors=errors)
