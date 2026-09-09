"""Langfuse Observations API export loader (``langfuse-observations``, plan §2.3).

Reads rows exported from the Langfuse *Observations* API — the v2 endpoint's
field groups ``core,basic,time,io,metadata,model,usage,trace_context`` — as a
JSON array (or an API page object with a ``data`` list), JSONL (one
observation per line) or CSV (one observation per row). This is **not** OTLP;
rows are joined on Langfuse's own identifiers:

* observation ``id`` → :attr:`Event.id`, ``parentObservationId`` → ``parent_id``;
* ``traceId`` → :attr:`Run.id` (one run per trace), ``sessionId`` → ``conversation_id``.

Targets the current (v2) Observations API shape, whose usage lives in
``usageDetails`` (``input`` / ``output`` / ``total`` plus provider detail
keys such as ``input_cached_tokens``). The older shape (``promptTokens`` /
``completionTokens`` / ``totalTokens``, or a ``usage`` object with ``unit``)
is still loaded but reported with a loud coverage note and leaves
``token_basis`` unknown. See ``docs/loaders/langfuse.md``.

What this loader never does:

* never calls the Langfuse API or any network endpoint — files only;
* never copies ``input`` / ``output`` / ``metadata`` / ``statusMessage``
  content into the model — only fingerprints, byte sizes and identifiers;
* never invents an identifier: an observation without ``id`` or ``traceId``
  is skipped and cited by locator;
* never turns absent usage into zero — absent stays ``None``.
"""

from __future__ import annotations

import csv
import io
import json
import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agentlint.dedup import normalize_runs
from agentlint.fingerprint import fingerprint, utf8_length
from agentlint.loaders.base import LoadError, LoadResult
from agentlint.model import (
    TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ,
    Coverage,
    CoverageNote,
    Event,
    Fingerprint,
    Run,
)
from agentlint.tokens import DEFAULT_TOKEN_CONFIG, TokenConfig

FORMAT_LABEL = "langfuse-observations"
"""Format label recorded in ``Run.source_format``."""

SCOPE_NAMESPACE = "langfuse"
"""``Event.scope`` namespace carrying the observation ``type`` and ``level``."""

SUPPORTED_SUFFIXES: frozenset[str] = frozenset({".json", ".jsonl", ".ndjson", ".csv"})

# --- Field vocabulary --------------------------------------------------------

MAPPED_FIELDS: frozenset[str] = frozenset(
    {
        "id",
        "traceId",
        "parentObservationId",
        "type",
        "name",
        "startTime",
        "endTime",
        "model",
        "usageDetails",
        "usage",
        "promptTokens",
        "completionTokens",
        "totalTokens",
        "level",
        "statusMessage",
        "input",
        "output",
        "metadata",
        "sessionId",
        "inputTruncated",
        "outputTruncated",
    }
)
"""Fields the loader maps into the model (or inspects without copying)."""

RECOGNISED_FIELDS: frozenset[str] = frozenset(
    {
        "projectId",
        "environment",
        "version",
        "release",
        "completionStartTime",
        "latency",
        "timeToFirstToken",
        "modelId",
        "modelParameters",
        "promptId",
        "promptName",
        "promptVersion",
        "costDetails",
        "calculatedInputCost",
        "calculatedOutputCost",
        "calculatedTotalCost",
        "inputPrice",
        "outputPrice",
        "totalPrice",
        "inputCost",
        "outputCost",
        "totalCost",
        "unit",
        "traceName",
        "traceTags",
        "traceTimestamp",
        "traceEnvironment",
        "traceVersion",
        "traceRelease",
        "traceMetadata",
        "userId",
        "traceUserId",
        "createdAt",
        "updatedAt",
    }
)
"""Fields known from the Observations API that carry nothing the model needs.
They are ignored silently; anything outside this set and :data:`MAPPED_FIELDS`
is listed once per run in an ``unknown_fields`` coverage note."""

GENERATION_TYPES: frozenset[str] = frozenset({"GENERATION", "EMBEDDING"})
"""Observation types that are model calls (carry ``model`` and usage)."""

