"""OTLP/JSON trace export loader (``otlp-json``, plan §2.3, story TL-B1).

Reads one or more OTLP/JSON files (or a directory of them), walks the
``resourceSpans`` envelope, maps ``gen_ai.*`` attributes through
:mod:`agentlint.loaders.otlp_mapping`, groups spans into runs by the
documented run-ID fallback and merges runs across files.

Identity: ``Event.id`` is the span ID as written in the export (a hex string,
leading zeros kept); the trace ID is kept in ``Event.scope["otlp"]``.
``source_locator`` is ``"<file>#/resourceSpans/i/scopeSpans/j/spans/k"``.

What this loader never does:

* never opens a path outside the ones it was given;
* never crashes on a malformed record — the run is marked ``incomplete`` with
  a reason and a JSON-pointer locator, or the file becomes a ``LoadError``;
* never assumes the run ID equals the trace ID without flagging it;
* never coerces integers through floats; nanosecond timestamps stay exact in
  ``raw_records`` and ``start_ms`` is integer floor division;
* never stores content: arguments and results become fingerprints and sizes.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentlint.dedup import merge_runs, normalize_run
from agentlint.fingerprint import fingerprint, utf8_length
from agentlint.loaders.base import LoadError, LoadResult
from agentlint.loaders.otlp_mapping import (
    RUN_ID_SOURCE_TRACE,
    USAGE_FIELDS,
    classify_span,
    content_from_span_events,
    decode_attributes,
    event_status,
    extract_mapped_fields,
    nanos_to_millis,
    parse_int_exact,
    parse_span_status,
    parse_unix_nano,
    run_id_from_attributes,
    unknown_gen_ai_attributes,
)
from agentlint.model import Coverage, CoverageNote, Event, Fingerprint, Run, replace_run
from agentlint.tokens import DEFAULT_TOKEN_CONFIG, TokenConfig

FORMAT_LABEL = "otlp-json"

SCOPE_NAMESPACE = "otlp"
"""``Event.scope`` namespace holding ``trace_id`` and ``operation_name``."""

_HEAD_BYTES = 65536
_ENVELOPE_MARKERS = ('"resourceSpans"', '"instrumentationLibrarySpans"')


# --- Configuration ---------------------------------------------------------


@dataclass(frozen=True, slots=True)
class OtlpConfig:
    """Loader options, built from the ``config`` mapping passed to :func:`load`.

    ``run_id_attribute`` is the app attribute (span first, then resource) that
    names the run; ``token_basis`` is recorded on model calls that carry usage
    (``None`` when the caller does not know what the instrumentation counts);
    ``token_config`` feeds normalization.
    """

    run_id_attribute: str | None = None
    token_basis: str | None = None
    token_config: TokenConfig = DEFAULT_TOKEN_CONFIG

    @classmethod
    def from_mapping(cls, config: Mapping[str, Any] | None) -> OtlpConfig:
        if config is None:
            return cls()
        token_config = config.get("token_config", DEFAULT_TOKEN_CONFIG)
        return cls(
            run_id_attribute=config.get("run_id_attribute") or None,
            token_basis=config.get("token_basis") or None,
            token_config=token_config if isinstance(token_config, TokenConfig) else TokenConfig(),
        )


# --- Intermediate records --------------------------------------------------


@dataclass(slots=True)
class ParsedSpan:
    """One span after decoding, before it becomes an :class:`Event`."""

    file: str
    locator: str
    trace_id: str
    span_id: str
    parent_span_id: str | None
    name: str | None
    attributes: dict[str, Any]
    resource_attributes: dict[str, Any]
    fields: dict[str, Any]
    start_ns: int | None
    end_ns: int | None
    status: str
    span_events: list[dict[str, Any]]
    dropped_attributes_count: int
    raw: Any
    problems: list[str] = field(default_factory=list)

    @property
    def key(self) -> tuple[str, str]:
        return (self.trace_id, self.span_id)


@dataclass(frozen=True, slots=True)
class Problem:
    """A parse problem that could not be attached to one span.

    ``trace_id`` narrows it to the runs containing that trace when known;
    ``truncation`` marks line-level failures that also go to
    ``coverage.truncation_notes``.
    """

    file: str
    locator: str
    reason: str
    trace_id: str | None = None
    truncation: bool = False

    @property
    def text(self) -> str:
        return f"{self.locator}: {self.reason}"


@dataclass(slots=True)
class SpanCollection:
    """Everything the envelope walker gathered from the input files."""

    spans: list[ParsedSpan] = field(default_factory=list)
    problems: list[Problem] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    errors: list[LoadError] = field(default_factory=list)


# --- File resolution -------------------------------------------------------


def _as_paths(paths: str | Path | Iterable[str | Path]) -> list[Path]:
    if isinstance(paths, str | Path):
        return [Path(paths)]
    return [Path(p) for p in paths]


def resolve_input_files(
    paths: str | Path | Iterable[str | Path], sniff: Any
) -> tuple[list[tuple[str, Path]], list[LoadError]]:
    """Expand the given files and directories into ``(label, path)`` pairs.

    A file is taken as given; a directory contributes its direct children
    (sorted by name) for which ``sniff(path)`` is true. Nothing outside the
    given paths is ever listed. Missing paths and empty directories become
    :class:`LoadError` entries.
    """
    files: list[tuple[str, Path]] = []
    errors: list[LoadError] = []
    for given in _as_paths(paths):
        if given.is_dir():
            children = sorted(
                (child for child in given.iterdir() if child.is_file() and sniff(child)),
                key=lambda p: p.name,
            )
            if not children:
                errors.append(LoadError(path=str(given), reason="directory has no matching files"))
            files.extend((str(given / child.name), child) for child in children)
        elif given.is_file():
            files.append((str(given), given))
        else:
            errors.append(LoadError(path=str(given), reason="path does not exist"))
    return files, errors


def read_head(path: Path) -> str:
    with path.open("rb") as handle:
        head = handle.read(_HEAD_BYTES)
    return head.decode("utf-8", errors="ignore").lstrip("﻿ \t\r\n")


def detect(path: str | Path) -> bool:
    """Cheap sniff: a JSON object mentioning ``resourceSpans``, not line-delimited.

    A file whose first line is a complete JSON object followed by more content
    is JSON Lines and is left to ``otlp-jsonl``. A single-line envelope is
    accepted by both loaders. Never raises.
    """
    try:
        head = read_head(Path(path))
    except OSError:
        return False
    if not head.startswith("{") or not any(m in head for m in _ENVELOPE_MARKERS):
        return False
    first_line, newline, rest = head.partition("\n")
    if newline and rest.strip():
        try:
            json.loads(first_line)
        except ValueError:
            return True
        return False
    return True


# --- Envelope walking ------------------------------------------------------


def _string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _decode_span_events(raw_events: Any, problems: list[str]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    if raw_events is None:
        return events
    if not isinstance(raw_events, list):
        problems.append("events: must be an array")
        return events
    for index, raw in enumerate(raw_events):
        if not isinstance(raw, Mapping):
            problems.append(f"events/{index}: not an object")
            continue
        attributes, attr_problems = decode_attributes(raw.get("attributes"))
        problems.extend(f"events/{index}/{p}" for p in attr_problems)
        events.append({"name": raw.get("name"), "attributes": attributes})
    return events


def parse_span(
    raw: Any, file: str, locator: str, resource_attributes: Mapping[str, Any]
) -> ParsedSpan | Problem:
    """Decode one raw span object; a span without IDs is a :class:`Problem`."""
    if not isinstance(raw, Mapping):
        return Problem(file=file, locator=locator, reason="span is not an object")
    trace_id = _string_or_none(raw.get("traceId"))
    if trace_id is None:
        return Problem(file=file, locator=locator, reason="malformed span: missing traceId")
    span_id = _string_or_none(raw.get("spanId"))
    if span_id is None:
        return Problem(
            file=file, locator=locator, reason="malformed span: missing spanId", trace_id=trace_id
        )
    problems: list[str] = []
    attributes, attr_problems = decode_attributes(raw.get("attributes"))
    problems.extend(attr_problems)
    fields, field_problems = extract_mapped_fields(attributes)
    problems.extend(field_problems)
    timestamps: dict[str, int | None] = {}
    for name in ("startTimeUnixNano", "endTimeUnixNano"):
        try:
            timestamps[name] = parse_unix_nano(raw.get(name))
        except ValueError as exc:
            timestamps[name] = None
            problems.append(f"{name}: {exc}")
    dropped = 0
    if raw.get("droppedAttributesCount") is not None:
        try:
            dropped = parse_int_exact(raw.get("droppedAttributesCount"))
        except ValueError as exc:
            problems.append(f"droppedAttributesCount: {exc}")
    return ParsedSpan(
        file=file,
        locator=locator,
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=_string_or_none(raw.get("parentSpanId")),
        name=_string_or_none(raw.get("name")),
        attributes=attributes,
        resource_attributes=dict(resource_attributes),
        fields=fields,
        start_ns=timestamps["startTimeUnixNano"],
        end_ns=timestamps["endTimeUnixNano"],
        status=parse_span_status(raw.get("status")),
        span_events=_decode_span_events(raw.get("events"), problems),
        dropped_attributes_count=dropped,
        raw=raw,
        problems=problems,
    )


def collect_envelope(
    envelope: Any, file: str, pointer_prefix: str, collection: SpanCollection
) -> int:
    """Walk one ``resourceSpans`` envelope into ``collection``; returns spans found.

    ``pointer_prefix`` is what precedes the JSON pointer in locators
    (``"<file>#"`` for a JSON file, ``"<file>:<line>#"`` for a JSONL line).
    Structural problems are recorded, never raised.
    """
    found = 0
    if not isinstance(envelope, Mapping):
        collection.problems.append(
            Problem(file=file, locator=pointer_prefix, reason="envelope is not an object")
        )
        return found
    resource_spans = envelope.get("resourceSpans")
    if resource_spans is None:
        collection.problems.append(
            Problem(file=file, locator=pointer_prefix, reason="envelope has no resourceSpans")
        )
        return found
    if not isinstance(resource_spans, list):
        collection.problems.append(
            Problem(file=file, locator=f"{pointer_prefix}/resourceSpans", reason="not an array")
        )
        return found
    for i, resource_span in enumerate(resource_spans):
        rs_pointer = f"{pointer_prefix}/resourceSpans/{i}"
        if not isinstance(resource_span, Mapping):
            collection.problems.append(
                Problem(file=file, locator=rs_pointer, reason="not an object")
            )
            continue
        resource = resource_span.get("resource")
        resource_attributes: dict[str, Any] = {}
        if isinstance(resource, Mapping):
            resource_attributes, problems = decode_attributes(resource.get("attributes"))
            for problem in problems:
                collection.problems.append(
                    Problem(
                        file=file,
                        locator=f"{rs_pointer}/resource/{problem}",
                        reason="undecodable resource attribute",
                    )
                )
        scope_key = "scopeSpans" if "scopeSpans" in resource_span else "instrumentationLibrarySpans"
        scope_spans = resource_span.get(scope_key)
        if not isinstance(scope_spans, list):
            collection.problems.append(
                Problem(file=file, locator=f"{rs_pointer}/{scope_key}", reason="not an array")
            )
            continue
        for j, scope_span in enumerate(scope_spans):
            ss_pointer = f"{rs_pointer}/{scope_key}/{j}"
            if not isinstance(scope_span, Mapping):
                collection.problems.append(
                    Problem(file=file, locator=ss_pointer, reason="not an object")
                )
                continue
            spans = scope_span.get("spans")
            if not isinstance(spans, list):
                collection.problems.append(
                    Problem(file=file, locator=f"{ss_pointer}/spans", reason="not an array")
                )
                continue
            for k, raw in enumerate(spans):
                parsed = parse_span(raw, file, f"{ss_pointer}/spans/{k}", resource_attributes)
                if isinstance(parsed, Problem):
                    collection.problems.append(parsed)
                else:
                    collection.spans.append(parsed)
                    found += 1
    return found


def collect_json_file(label: str, path: Path, collection: SpanCollection) -> None:
    """Parse one OTLP/JSON file into ``collection``; unreadable input is a ``LoadError``."""
    try:
        with path.open(encoding="utf-8-sig") as handle:
            envelope = json.load(handle)
    except json.JSONDecodeError as exc:
        collection.errors.append(
            LoadError(
                path=label,
                reason=f"invalid JSON: {exc.msg}",
                locator=f"{label}:{exc.lineno}:{exc.colno}",
            )
        )
        return
    except (OSError, UnicodeDecodeError) as exc:
        collection.errors.append(LoadError(path=label, reason=f"cannot read file: {exc}"))
        return
    collection.files.append(label)
    collect_envelope(envelope, label, f"{label}#", collection)


# --- Run building ----------------------------------------------------------


def _content_value(value: Any) -> Any:
    """Parse JSON-encoded content so key order does not change its fingerprint."""
    if isinstance(value, str):
        stripped = value.strip()
        if stripped[:1] in ("{", "["):
            try:
                return json.loads(stripped)
            except ValueError:
                return value
    return value


def _content_fingerprint(value: Any) -> Fingerprint | None:
    return None if value is None else fingerprint(_content_value(value), "full")


class _Tree:
    """Parent / child index over the unique spans of the whole input."""

    def __init__(self, spans: Iterable[ParsedSpan]) -> None:
        self.by_key: dict[tuple[str, str], ParsedSpan] = {}
        self.children: dict[tuple[str, str], list[tuple[str, str]]] = {}
        for span in spans:
            if span.key in self.by_key:
                continue
            self.by_key[span.key] = span
        for key, span in self.by_key.items():
            if span.parent_span_id is not None:
                parent = (span.trace_id, span.parent_span_id)
                self.children.setdefault(parent, []).append(key)
        self._kind: dict[tuple[str, str], str] = {}
        self._descendants: dict[tuple[str, str], int] = {}
        self._run: dict[tuple[str, str], tuple[str, str]] = {}

    def model_call_descendants(self, key: tuple[str, str]) -> int:
        if key in self._descendants:
            return self._descendants[key]
        self._descendants[key] = 0  # cycle guard: a re-entered node counts nothing
        total = 0
        for child in self.children.get(key, []):
            total += 1 if self.kind(child) == "model_call" else self.model_call_descendants(child)
        self._descendants[key] = total
        return total

    def kind(self, key: tuple[str, str]) -> str:
        if key not in self._kind:
            span = self.by_key[key]
            self._kind[key] = classify_span(
                span.attributes, span.fields, self.model_call_descendants(key)
            )
        return self._kind[key]

    def _own_run(self, key: tuple[str, str], config: OtlpConfig) -> tuple[str, str] | None:
        span = self.by_key[key]
        return run_id_from_attributes(
            span.attributes, span.resource_attributes, config.run_id_attribute
        )

    def run_of(self, key: tuple[str, str], config: OtlpConfig) -> tuple[str, str]:
        """``(run_id, source)``: own attributes, then ancestors, then the single
        run ID of the trace, then the trace ID (flagged by the caller)."""
        if key in self._run:
            return self._run[key]
        seen: set[tuple[str, str]] = set()
        current: tuple[str, str] | None = key
        found: tuple[str, str] | None = None
        while current is not None and current in self.by_key and current not in seen:
            seen.add(current)
            found = self._own_run(current, config)
            if found is not None:
                break
            parent_id = self.by_key[current].parent_span_id
            current = None if parent_id is None else (current[0], parent_id)
        if found is None:
            trace_runs = {
                own
                for other in self.by_key
                if other[0] == key[0] and (own := self._own_run(other, config)) is not None
            }
            if len(trace_runs) == 1:
                found = next(iter(trace_runs))
        if found is None:
            found = (key[0], RUN_ID_SOURCE_TRACE)
        self._run[key] = found
        return found


def _has_result(kind: str, fields: Mapping[str, Any], result: Any) -> bool:
    if kind == "tool_call":
        return result is not None
    if kind in ("model_call", "aggregate"):
        return fields.get("finish_reason") is not None or fields.get("tokens_out") is not None
    return False


def build_event(span: ParsedSpan, kind: str, config: OtlpConfig) -> Event:
    """Turn a decoded span into an :class:`Event` (pure; no I/O)."""
    fields = span.fields
    result = fields.get("tool_result")
    if result is None:
        result = content_from_span_events(span.span_events, "tool_result")
    args = fields.get("tool_args")
    start_ms = nanos_to_millis(span.start_ns)
    end_ms = nanos_to_millis(span.end_ns)
    has_usage = any(fields.get(name) is not None for name in USAGE_FIELDS)
    scope: dict[str, Any] = {"trace_id": span.trace_id}
    if fields.get("operation_name") is not None:
        scope["operation_name"] = fields["operation_name"]
    name = span.name
    if kind == "tool_call" and fields.get("tool_name") is not None:
        name = fields["tool_name"]
    return Event(
        id=span.span_id,
        source_locator=span.locator,
        kind=kind,
        status=event_status(span.status, _has_result(kind, fields, result)),
        parent_id=span.parent_span_id,
        seq=None,
        name=name,
        model=fields.get("model"),
        provider=fields.get("provider"),
        adapter=None,
        token_basis=(
            config.token_basis if kind in ("model_call", "aggregate") and has_usage else None
        ),
        start_ms=start_ms,
        end_ms=end_ms,
        duration_ms=(end_ms - start_ms if start_ms is not None and end_ms is not None else None),
        error_type=fields.get("error_type"),
        error_code=None,
        tokens_in=fields.get("tokens_in"),
        tokens_out=fields.get("tokens_out"),
        tokens_total=fields.get("tokens_total"),
        cache_read_tokens=fields.get("cache_read_tokens"),
        cache_write_tokens=fields.get("cache_write_tokens"),
        finish_reason=fields.get("finish_reason"),
        tool_call_id=fields.get("tool_call_id"),
        native_tool_call_id=None,
        args_fingerprint=_content_fingerprint(args),
        result_fingerprint=_content_fingerprint(result),
        result_bytes=None if result is None else utf8_length(result),
        preview_bytes=None,
        scope={SCOPE_NAMESPACE: scope},
        included_result_ids=[],
    )


@dataclass(slots=True)
class _RunInfo:
    """Per-run facts gathered while grouping, turned into notes after merging."""

    trace_ids: set[str] = field(default_factory=set)
    trace_fallback_ids: set[str] = field(default_factory=set)
    unknown_attributes: set[str] = field(default_factory=set)
    usage_absent_ids: list[str] = field(default_factory=list)
    dropped_attribute_ids: list[str] = field(default_factory=list)
    conversation_ids: set[str] = field(default_factory=set)


def _min_or_none(values: Iterable[int | None]) -> int | None:
    present = [v for v in values if v is not None]
    return min(present) if present else None


def _max_or_none(values: Iterable[int | None]) -> int | None:
    present = [v for v in values if v is not None]
    return max(present) if present else None


def _unique(items: Iterable[str]) -> list[str]:
    seen: list[str] = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen


def _run_notes(run_id: str, info: _RunInfo, config: OtlpConfig) -> list[CoverageNote]:
    notes: list[CoverageNote] = []
    if info.trace_fallback_ids:
        app = f"{config.run_id_attribute!r}" if config.run_id_attribute else "no app attribute"
        notes.append(
            CoverageNote(
                code="run_id_fallback_trace_id",
                message=(
                    f"run id {run_id} is the trace ID: {app} configured and "
                    "gen_ai.conversation.id absent on every span of the trace"
                ),
                fields=["run_id", "conversation_id"],
                event_ids=sorted(info.trace_fallback_ids),
            )
        )
    if len(info.conversation_ids) > 1:
        notes.append(
            CoverageNote(
                code="conversation_id_conflict",
                message=(
                    f"run {run_id}: spans carry {len(info.conversation_ids)} different "
                    "gen_ai.conversation.id values; the first in sort order was kept"
                ),
                fields=["conversation_id"],
            )
        )
    if info.unknown_attributes:
        names = sorted(info.unknown_attributes)
        notes.append(
            CoverageNote(
                code="unknown_gen_ai_attributes",
                message="ignored unmapped gen_ai.* attributes: " + ", ".join(names),
                fields=names,
            )
        )
    if info.usage_absent_ids:
        notes.append(
            CoverageNote(
                code="usage_absent",
                message=(
                    f"{len(info.usage_absent_ids)} model call(s) report no usage; "
                    "token counts are None, never zero"
                ),
                fields=list(USAGE_FIELDS),
                event_ids=sorted(info.usage_absent_ids),
            )
        )
    if info.dropped_attribute_ids:
        notes.append(
            CoverageNote(
                code="dropped_attributes",
                message=(
                    f"{len(info.dropped_attribute_ids)} span(s) report droppedAttributesCount > 0; "
                    "the exporter discarded attributes before this tool saw them"
                ),
                event_ids=sorted(info.dropped_attribute_ids),
            )
        )
    return notes


def build_runs(
    collection: SpanCollection, config: OtlpConfig, format_label: str
) -> tuple[list[Run], list[LoadError]]:
    """Group collected spans into runs, merge across files, and normalize.

    Spans are classified over the whole input (a wrapper in one file sees its
    children in another), grouped per ``(file, run_id)`` so file-level
    problems attach to the right runs, merged with
    :func:`agentlint.dedup.merge_runs`, annotated, and normalized with
    :func:`agentlint.dedup.normalize_run`. Runs come back sorted by ID; files
    that yielded no run become ``LoadError`` entries.
    """
    tree = _Tree(collection.spans)
    groups: dict[tuple[str, str], list[ParsedSpan]] = {}
    infos: dict[str, _RunInfo] = {}
    for span in collection.spans:
        run_id, source = tree.run_of(span.key, config)
        groups.setdefault((span.file, run_id), []).append(span)
        info = infos.setdefault(run_id, _RunInfo())
        info.trace_ids.add(span.trace_id)
        if source == RUN_ID_SOURCE_TRACE:
            info.trace_fallback_ids.add(span.span_id)
        info.unknown_attributes.update(unknown_gen_ai_attributes(span.attributes))
        kind = tree.kind(span.key)
        if kind == "model_call" and all(span.fields.get(n) is None for n in USAGE_FIELDS):
            info.usage_absent_ids.append(span.span_id)
        if span.dropped_attributes_count > 0:
            info.dropped_attribute_ids.append(span.span_id)
        conversation = span.fields.get("conversation_id")
        if conversation is not None:
            info.conversation_ids.add(conversation)

    partial_runs: list[Run] = []
    for (file, run_id), spans in groups.items():
        events = [build_event(span, tree.kind(span.key), config) for span in spans]
        traces = {span.trace_id for span in spans}
        reasons = [f"{span.locator}: {problem}" for span in spans for problem in span.problems]
        truncation_notes: list[str] = []
        for problem in collection.problems:
            if problem.file != file:
                continue
            if problem.trace_id is not None and problem.trace_id not in traces:
                continue
            reasons.append(problem.text)
            if problem.truncation:
                truncation_notes.append(problem.text)
        conversation_ids = sorted(
            c for span in spans if (c := span.fields.get("conversation_id")) is not None
        )
        partial_runs.append(
            Run(
                id=run_id,
                source_format=format_label,
                conversation_id=conversation_ids[0] if conversation_ids else None,
                source_refs=[file],
                started_at=_min_or_none(e.start_ms for e in events),
                ended_at=_max_or_none(e.end_ms for e in events),
                coverage=Coverage(
                    reasons=_unique(reasons), truncation_notes=_unique(truncation_notes)
                ),
                events=events,
                raw_records=[{"source_locator": span.locator, "span": span.raw} for span in spans],
            )
        )

    runs: list[Run] = []
    for merged in merge_runs(partial_runs):
        notes = [*merged.coverage.notes, *_run_notes(merged.id, infos[merged.id], config)]
        annotated = replace_run(
            merged,
            coverage=Coverage(
                truncated=merged.coverage.truncated,
                truncation_notes=list(merged.coverage.truncation_notes),
                reasons=list(merged.coverage.reasons),
                notes=notes,
            ),
        )
        runs.append(normalize_run(annotated, config.token_config))
    runs.sort(key=lambda r: r.id)

    errors = list(collection.errors)
    files_with_runs = {file for (file, _run_id) in groups}
    for file in collection.files:
        if file in files_with_runs:
            continue
        first = next((p for p in collection.problems if p.file == file), None)
        errors.append(
            LoadError(
                path=file,
                reason=first.reason if first else "no spans found",
                locator=first.locator if first else None,
            )
        )
    return runs, errors


# --- Entry point -----------------------------------------------------------


def load(
    paths: str | Path | Iterable[str | Path], config: Mapping[str, Any] | None = None
) -> LoadResult:
    """Load OTLP/JSON files or a directory of them into normalized runs.

    ``config`` keys: ``run_id_attribute`` (app attribute naming the run),
    ``token_basis`` (recorded on model calls with usage), ``token_config``
    (a :class:`agentlint.tokens.TokenConfig`). See the module docstring for
    what this loader never does.
    """
    options = OtlpConfig.from_mapping(config)
    files, errors = resolve_input_files(paths, detect)
    collection = SpanCollection(errors=errors)
    for label, path in files:
        collect_json_file(label, path, collection)
    runs, errors = build_runs(collection, options, FORMAT_LABEL)
    return LoadResult(format_label=FORMAT_LABEL, runs=runs, errors=errors)
