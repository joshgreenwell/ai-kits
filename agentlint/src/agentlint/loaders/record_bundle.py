"""Record-bundle loader: the documented neutral JSON format for app debug reports.

Plan §2.3 and §4.1. Any application can map its own debug report into a
*record bundle* (``docs/record-bundle.md``, schema ``docs/record-bundle.schema.json``)
and agentlint lints it like any other trace. The schema is authored here as
:data:`SCHEMA`; the published JSON file is generated from it by
:func:`schema_json` and a test keeps the two byte-identical.

The loader validates every document against the schema with the small
hand-written validator in this module (:func:`validate`), which covers exactly
the draft 2020-12 keywords the schema uses. An invalid *record* is dropped and
reported on the run's coverage with its JSON-pointer locator; an invalid
*document* (bad top level) is a :class:`~agentlint.loaders.base.LoadError`.

What this loader never does:

* never reads content: the bundle carries fingerprints, sizes and identifiers
  only, and ``raw`` is retained verbatim without being interpreted;
* never fills an absent field: ``null`` is a schema violation, a missing key
  is ``None``, and ``result_bytes`` is never derived from ``preview_bytes``;
* never derives one identifier from another: ``source_locator`` defaults to
  the JSON pointer of the record in the file it was read from;
* never reads or rewrites ``scope``: namespaces are passed through untouched;
* never touches the network or any file outside the given paths.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from dataclasses import fields as dataclass_fields
from pathlib import Path
from typing import Any

from agentlint.dedup import normalize_runs
from agentlint.loaders.base import LoadError, LoadResult
from agentlint.model import (
    EVENT_KINDS,
    EVENT_STATUSES,
    REPRESENTATIONS,
    Coverage,
    CoverageNote,
    Event,
    Fingerprint,
    Run,
    canonical_json,
    to_json,
)
from agentlint.tokens import DEFAULT_TOKEN_CONFIG, TokenConfig

FORMAT_LABEL = "record-bundle"
"""Format label recorded in ``Run.source_format``."""

SCHEMA_VERSIONS: tuple[str, ...] = ("1",)
"""Values of ``schema_version`` this loader accepts."""

SCHEMA_ID = (
    "https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/record-bundle.schema.json"
)


# --- Schema (the single source of truth for docs/record-bundle.schema.json) ---


def _string(description: str, **extra: Any) -> dict[str, Any]:
    return {"type": "string", "minLength": 1, "description": description, **extra}


def _count(description: str) -> dict[str, Any]:
    return {"type": "integer", "minimum": 0, "description": description}


_FINGERPRINT_REF = {"$ref": "#/$defs/fingerprint"}

_RECORD_PROPERTIES: dict[str, dict[str, Any]] = {
    "id": _string(
        "Source identity: the identifier the application already has for this record "
        "(a row ID, span ID, message ID). Never derived from another identifier. "
        "Records that repeat an id are duplicates of one operation and are collapsed."
    ),
    "source_locator": _string(
        "Where this record came from, in the application's own terms (report ID plus row "
        "ID, a file and line, a JSON pointer). Defaults to '<file>#/records/<index>' for "
        "the file the loader read it from."
    ),
    "seq": _count(
        "Application-assigned sequence number within the run. Second ordering key after "
        "start_ms; two records without it are ordered by id only, which implies no causal "
        "order."
    ),
    "parent_id": _string(
        "id of the record this one is nested under (a tool call under the model call that "
        "requested it, a child under an aggregate)."
    ),
    "kind": {
        "type": "string",
        "enum": sorted(EVENT_KINDS),
        "description": (
            "model_call: one request to a model. tool_call: one tool or command execution. "
            "approval: a permission or policy decision about a tool call (status blocked "
            "when denied). aggregate: a framework span that summarises children (its usage "
            "is never added to its children's). other: anything else worth keeping in order."
        ),
    },
    "name": _string(
        "Operation name (tool name, request type, span name). Free text; generic rules "
        "match whole words of it against a visible exclusion list for routing / retrieval "
        "/ compaction calls."
    ),
    "status": {
        "type": "string",
        "enum": sorted(EVENT_STATUSES),
        "description": (
            "ok: completed normally. error: failed. blocked: denied by an approval or "
            "policy. unknown: the source did not say."
        ),
    },
    "error_type": _string(
        "Error class or category as the source names it (a type name, not a message)."
    ),
    "error_code": _string(
        "Error code as the source names it (an HTTP status, an exit code, an application code)."
    ),
    "start_ms": _count("Start as integer milliseconds since the Unix epoch. First ordering key."),
    "end_ms": _count("End as integer milliseconds since the Unix epoch."),
    "duration_ms": _count(
        "Duration in integer milliseconds when the source records it directly. Never "
        "computed from start_ms and end_ms by the loader."
    ),
    "model": _string("Model identifier as the source reports it (model_call and aggregate)."),
    "provider": _string("Model provider as the source reports it."),
    "adapter": _string(
        "Client library or adapter through which the model was called, as the source reports it."
    ),
    "token_basis": _string(
        "What tokens_in measures: input_includes_cache_read or input_excludes_cache_read "
        "are the documented values; other strings are kept as-is. Counts are compared and "
        "totalled only among records sharing a basis and a model. A record without a basis "
        "is comparable to nothing."
    ),
    "tokens_in": _count("Input tokens on the stated basis."),
    "tokens_out": _count("Output tokens."),
    "tokens_total": _count(
        "Total tokens when the source reports one directly; never computed by the loader."
    ),
    "cache_read_tokens": _count("Tokens served from a prompt cache."),
    "cache_write_tokens": _count("Tokens written to a prompt cache."),
    "finish_reason": _string(
        "Why the model stopped, as the source reports it (stop, tool_use, length, ...)."
    ),
    "tool_call_id": _string(
        "The application-level identifier of the tool call this record is (kind tool_call) "
        "or decides about (kind approval). Records of the same kind that share it are one "
        "operation. An approval and the tool call it decides share it without being merged."
    ),
    "native_tool_call_id": _string(
        "The model provider's identifier for the same tool call. Kept separately from "
        "tool_call_id; the two are never substituted for one another."
    ),
    "args_fingerprint": {
        **_FINGERPRINT_REF,
        "description": (
            "Fingerprint of the tool call's arguments. The arguments themselves are never "
            'included. Omit when the arguments were a placeholder ({}, "") or shorter '
            "than 16 bytes."
        ),
    },
    "result_fingerprint": {
        **_FINGERPRINT_REF,
        "description": (
            "Fingerprint of the model-visible tool result. The result itself is never included."
        ),
    },
    "result_bytes": _count(
        "UTF-8 length of the full model-visible result. Omit when only a preview or "
        "excerpt is available; size rules then abstain."
    ),
    "preview_bytes": _count(
        "UTF-8 length of whatever preview or excerpt the debug report kept. Never a "
        "substitute for result_bytes."
    ),
    "included_result_ids": {
        "type": "array",
        "items": {"type": "string", "minLength": 1},
        "description": (
            "For an aggregate: ids of the records whose results it summarises. Also used "
            "to exclude the aggregate's usage from token comparisons when children exist."
        ),
    },
    "scope": {
        "type": "object",
        "additionalProperties": {"type": "object"},
        "description": (
            "Application-specific data, namespaced: each key is a namespace (for example "
            "the application's name) and each value an object of that application's fields "
            "(targets, selection, policy, ...). Passed through untouched. Generic rules "
            "never read it; the namespace 'agentlint' with a 'tags' list is the one "
            "neutral namespace the loader family uses."
        ),
    },
    "raw": {
        "type": ["object", "array", "string", "number", "boolean"],
        "description": (
            "The application's original record, kept verbatim as evidence. Opaque: never "
            "validated beyond being non-null, never interpreted. The application must "
            "redact it before emitting; agentlint does not redact."
        ),
    },
}

SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": SCHEMA_ID,
    "$comment": (
        "Generated from agentlint.loaders.record_bundle.SCHEMA by schema_json(); "
        "do not edit by hand."
    ),
    "title": "agentlint record bundle",
    "description": (
        "Neutral JSON that any application can emit from its own debug report so agentlint "
        "can lint the run. One document describes one run (or one page of a run; documents "
        "sharing run_id are merged). Absent means absent: an optional field is omitted, "
        "never null. Counts and timestamps are JSON integers, never floats. Values are "
        "never copied into the bundle: tool arguments and results are represented by "
        "fingerprints and byte sizes only."
    ),
    "type": "object",
    "required": ["schema_version", "run_id", "records"],
    "properties": {
        "schema_version": {
            "type": "string",
            "enum": list(SCHEMA_VERSIONS),
            "description": (
                "Version of this schema the document follows. The loader accepts exactly "
                "the versions listed here."
            ),
        },
        "run_id": _string(
            "The application's own identifier for the run. Documents with the same run_id "
            "are merged into one run."
        ),
        "conversation_id": _string(
            "The application's identifier for the conversation or session the run belongs to."
        ),
        "source_refs": {
            "type": "array",
            "items": {"type": "string", "minLength": 1},
            "description": (
                "References to where the data came from (report identifiers, export names). "
                "Recorded on the run as evidence, never opened by the loader. When omitted, "
                "the loader records the path of the file it read."
            ),
        },
        "started_at": _count("Run start as integer milliseconds since the Unix epoch."),
        "ended_at": _count("Run end as integer milliseconds since the Unix epoch."),
        "final_status": _string(
            "How the run ended, in the application's own vocabulary (for example completed, "
            "failed, cancelled). Kept verbatim in the retained bundle document; generic "
            "rules never interpret it."
        ),
        "records": {
            "type": "array",
            "items": {"$ref": "#/$defs/record"},
            "description": (
                "The run's operations. Order does not matter; the loader sorts by "
                "(start_ms, seq, id). An invalid record is dropped and reported by its JSON "
                "pointer; the rest of the document still loads."
            ),
        },
    },
    "$defs": {
        "fingerprint": {
            "type": "object",
            "required": ["hash", "representation"],
            "properties": {
                "hash": {"type": "string", "pattern": "^[0-9a-f]+$"},
                "representation": {"type": "string", "enum": sorted(REPRESENTATIONS)},
            },
            "additionalProperties": False,
            "description": (
                "SHA-256 over the canonical JSON form of a value (sorted keys, no "
                "whitespace, arrays in order), as lowercase hex. Never computed over fewer "
                "than 16 bytes. representation says how much of the model-visible value was "
                "hashed; only full fingerprints support equality claims."
            ),
        },
        "record": {
            "type": "object",
            "required": ["id", "kind", "status"],
            "properties": _RECORD_PROPERTIES,
            "additionalProperties": False,
            "description": (
                "One operation in the run. Unknown properties are rejected so that a "
                "misspelled field is noticed rather than silently lost; application-specific "
                "data goes under scope (namespaced) or raw (opaque)."
            ),
        },
    },
}
"""The record-bundle JSON Schema (draft 2020-12); see ``docs/record-bundle.schema.json``."""


def schema_json() -> str:
    """The published schema text: deterministic JSON of :data:`SCHEMA`."""
    return to_json(SCHEMA)


# --- Validator (the draft 2020-12 subset the schema uses) -------------------

SUPPORTED_KEYWORDS: frozenset[str] = frozenset(
    {
        "type",
        "enum",
        "required",
        "properties",
        "additionalProperties",
        "items",
        "minimum",
        "minLength",
        "pattern",
        "$ref",
    }
)
"""Validation keywords :func:`validate` implements. A schema using any other
validation keyword would be silently under-checked, so a test asserts
:data:`SCHEMA` uses nothing outside this set and :data:`ANNOTATION_KEYWORDS`."""

ANNOTATION_KEYWORDS: frozenset[str] = frozenset(
    {"$schema", "$id", "$comment", "$defs", "title", "description"}
)
"""Keywords that carry no validation and are ignored by :func:`validate`."""


@dataclass(frozen=True, slots=True)
class Violation:
    """One schema violation, located by JSON pointer (RFC 6901) into the document."""

    pointer: str
    keyword: str
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {"pointer": self.pointer, "keyword": self.keyword, "message": self.message}


def escape_pointer_token(token: str) -> str:
    """Escape one reference token for a JSON pointer (``~`` → ``~0``, ``/`` → ``~1``)."""
    return token.replace("~", "~0").replace("/", "~1")


def _unescape_pointer_token(token: str) -> str:
    return token.replace("~1", "/").replace("~0", "~")


def _json_type_names(value: Any) -> frozenset[str]:
    """Draft 2020-12 type names ``value`` satisfies.

    Deviation, on purpose: only a JSON integer satisfies ``integer``; ``1.0``
    does not (counts must be integers), and booleans are never numbers.
    """
    if value is None:
        return frozenset({"null"})
    if isinstance(value, bool):
        return frozenset({"boolean"})
    if isinstance(value, int):
        return frozenset({"integer", "number"})
    if isinstance(value, float):
        return frozenset({"number"})
    if isinstance(value, str):
        return frozenset({"string"})
    if isinstance(value, list):
        return frozenset({"array"})
    if isinstance(value, Mapping):
        return frozenset({"object"})
    return frozenset()


def _describe_type(value: Any) -> str:
    names = _json_type_names(value)
    if "integer" in names:
        return "integer"
    return next(iter(names), type(value).__name__)


def _json_equal(a: Any, b: Any) -> bool:
    """Equality that keeps ``1``, ``1.0``, ``true`` and ``"1"`` distinct."""
    return canonical_json(a) == canonical_json(b) and _json_type_names(a) == _json_type_names(b)


def _resolve_ref(ref: str, root: Mapping[str, Any]) -> Any:
    if not ref.startswith("#/"):
        raise ValueError(f"only local references are supported, got {ref!r}")
    node: Any = root
    for token in ref[2:].split("/"):
        node = node[_unescape_pointer_token(token)]
    return node


def _validate(
    instance: Any,
    schema: Any,
    pointer: str,
    root: Mapping[str, Any],
    out: list[Violation],
) -> None:
    if schema is True:
        return
    if schema is False:
        out.append(Violation(pointer, "false", "no value is allowed here"))
        return
    if "$ref" in schema:
        _validate(instance, _resolve_ref(schema["$ref"], root), pointer, root, out)

    if "type" in schema:
        allowed = schema["type"]
        allowed = [allowed] if isinstance(allowed, str) else list(allowed)
        if not _json_type_names(instance) & set(allowed):
            expected = " or ".join(allowed)
            out.append(
                Violation(
                    pointer,
                    "type",
                    f"expected {expected}, got {_describe_type(instance)}",
                )
            )
            return  # nothing below applies to a value of the wrong type

    if "enum" in schema and not any(_json_equal(instance, e) for e in schema["enum"]):
        choices = ", ".join(json.dumps(e) for e in schema["enum"])
        out.append(Violation(pointer, "enum", f"must be one of {choices}"))

    is_number = isinstance(instance, int | float) and not isinstance(instance, bool)
    if "minimum" in schema and is_number and instance < schema["minimum"]:
        out.append(Violation(pointer, "minimum", f"must be >= {schema['minimum']}"))

    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            out.append(
                Violation(pointer, "minLength", f"must be at least {schema['minLength']} long")
            )
        if "pattern" in schema and re.search(schema["pattern"], instance) is None:
            out.append(Violation(pointer, "pattern", f"must match {schema['pattern']}"))

    if isinstance(instance, Mapping):
        for key in schema.get("required", ()):
            if key not in instance:
                out.append(Violation(pointer, "required", f"missing required property {key!r}"))
        properties = schema.get("properties", {})
        for key, value in instance.items():
            child = f"{pointer}/{escape_pointer_token(key)}"
            if key in properties:
                _validate(value, properties[key], child, root, out)
            elif "additionalProperties" in schema:
                extra = schema["additionalProperties"]
                if extra is False:
                    out.append(Violation(child, "additionalProperties", "unexpected property"))
                else:
                    _validate(value, extra, child, root, out)

    if isinstance(instance, list) and "items" in schema:
        for index, item in enumerate(instance):
            _validate(item, schema["items"], f"{pointer}/{index}", root, out)


def validate(instance: Any, schema: Mapping[str, Any] = SCHEMA) -> list[Violation]:
    """Validate ``instance`` against ``schema``; return every violation found.

    Implements exactly :data:`SUPPORTED_KEYWORDS` of draft 2020-12 (local
    ``$ref`` only). Violations are located by JSON pointer from the document
    root (``""`` is the root itself). Never raises on invalid input.
    """
    out: list[Violation] = []
    _validate(instance, schema, "", schema, out)
    return out


# --- Loading ----------------------------------------------------------------

_RECORD_POINTER = re.compile(r"^/records/(\d+)(?:/|$)")
_TOP_LEVEL_KEYS = frozenset(SCHEMA["properties"])
_EVENT_FIELDS: tuple[str, ...] = tuple(f.name for f in dataclass_fields(Event))
_OPTIONAL_SCALARS: tuple[str, ...] = tuple(
    name
    for name in _EVENT_FIELDS
    if name
    not in {
        "id",
        "source_locator",
        "kind",
        "status",
        "args_fingerprint",
        "result_fingerprint",
        "scope",
        "included_result_ids",
    }
)


def detect(path: str | Path) -> bool:
    """True when ``path`` is a JSON object with ``schema_version``, ``run_id`` and ``records``.

    For a directory, true when any ``*.json`` file directly inside it detects.
    Parses the file (a bundle is one document, so there is no cheaper sniff);
    never raises.
    """
    try:
        p = Path(path)
        if p.is_dir():
            return any(detect(child) for child in sorted(p.glob("*.json")))
        with p.open("rb") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and all(
        k in data for k in ("schema_version", "run_id", "records")
    )


def _expand_paths(paths: str | Path | Iterable[str | Path]) -> tuple[list[Path], list[LoadError]]:
    """Files to read, in sorted path order; directories contribute their ``*.json`` files."""
    given = [paths] if isinstance(paths, str | Path) else list(paths)
    files: list[Path] = []
    errors: list[LoadError] = []
    for item in given:
        p = Path(item)
        if p.is_dir():
            children = sorted(p.glob("*.json"))
            if not children:
                errors.append(LoadError(path=str(p), reason="directory contains no .json files"))
            files.extend(children)
        else:
            files.append(p)
    return sorted(files, key=str), errors


def _fingerprint(data: Mapping[str, Any] | None) -> Fingerprint | None:
    return (
        None
        if data is None
        else Fingerprint(hash=data["hash"], representation=data["representation"])
    )


def _event_from_record(record: Mapping[str, Any], default_locator: str) -> Event:
    """Map one schema-valid record to an :class:`Event`; absent keys stay ``None``."""
    values: dict[str, Any] = {name: record.get(name) for name in _OPTIONAL_SCALARS}
    values["status"] = record["status"]
    return Event(
        id=record["id"],
        source_locator=record.get("source_locator", default_locator),
        kind=record["kind"],
        args_fingerprint=_fingerprint(record.get("args_fingerprint")),
        result_fingerprint=_fingerprint(record.get("result_fingerprint")),
        scope={ns: dict(v) for ns, v in record.get("scope", {}).items()},
        included_result_ids=list(record.get("included_result_ids", [])),
        **values,
    )


def _field_of(pointer: str, record_pointer: str) -> str | None:
    rest = pointer[len(record_pointer) :]
    if not rest.startswith("/"):
        return None
    return _unescape_pointer_token(rest[1:].split("/", 1)[0])


def _load_document(path: Path) -> tuple[Run | None, list[LoadError]]:
    """Parse and validate one file into an un-normalized :class:`Run`."""
    try:
        with path.open("rb") as handle:
            doc = json.load(handle)
    except OSError as exc:
        return None, [LoadError(path=str(path), reason=f"cannot read file: {exc.strerror}")]
    except ValueError as exc:
        return None, [LoadError(path=str(path), reason=f"invalid JSON: {exc}")]

    violations = validate(doc)
    per_record: dict[int, list[Violation]] = {}
    top_level: list[Violation] = []
    for v in violations:
        match = _RECORD_POINTER.match(v.pointer)
        if match:
            per_record.setdefault(int(match.group(1)), []).append(v)
        else:
            top_level.append(v)
    if top_level:
        detail = "; ".join(f"#{v.pointer}: {v.message}" for v in top_level)
        return None, [
            LoadError(
                path=str(path),
                reason=f"{len(top_level)} top-level schema violation(s): {detail}",
                locator=f"{path}#{top_level[0].pointer}",
            )
        ]

    reasons: list[str] = []
    notes: list[CoverageNote] = []
    events: list[Event] = []
    for index, record in enumerate(doc["records"]):
        record_pointer = f"/records/{index}"
        locator = f"{path}#{record_pointer}"
        found = per_record.get(index)
        if found:
            for v in found:
                reasons.append(f"schema violation at {path}#{v.pointer}: {v.message}")
            fields = sorted({f for v in found if (f := _field_of(v.pointer, record_pointer))})
            record_id = record.get("id") if isinstance(record, Mapping) else None
            notes.append(
                CoverageNote(
                    code="schema_violation",
                    message=f"record {locator} dropped: "
                    + "; ".join(f"#{v.pointer}: {v.message}" for v in found),
                    fields=fields,
                    event_ids=[record_id] if isinstance(record_id, str) and record_id else [],
                )
            )
            continue
        events.append(_event_from_record(record, locator))

    unknown = sorted(k for k in doc if k not in _TOP_LEVEL_KEYS and not k.startswith("_"))
    if unknown:
        notes.append(
            CoverageNote(
                code="unknown_top_level_keys",
                message=f"{path}: top-level keys not in the schema were ignored: "
                + ", ".join(unknown),
            )
        )
    preview_only = [
        e.id
        for e in events
        if e.kind == "tool_call" and e.preview_bytes is not None and e.result_bytes is None
    ]
    if preview_only:
        notes.append(
            CoverageNote(
                code="preview_only",
                message=(
                    f"{len(preview_only)} tool call(s) carry preview_bytes but no "
                    "result_bytes; result sizes are unknown and size rules must abstain"
                ),
                fields=["result_bytes", "preview_bytes"],
                event_ids=preview_only,
            )
        )

    run = Run(
        id=doc["run_id"],
        source_format=FORMAT_LABEL,
        conversation_id=doc.get("conversation_id"),
        source_refs=list(doc.get("source_refs") or [str(path)]),
        started_at=doc.get("started_at"),
        ended_at=doc.get("ended_at"),
        coverage=Coverage(reasons=reasons, notes=notes),
        events=events,
        raw_records=[doc],
    )
    return run, []


def load(paths: str | Path | Iterable[str | Path], config: TokenConfig | None = None) -> LoadResult:
    """Load one file, several files, or a directory of record bundles.

    Files are read in sorted path order; documents sharing ``run_id`` are
    merged (:func:`agentlint.dedup.merge_runs`) and every run is normalized
    (dedup, ordering, coverage). Records that violate the schema are dropped
    and reported on the run's coverage with JSON-pointer locators, which marks
    the run ``incomplete``; a document whose top level is invalid, unreadable
    or not JSON becomes a :class:`~agentlint.loaders.base.LoadError` instead.
    Each loaded document is kept verbatim in ``Run.raw_records``.
    """
    files, errors = _expand_paths(paths)
    runs: list[Run] = []
    for path in files:
        run, file_errors = _load_document(path)
        errors.extend(file_errors)
        if run is not None:
            runs.append(run)
    return LoadResult(
        format_label=FORMAT_LABEL,
        runs=normalize_runs(runs, config or DEFAULT_TOKEN_CONFIG),
        errors=errors,
    )


# --- Re-emitting and header access ------------------------------------------


def bundle_documents(run: Run) -> list[dict[str, Any]]:
    """The record-bundle documents retained verbatim in ``run.raw_records``."""
    return [
        r
        for r in run.raw_records
        if isinstance(r, Mapping) and all(k in r for k in ("schema_version", "run_id", "records"))
    ]


def bundle_headers(run: Run) -> list[dict[str, Any]]:
    """Top-level fields (everything but ``records``) of each retained document.

    This is where run-level application data such as ``final_status`` lives;
    the neutral model has no slot for it and generic code never reads it.
    """
    return [{k: v for k, v in doc.items() if k != "records"} for doc in bundle_documents(run)]


def final_status(run: Run) -> str | None:
    """The ``final_status`` the retained documents agree on, else ``None``."""
    values = sorted({h["final_status"] for h in bundle_headers(run) if "final_status" in h})
    return values[0] if len(values) == 1 else None


def _raw_by_id(run: Run) -> dict[str, Any]:
    """``raw`` evidence per record id, only where the retained documents agree on it."""
    seen: dict[str, list[str]] = {}
    values: dict[str, Any] = {}
    for doc in bundle_documents(run):
        for record in doc["records"]:
            if not isinstance(record, Mapping) or "raw" not in record:
                continue
            record_id = record.get("id")
            if not isinstance(record_id, str):
                continue
            key = canonical_json(record["raw"])
            if key not in seen.setdefault(record_id, []):
                seen[record_id].append(key)
                values[record_id] = record["raw"]
    return {rid: values[rid] for rid, keys in seen.items() if len(keys) == 1}


def _record_from_event(event: Event, raw: Any = None, has_raw: bool = False) -> dict[str, Any]:
    record: dict[str, Any] = {}
    for name in _EVENT_FIELDS:
        value = getattr(event, name)
        if value is None:
            continue
        if isinstance(value, Fingerprint):
            record[name] = value.to_dict()
        elif name == "scope":
            if value:
                record[name] = {ns: dict(v) for ns, v in value.items()}
        elif name == "included_result_ids":
            if value:
                record[name] = list(value)
        else:
            record[name] = value
    if has_raw:
        record["raw"] = raw
    return record


def to_record_bundle(run: Run) -> dict[str, Any]:
    """Re-emit a :class:`Run` as a record-bundle document.

    Records are built from the run's events (canonical order, absent fields
    omitted, ``source_locator`` always explicit so evidence survives). The
    header starts from the first retained bundle document, so ``final_status``
    and annotation keys carry over, and is overwritten with the run's own
    identifiers and timestamps. ``raw`` evidence is carried for a record when
    the retained documents hold exactly one value for its id. Loading the
    result yields the same events and coverage; it never adds anything the
    run did not contain.
    """
    headers = bundle_headers(run)
    header: dict[str, Any] = dict(headers[0]) if headers else {}
    header["schema_version"] = SCHEMA_VERSIONS[-1]
    header["run_id"] = run.id
    for key, value in (
        ("conversation_id", run.conversation_id),
        ("source_refs", list(run.source_refs) or None),
        ("started_at", run.started_at),
        ("ended_at", run.ended_at),
    ):
        if value is None:
            header.pop(key, None)
        else:
            header[key] = value
    raw_by_id = _raw_by_id(run)
    records = [
        _record_from_event(e, raw_by_id.get(e.id), e.id in raw_by_id) for e in run.sorted_events()
    ]
    return {**header, "records": records}