TOOL_TYPES: frozenset[str] = frozenset({"TOOL"})
SPAN_TYPES: frozenset[str] = frozenset(
    {"SPAN", "AGENT", "CHAIN", "RETRIEVER", "EVALUATOR", "GUARDRAIL"}
)
"""Span-like types: ``tool_call`` with tool metadata, ``aggregate`` when they
wrap a generation, ``other`` otherwise."""

TOOL_METADATA_KEYS: tuple[str, ...] = (
    "tool",
    "tool_name",
    "toolName",
    "tool_call_id",
    "toolCallId",
    "tool_use_id",
    "toolUseId",
)
"""``metadata`` keys whose presence marks a span as a tool call."""

TOOL_CALL_ID_KEYS: tuple[str, ...] = ("tool_call_id", "toolCallId", "tool_use_id", "toolUseId")
"""``metadata`` keys read (verbatim) into ``Event.tool_call_id``."""

CACHE_READ_DETAIL_KEYS: tuple[str, ...] = (
    "input_cached_tokens",
    "cache_read_input_tokens",
    "input_cache_read",
    "cached_tokens",
)
"""``usageDetails`` keys that report cache-read input tokens."""

CACHE_WRITE_DETAIL_KEYS: tuple[str, ...] = (
    "cache_creation_input_tokens",
    "input_cache_creation",
    "input_cache_write",
)
"""``usageDetails`` keys that report cache-write input tokens."""

LEGACY_TOKEN_FIELDS: tuple[str, ...] = ("promptTokens", "completionTokens", "totalTokens")

_JSON_CELL_FIELDS: frozenset[str] = frozenset(
    {"usageDetails", "usage", "metadata", "input", "output", "modelParameters", "costDetails"}
)
_INT_CELL_FIELDS: frozenset[str] = frozenset(LEGACY_TOKEN_FIELDS)
_BOOL_CELL_FIELDS: frozenset[str] = frozenset({"inputTruncated", "outputTruncated"})
_DETECT_BYTES = 65536


# --- Small pure helpers ------------------------------------------------------


def _as_int(value: Any) -> int | None:
    """An int for ints, integral floats and digit strings; ``None`` otherwise."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if text.lstrip("-").isdigit():
            return int(text)
    return None


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value or None
    return str(value)


def _epoch_ms(value: Any) -> int | None:
    """Epoch milliseconds from an ISO-8601 string or a numeric epoch (ms)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return int(value)
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return round(parsed.timestamp() * 1000)


def _fingerprint_io(value: Any, truncated: bool) -> Fingerprint | None:
    """Fingerprint an ``input`` / ``output`` value; ``None`` when absent or too short."""
    if value is None:
        return None
    return fingerprint(value, "truncated" if truncated else "full")


def _is_truthy_flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return isinstance(value, str) and value.strip().lower() in {"true", "1", "yes"}


# --- Usage -----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Usage:
    shape: str  # "v2" | "legacy" | "absent"
    tokens_in: int | None = None
    tokens_out: int | None = None
    tokens_total: int | None = None
    cache_read: int | None = None
    cache_write: int | None = None
    token_basis: str | None = None
    basis_assumed: bool = False
    ambiguous_cache_keys: tuple[str, ...] = ()
    non_token_unit: str | None = None


def _usage_from_details(details: Mapping[str, Any]) -> _Usage:
    """Map a v2 ``usageDetails`` object.

    Langfuse documents the detail keys as disjoint categories whose sum is
    ``total``; ``input`` therefore excludes any cache-read detail that was
    reported, so the basis is ``input_excludes_cache_read``. When no cache
    detail key is present the same basis is *assumed* (the export cannot
    say whether the integration folded cache reads into ``input``); the
    caller records that assumption in a coverage note.
    """
    tokens_in = _as_int(details.get("input"))
    tokens_out = _as_int(details.get("output"))
    tokens_total = _as_int(details.get("total"))
    read_keys = tuple(k for k in CACHE_READ_DETAIL_KEYS if _as_int(details.get(k)) is not None)
    write_keys = tuple(k for k in CACHE_WRITE_DETAIL_KEYS if _as_int(details.get(k)) is not None)
    cache_read = _as_int(details[read_keys[0]]) if len(read_keys) == 1 else None
    cache_write = _as_int(details[write_keys[0]]) if len(write_keys) == 1 else None
    has_counts = any(v is not None for v in (tokens_in, tokens_out, tokens_total))
    if not has_counts and not read_keys and not write_keys:
        return _Usage(shape="v2")
    return _Usage(
        shape="v2",
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        tokens_total=tokens_total,
        cache_read=cache_read,
        cache_write=cache_write,
        token_basis=TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ,
        basis_assumed=not read_keys,
        ambiguous_cache_keys=read_keys if len(read_keys) > 1 else (),
    )


def _usage_from_legacy(row: Mapping[str, Any]) -> _Usage:
    """Map the older shape: top-level ``*Tokens`` fields or ``usage`` with ``unit``.

    Cache semantics are undocumented for this shape, so ``token_basis`` stays
    ``None``. A non-token ``unit`` (characters, images, ...) yields no counts.
    """
    usage = row.get("usage")
    usage = usage if isinstance(usage, Mapping) else {}
    unit = _as_str(usage.get("unit"))
    if unit is not None and unit.upper() != "TOKENS":
        return _Usage(shape="legacy", non_token_unit=unit)
    tokens_in = _as_int(row.get("promptTokens"))
    if tokens_in is None:
        tokens_in = _as_int(usage.get("input"))
    tokens_out = _as_int(row.get("completionTokens"))
    if tokens_out is None:
        tokens_out = _as_int(usage.get("output"))
    tokens_total = _as_int(row.get("totalTokens"))
    if tokens_total is None:
        tokens_total = _as_int(usage.get("total"))
    if all(v is None for v in (tokens_in, tokens_out, tokens_total)):
        return _Usage(shape="legacy")
    return _Usage(
        shape="legacy", tokens_in=tokens_in, tokens_out=tokens_out, tokens_total=tokens_total
    )


def _usage_of(row: Mapping[str, Any]) -> _Usage:
    """Pick the usage shape a row carries: v2 ``usageDetails`` wins over legacy fields."""
    details = row.get("usageDetails")
    if isinstance(details, Mapping):
        return _usage_from_details(details)
    usage = row.get("usage")
    legacy_present = any(row.get(k) is not None for k in LEGACY_TOKEN_FIELDS)
    if legacy_present or isinstance(usage, Mapping):
        return _usage_from_legacy(row)
    return _Usage(shape="absent")


# --- Rows ----------------------------------------------------------------------


@dataclass(slots=True)
class _Row:
    locator: str
    data: dict[str, Any]


@dataclass(slots=True)
class _Parsed:
    rows: list[_Row] = field(default_factory=list)
    errors: list[LoadError] = field(default_factory=list)
    columns: set[str] = field(default_factory=set)


def _set_dotted(target: dict[str, Any], key: str, value: Any) -> None:
    head, _, rest = key.partition(".")
    if not rest:
        target[head] = value
        return
    nested = target.get(head)
    if not isinstance(nested, dict):
        nested = {}
        target[head] = nested
    _set_dotted(nested, rest, value)


def _csv_cell(column: str, text: str) -> Any:
    """Decode one CSV cell: empty → absent, JSON-looking cells decoded, ints kept."""
    if text == "":
        return None
    base = column.partition(".")[0]
    if base in _JSON_CELL_FIELDS:
        stripped = text.strip()
        if stripped[:1] in '{["' or stripped in {"null", "true", "false"}:
            try:
                return json.loads(stripped)
            except ValueError:
                return text
        if "." in column:
            number = _as_int(stripped)
            return number if number is not None else text
        return text
    if base in _INT_CELL_FIELDS:
        number = _as_int(text)
        return number if number is not None else text
    if base in _BOOL_CELL_FIELDS:
        return _is_truthy_flag(text)
    return text


def _parse_csv(path: str, text: str) -> _Parsed:
    parsed = _Parsed()
    reader = csv.DictReader(io.StringIO(text))
    header = [h for h in (reader.fieldnames or []) if h]
    if not header:
        parsed.errors.append(LoadError(path=path, reason="empty CSV: no header row"))
        return parsed
    parsed.columns.update(h.partition(".")[0] for h in header)
    for index, record in enumerate(reader):
        data: dict[str, Any] = {}
        for column in header:
            value = _csv_cell(column, record.get(column) or "")
            if value is not None:
                _set_dotted(data, column, value)
        parsed.rows.append(_Row(locator=f"{path}#{index}", data=data))
    return parsed


def _parse_jsonl(path: str, text: str) -> _Parsed:
    parsed = _Parsed()
    for index, line in enumerate(text.splitlines()):
        if not line.strip():
            continue
        locator = f"{path}#{index}"
        try:
            value = json.loads(line)
        except ValueError as exc:
            parsed.errors.append(
                LoadError(path=path, reason=f"invalid JSON: {exc}", locator=locator)
            )
            continue
        if not isinstance(value, Mapping):
            parsed.errors.append(
                LoadError(path=path, reason="line is not a JSON object", locator=locator)
            )
            continue
        parsed.rows.append(_Row(locator=locator, data=dict(value)))
        parsed.columns.update(value.keys())
    return parsed


def _parse_json(path: str, text: str) -> _Parsed:
    parsed = _Parsed()
    try:
        value = json.loads(text)
    except ValueError as exc:
        parsed.errors.append(LoadError(path=path, reason=f"invalid JSON: {exc}"))
        return parsed
    pointer = ""
    if isinstance(value, Mapping):
        if isinstance(value.get("data"), list):
            value, pointer = value["data"], "/data"
        elif "id" in value and "traceId" in value:
            value, pointer = [value], ""
        else:
            parsed.errors.append(
                LoadError(path=path, reason="JSON object has no 'data' list of observations")
            )
            return parsed
    if not isinstance(value, list):
        parsed.errors.append(LoadError(path=path, reason="JSON is neither an array nor a page"))
        return parsed
    for index, item in enumerate(value):
        locator = f"{path}#{pointer}/{index}"
        if not isinstance(item, Mapping):
            parsed.errors.append(
                LoadError(path=path, reason="array item is not an object", locator=locator)
            )
            continue
        parsed.rows.append(_Row(locator=locator, data=dict(item)))
        parsed.columns.update(item.keys())
    return parsed


def _parse_file(path: str) -> _Parsed:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return _Parsed(errors=[LoadError(path=path, reason=f"cannot read file: {exc}")])
    suffix = Path(path).suffix.lower()
    if suffix == ".csv":
        return _parse_csv(path, text)
    if suffix in {".jsonl", ".ndjson"}:
        return _parse_jsonl(path, text)
    return _parse_json(path, text)


# --- Observation → Event -------------------------------------------------------


@dataclass(slots=True)
class _Observation:
    row: _Row
    id: str
    trace_id: str
    parent_id: str | None
    type: str
    usage: _Usage
    kind: str = "other"


def _observation(row: _Row) -> _Observation | None:
    data = row.data
    obs_id = _as_str(data.get("id"))
    trace_id = _as_str(data.get("traceId"))
    if obs_id is None or trace_id is None:
        return None
    obs_type = (_as_str(data.get("type")) or "").upper()
    return _Observation(
        row=row,
        id=obs_id,
        trace_id=trace_id,
        parent_id=_as_str(data.get("parentObservationId")),
        type=obs_type,
        usage=_usage_of(data),
    )


def _has_tool_metadata(metadata: Any) -> bool:
    if not isinstance(metadata, Mapping):
        return False
    if any(metadata.get(k) is not None for k in TOOL_METADATA_KEYS):
        return True
    kind = metadata.get("type") or metadata.get("kind")
    return isinstance(kind, str) and kind.lower() == "tool"


def _tool_call_id(metadata: Any) -> str | None:
    if not isinstance(metadata, Mapping):
        return None
    for key in TOOL_CALL_ID_KEYS:
        value = _as_str(metadata.get(key))
        if value is not None:
            return value
    return None


def _assign_kinds(observations: list[_Observation]) -> None:
    """Set ``kind`` per observation; span-like rows wrapping a generation are aggregates."""
    by_id = {o.id: o for o in observations}
    for o in observations:
        if o.type in GENERATION_TYPES:
            o.kind = "model_call"
        elif o.type in TOOL_TYPES or (
            o.type in SPAN_TYPES and _has_tool_metadata(o.row.data.get("metadata"))
        ):
            o.kind = "tool_call"
    wrapping: set[str] = set()
    for o in observations:
        if o.kind != "model_call":
            continue
        seen: set[str] = set()
        parent = o.parent_id
        while parent is not None and parent not in seen and parent in by_id:
            seen.add(parent)
            wrapping.add(parent)
            parent = by_id[parent].parent_id
    for o in observations:
        if o.kind == "other" and o.type in SPAN_TYPES and o.id in wrapping:
            o.kind = "aggregate"


def _status(level: Any) -> str:
    text = _as_str(level)
    if text is None:
        return "unknown"
    return "error" if text.upper() == "ERROR" else "ok"


def _event(o: _Observation) -> Event:
    data = o.row.data
    start_ms = _epoch_ms(data.get("startTime"))
    end_ms = _epoch_ms(data.get("endTime"))
    duration = end_ms - start_ms if start_ms is not None and end_ms is not None else None
    metadata = data.get("metadata")
    truncated_in = _is_truthy_flag(data.get("inputTruncated"))
    truncated_out = _is_truthy_flag(data.get("outputTruncated"))
    output = data.get("output")
    usage = o.usage
    scope_values: dict[str, Any] = {}
    if o.type:
        scope_values["type"] = o.type
    level = _as_str(data.get("level"))
    if level is not None:
        scope_values["level"] = level
    return Event(
        id=o.id,
        source_locator=o.row.locator,
        kind=o.kind,
        status=_status(data.get("level")),
        parent_id=o.parent_id,
        name=_as_str(data.get("name")),
        model=_as_str(data.get("model")),
        token_basis=usage.token_basis,
        start_ms=start_ms,
        end_ms=end_ms,
        duration_ms=duration,
        tokens_in=usage.tokens_in,
        tokens_out=usage.tokens_out,
        tokens_total=usage.tokens_total,
        cache_read_tokens=usage.cache_read,
        cache_write_tokens=usage.cache_write,
        tool_call_id=_tool_call_id(metadata) if o.kind == "tool_call" else None,
        args_fingerprint=_fingerprint_io(data.get("input"), truncated_in),
        result_fingerprint=_fingerprint_io(output, truncated_out),
        result_bytes=None if output is None else utf8_length(output),
        scope={SCOPE_NAMESPACE: scope_values} if scope_values else {},
    )


# --- Trace → Run ---------------------------------------------------------------


def _note(code: str, message: str, fields: list[str], event_ids: list[str]) -> CoverageNote:
    return CoverageNote(code=code, message=message, fields=fields, event_ids=sorted(event_ids))


def _usage_notes(
    observations: list[_Observation], columns: set[str]
) -> tuple[list[CoverageNote], list[str]]:
    """Coverage notes and reasons about usage shape and token basis for one trace."""
    notes: list[CoverageNote] = []
    reasons: list[str] = []
    legacy = [o for o in observations if o.usage.shape == "legacy"]
    if legacy:
        found = sorted(
            {
                k
                for o in legacy
                for k in (*LEGACY_TOKEN_FIELDS, "usage")
                if o.row.data.get(k) is not None
            }
        )
        notes.append(
            _note(
                "legacy_observation_shape",
                f"{len(legacy)} row(s) use the older Observations API shape "
                f"({', '.join(found)}) instead of the targeted v2 shape (usageDetails); "
                "cache semantics are undocumented there, so token_basis is unknown "
                "for these events",
                ["token_basis", "tokens_in", "tokens_out", "tokens_total", "cache_read_tokens"],
                [o.id for o in legacy],
            )
        )
        reasons.append("legacy_observation_shape")
    non_token = [o for o in legacy if o.usage.non_token_unit is not None]
    if non_token:
        units = sorted({o.usage.non_token_unit for o in non_token if o.usage.non_token_unit})
        notes.append(
            _note(
                "usage_unit_not_tokens",
                f"{len(non_token)} row(s) report usage in {', '.join(units)}, not tokens; "
                "their counts were not mapped",
                ["tokens_in", "tokens_out", "tokens_total"],
                [o.id for o in non_token],
            )
        )
    assumed = [o for o in observations if o.usage.basis_assumed]
    if assumed:
        notes.append(
            _note(
                "token_basis_assumed",
                f"{len(assumed)} event(s) carry usageDetails without a cache-read detail key; "
                f"token_basis {TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ} is assumed from the "
                "documented v2 semantics (detail keys are disjoint and sum to total)",
                ["token_basis"],
                [o.id for o in assumed],
            )
        )
    ambiguous = [o for o in observations if o.usage.ambiguous_cache_keys]
    if ambiguous:
        keys = sorted({k for o in ambiguous for k in o.usage.ambiguous_cache_keys})
        notes.append(
            _note(
                "usage_detail_ambiguous",
                f"{len(ambiguous)} event(s) carry more than one cache-read detail key "
                f"({', '.join(keys)}); cache_read_tokens left unknown",
                ["cache_read_tokens"],
                [o.id for o in ambiguous],
            )
        )
    model_calls = [o for o in observations if o.kind == "model_call"]
    without_usage = [o for o in model_calls if o.usage.shape == "absent"]
    if model_calls and len(without_usage) == len(model_calls):
        has_column = bool(columns & {"usageDetails", "usage", *LEGACY_TOKEN_FIELDS})
        where = "present but empty" if has_column else "absent from the export"
        notes.append(
            _note(
                "usage_absent",
                f"no model call carries usage (usage column {where}); token counts are None",
                ["tokens_in", "tokens_out", "tokens_total", "token_basis"],
                [o.id for o in model_calls],
            )
        )
        reasons.append("usage_absent")
    return notes, reasons


def _time_notes(observations: list[_Observation]) -> list[CoverageNote]:
    bad: list[str] = []
    for o in observations:
        for key in ("startTime", "endTime"):
            value = o.row.data.get(key)
            if value is not None and _epoch_ms(value) is None:
                bad.append(o.id)
                break
    if not bad:
        return []
    return [
        _note(
            "unparseable_time",
            f"{len(bad)} row(s) have a startTime/endTime that is not ISO-8601 or epoch; "
            "left unknown",
            ["start_ms", "end_ms"],
            bad,
        )
    ]


def _unknown_fields_note(observations: list[_Observation]) -> list[CoverageNote]:
    unknown = sorted(
        {
            k
            for o in observations
            for k in o.row.data
            if k not in MAPPED_FIELDS and k not in RECOGNISED_FIELDS and not k.startswith("_")
        }
    )
    if not unknown:
        return []
    return [
        CoverageNote(
            code="unknown_fields",
            message="ignored unknown observation field(s): " + ", ".join(unknown),
            fields=[],
        )
    ]


def _build_run(
    trace_id: str,
    observations: list[_Observation],
    skipped: list[tuple[str, str]],
    source_ref: str,
    columns: set[str],
) -> Run:
    _assign_kinds(observations)
    events = [_event(o) for o in observations]
    notes: list[CoverageNote] = []
    reasons: list[str] = []
    session_ids = sorted({s for o in observations if (s := _as_str(o.row.data.get("sessionId")))})
    conversation_id = session_ids[0] if session_ids else None
    if len(session_ids) > 1:
        notes.append(
            CoverageNote(
                code="merge_conflict",
                message=f"run {trace_id}: rows disagree on sessionId; kept the first sorted",
                fields=["conversation_id"],
            )
        )
    if skipped:
        notes.append(
            CoverageNote(
                code="rows_skipped",
                message=f"{len(skipped)} row(s) skipped: "
                + "; ".join(f"{loc} ({why})" for loc, why in skipped),
                fields=[],
            )
        )
        reasons.append("rows_skipped")
    usage_notes, usage_reasons = _usage_notes(observations, columns)
    notes.extend(usage_notes)
    reasons.extend(usage_reasons)
    notes.extend(_time_notes(observations))
    notes.extend(_unknown_fields_note(observations))
    truncated = any(
        _is_truthy_flag(o.row.data.get("inputTruncated"))
        or _is_truthy_flag(o.row.data.get("outputTruncated"))
        for o in observations
    )
    truncation_notes = (
        ["export marks input/output of some observations as truncated"] if truncated else []
    )
    starts = [e.start_ms for e in events if e.start_ms is not None]
    ends = [e.end_ms for e in events if e.end_ms is not None]
    raw_records = [
        {
            "id": o.id,
            "locator": o.row.locator,
            "parentObservationId": o.parent_id,
            "traceId": o.trace_id,
            "type": o.type or None,
        }
        for o in observations
    ]
    return Run(
        id=trace_id,
        source_format=FORMAT_LABEL,
        conversation_id=conversation_id,
        source_refs=[source_ref],
        started_at=min(starts) if starts else None,
        ended_at=max(ends) if ends else None,
        coverage=Coverage(
            truncated=truncated,
            truncation_notes=truncation_notes,
            completeness="incomplete" if reasons or truncated else "complete",
            reasons=reasons,
            notes=notes,
        ),
        events=events,
        raw_records=raw_records,
    )


def _runs_from_file(path: str) -> tuple[list[Run], list[LoadError]]:
    parsed = _parse_file(path)
    errors = list(parsed.errors)
    by_trace: dict[str, list[_Observation]] = {}
    skipped_by_trace: dict[str, list[tuple[str, str]]] = {}
    for row in parsed.rows:
        observation = _observation(row)
        if observation is not None:
            by_trace.setdefault(observation.trace_id, []).append(observation)
            continue
        trace_id = _as_str(row.data.get("traceId"))
        if trace_id is None:
            errors.append(LoadError(path=path, reason="row has no traceId", locator=row.locator))
        else:
            skipped_by_trace.setdefault(trace_id, []).append((row.locator, "row has no id"))
    runs = [
        _build_run(
            trace_id, by_trace[trace_id], skipped_by_trace.get(trace_id, []), path, parsed.columns
        )
        for trace_id in sorted(by_trace)
    ]
    for trace_id in sorted(set(skipped_by_trace) - set(by_trace)):
        for locator, why in skipped_by_trace[trace_id]:
            errors.append(LoadError(path=path, reason=why, locator=locator))
    return runs, errors


# --- Public contract -----------------------------------------------------------


def _expand_paths(paths: str | os.PathLike[str] | Iterable[str | os.PathLike[str]]) -> list[str]:
    if isinstance(paths, str | os.PathLike):
        paths = [paths]
    result: list[str] = []
    for item in paths:
        path = Path(item)
        if path.is_dir():
            result.extend(p.as_posix() for p in sorted(path.iterdir()) if p.is_file() and detect(p))
        else:
            result.append(path.as_posix())
    return result


def detect(path: str | os.PathLike[str]) -> bool:
    """Cheap sniff: does ``path`` look like a Langfuse observations export?

    Reads at most 64 KiB. JSON / JSONL must mention ``traceId`` and
    ``startTime`` without OTLP markers (``spanId``, ``resourceSpans``); CSV
    must have ``id``, ``traceId`` and ``type`` header columns. Never raises.
    """
    try:
        p = Path(path)
        if not p.is_file() or p.suffix.lower() not in SUPPORTED_SUFFIXES:
            return False
        with p.open("rb") as handle:
            head = handle.read(_DETECT_BYTES).decode("utf-8", errors="replace")
    except OSError:
        return False
    if p.suffix.lower() == ".csv":
        header = head.splitlines()[0] if head.strip() else ""
        columns = {c.strip().strip('"').partition(".")[0] for c in header.split(",")}
        return {"id", "traceId", "type"} <= columns
    stripped = head.lstrip()
    if not stripped or stripped[0] not in "[{":
        return False
    if '"spanId"' in head or '"resourceSpans"' in head:
        return False
    return '"traceId"' in head and '"startTime"' in head


def load(
    paths: str | os.PathLike[str] | Iterable[str | os.PathLike[str]],
    config: TokenConfig | None = None,
) -> LoadResult:
    """Load one or more Langfuse observation export files (or a directory).

    One :class:`Run` per ``traceId``; rows from several files that share a
    trace ID are merged via :func:`agentlint.dedup.normalize_runs`. Runs are
    returned sorted by ID. A directory contributes every file in it (sorted
    by name) that :func:`detect` accepts; sidecars and other formats are
    skipped. Files named explicitly are always parsed. Files that cannot be
    parsed, and rows without a ``traceId``, are reported in ``errors``. Never
    reads outside ``paths``, never touches the network, never copies io
    content into the result.
    """
    token_config = config if config is not None else DEFAULT_TOKEN_CONFIG
    runs: list[Run] = []
    errors: list[LoadError] = []
    for path in _expand_paths(paths):
        file_runs, file_errors = _runs_from_file(path)
        runs.extend(file_runs)
        errors.extend(file_errors)
    normalized = normalize_runs(runs, token_config)
    normalized.sort(key=lambda r: r.id)
    return LoadResult(format_label=FORMAT_LABEL, runs=normalized, errors=errors)
