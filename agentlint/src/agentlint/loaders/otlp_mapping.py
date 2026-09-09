"""Tolerant ``gen_ai.*`` attribute mapping and OTLP/JSON value decoding (plan §2.3, §5.5).

The OpenTelemetry GenAI semantic conventions have renamed attributes more
than once (``gen_ai.usage.prompt_tokens`` became ``gen_ai.usage.input_tokens``,
``gen_ai.system`` became ``gen_ai.provider.name``). :data:`ATTRIBUTE_MAPPINGS`
is the single table that accepts every generation; the loader documentation
is rendered from it (:func:`render_mapping_table`) so the two never drift.

What this module never does:

* never coerces an integer through a float: ``intValue`` is a string-encoded
  int64 in OTLP/JSON and is parsed with :func:`int` exactly;
* never invents a run ID: the fallback chain is app attribute, then
  ``gen_ai.conversation.id``, then the trace ID — and the last step is flagged;
* never returns ``0`` / ``""`` for an absent attribute — absent is ``None``;
* never reads attribute *content* beyond hashing and measuring it.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

# --- Mapping table ---------------------------------------------------------

VALUE_INT = "int"
VALUE_STR = "str"
VALUE_STR_OR_LIST = "str_or_list"
VALUE_CONTENT = "content"


@dataclass(frozen=True, slots=True)
class AttributeMapping:
    """One target field and the attribute names (newest first) that feed it.

    ``field`` is the neutral name the loader fills; ``names`` are tried in
    order and the first present attribute wins; ``value_type`` says how the
    decoded value is validated; ``generation`` labels each name with the
    naming generation it belongs to (same length as ``names``).
    """

    field: str
    names: tuple[str, ...]
    generation: tuple[str, ...]
    value_type: str
    description: str

    def __post_init__(self) -> None:
        if len(self.names) != len(self.generation):
            raise ValueError(f"{self.field}: names and generation must have the same length")


GEN_CURRENT = "current"
GEN_LEGACY = "legacy"
GEN_EXTENSION = "extension"

ATTRIBUTE_MAPPINGS: tuple[AttributeMapping, ...] = (
    AttributeMapping(
        field="model",
        names=("gen_ai.response.model", "gen_ai.request.model"),
        generation=(GEN_CURRENT, GEN_CURRENT),
        value_type=VALUE_STR,
        description="Model name; the response model wins over the requested one.",
    ),
    AttributeMapping(
        field="provider",
        names=("gen_ai.provider.name", "gen_ai.system"),
        generation=(GEN_CURRENT, GEN_LEGACY),
        value_type=VALUE_STR,
        description="Provider / system name.",
    ),
    AttributeMapping(
        field="operation_name",
        names=("gen_ai.operation.name",),
        generation=(GEN_CURRENT,),
        value_type=VALUE_STR,
        description="Operation name used for span kind classification.",
    ),
    AttributeMapping(
        field="conversation_id",
        names=("gen_ai.conversation.id",),
        generation=(GEN_CURRENT,),
        value_type=VALUE_STR,
        description="Conversation / session ID; second step of the run-ID fallback.",
    ),
    AttributeMapping(
        field="tokens_in",
        names=("gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens"),
        generation=(GEN_CURRENT, GEN_LEGACY),
        value_type=VALUE_INT,
        description="Input token count.",
    ),
    AttributeMapping(
        field="tokens_out",
        names=("gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens"),
        generation=(GEN_CURRENT, GEN_LEGACY),
        value_type=VALUE_INT,
        description="Output token count.",
    ),
    AttributeMapping(
        field="tokens_total",
        names=("gen_ai.usage.total_tokens",),
        generation=(GEN_LEGACY,),
        value_type=VALUE_INT,
        description="Total token count as reported; never recomputed.",
    ),
    AttributeMapping(
        field="cache_read_tokens",
        names=("gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_read_input_tokens"),
        generation=(GEN_CURRENT, GEN_EXTENSION),
        value_type=VALUE_INT,
        description="Tokens served from a prompt cache, where the instrumentation reports them.",
    ),
    AttributeMapping(
        field="cache_write_tokens",
        names=(
            "gen_ai.usage.cache_creation.input_tokens",
            "gen_ai.usage.cache_creation_input_tokens",
        ),
        generation=(GEN_CURRENT, GEN_EXTENSION),
        value_type=VALUE_INT,
        description="Tokens written to a prompt cache, where the instrumentation reports them.",
    ),
    AttributeMapping(
        field="finish_reason",
        names=("gen_ai.response.finish_reasons", "gen_ai.response.finish_reason"),
        generation=(GEN_CURRENT, GEN_LEGACY),
        value_type=VALUE_STR_OR_LIST,
        description="Finish reason(s); a list is joined with commas.",
    ),
    AttributeMapping(
        field="tool_call_id",
        names=("gen_ai.tool.call.id",),
        generation=(GEN_CURRENT,),
        value_type=VALUE_STR,
        description="Tool call ID; the dedup join key for tool spans.",
    ),
    AttributeMapping(
        field="tool_name",
        names=("gen_ai.tool.name",),
        generation=(GEN_CURRENT,),
        value_type=VALUE_STR,
        description="Tool name; becomes the tool event's name.",
    ),
    AttributeMapping(
        field="tool_args",
        names=("gen_ai.tool.call.arguments",),
        generation=(GEN_CURRENT,),
        value_type=VALUE_CONTENT,
        description="Tool arguments; fingerprinted, never stored.",
    ),
    AttributeMapping(
        field="tool_result",
        names=("gen_ai.tool.call.result",),
        generation=(GEN_CURRENT,),
        value_type=VALUE_CONTENT,
        description="Tool result; fingerprinted and measured, never stored.",
    ),
    AttributeMapping(
        field="error_type",
        names=("error.type",),
        generation=(GEN_CURRENT,),
        value_type=VALUE_STR,
        description="Error class or code of a failed span.",
    ),
)
"""Every attribute the OTLP loaders read, keyed by the neutral field it fills."""

MAPPED_ATTRIBUTE_NAMES: frozenset[str] = frozenset(
    name for mapping in ATTRIBUTE_MAPPINGS for name in mapping.names
)
"""All attribute names present in :data:`ATTRIBUTE_MAPPINGS`."""

KNOWN_UNMAPPED_GEN_AI_ATTRIBUTES: frozenset[str] = frozenset(
    {
        "gen_ai.agent.description",
        "gen_ai.agent.id",
        "gen_ai.agent.name",
        "gen_ai.output.type",
        "gen_ai.request.choice.count",
        "gen_ai.request.encoding_formats",
        "gen_ai.request.frequency_penalty",
        "gen_ai.request.max_tokens",
        "gen_ai.request.presence_penalty",
        "gen_ai.request.seed",
        "gen_ai.request.stop_sequences",
        "gen_ai.request.temperature",
        "gen_ai.request.top_k",
        "gen_ai.request.top_p",
        "gen_ai.response.id",
        "gen_ai.tool.description",
        "gen_ai.tool.type",
    }
)
"""``gen_ai.*`` attributes the conventions define but no rule needs. They are
ignored silently; any other ``gen_ai.*`` name is reported as unknown."""

SPAN_EVENT_MAPPINGS: dict[str, tuple[str, tuple[str, ...]]] = {
    "gen_ai.tool.message": ("tool_result", ("gen_ai.tool.call.result", "content")),
}
"""Span events whose attributes may carry content when the span itself does
not: event name → (target field, attribute names tried in order)."""

MODEL_OPERATION_NAMES: frozenset[str] = frozenset(
    {"chat", "text_completion", "generate_content", "embeddings"}
)
"""``gen_ai.operation.name`` values that denote one model call."""

TOOL_OPERATION_NAMES: frozenset[str] = frozenset({"execute_tool", "tool"})
"""``gen_ai.operation.name`` values that denote one tool call."""

MODEL_SIGNAL_FIELDS: frozenset[str] = frozenset(
    {
        "model",
        "tokens_in",
        "tokens_out",
        "tokens_total",
        "cache_read_tokens",
        "cache_write_tokens",
        "finish_reason",
    }
)
"""Mapped fields whose presence marks a span as a model span even without an
operation name."""

USAGE_FIELDS: tuple[str, ...] = ("tokens_in", "tokens_out")
"""The usage fields whose absence makes a model call's usage ``absent``."""


def render_mapping_table() -> str:
    """The mapping table as GitHub-flavoured Markdown, generated from the data.

    The loader documentation embeds this verbatim; a test asserts they match.
    """
    lines = [
        "| Field | Attribute | Generation | Type | Notes |",
        "| -- | -- | -- | -- | -- |",
    ]
    for mapping in ATTRIBUTE_MAPPINGS:
        for i, (name, generation) in enumerate(zip(mapping.names, mapping.generation, strict=True)):
            field = f"`{mapping.field}`" if i == 0 else ""
            note = mapping.description if i == 0 else ""
            lines.append(f"| {field} | `{name}` | {generation} | {mapping.value_type} | {note} |")
    return "\n".join(lines) + "\n"


# --- Typed value decoding --------------------------------------------------

_INT64 = re.compile(r"^-?[0-9]+$")


def parse_int_exact(value: Any) -> int:
    """Parse an OTLP/JSON int64 (a decimal string, or an int) without float coercion.

    Raises :class:`ValueError` for booleans, floats, and non-decimal strings.
    """
    if isinstance(value, bool):
        raise ValueError("expected an int64, got a bool")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and _INT64.match(value):
        return int(value, 10)
    raise ValueError(f"expected an int64, got {type(value).__name__}")


def decode_any_value(value: Any) -> Any:
    """Decode one OTLP/JSON ``AnyValue`` into a plain Python value.

    ``stringValue`` → ``str``; ``intValue`` → ``int`` (exact); ``doubleValue`` →
    ``float``; ``boolValue`` → ``bool``; ``arrayValue`` → ``list``;
    ``kvlistValue`` → ``dict``; ``bytesValue`` → the base64 text as given.
    Raises :class:`ValueError` for any other shape.
    """
    if not isinstance(value, Mapping):
        raise ValueError(f"AnyValue must be an object, got {type(value).__name__}")
    if "stringValue" in value:
        text = value["stringValue"]
        if not isinstance(text, str):
            raise ValueError("stringValue must be a string")
        return text
    if "intValue" in value:
        return parse_int_exact(value["intValue"])
    if "doubleValue" in value:
        number = value["doubleValue"]
        if isinstance(number, bool):
            raise ValueError("doubleValue must be a number")
        if isinstance(number, int | float):
            return float(number)
        if isinstance(number, str) and number in {"NaN", "Infinity", "-Infinity"}:
            return float(number.lower().replace("infinity", "inf"))
        raise ValueError("doubleValue must be a number")
    if "boolValue" in value:
        flag = value["boolValue"]
        if not isinstance(flag, bool):
            raise ValueError("boolValue must be a bool")
        return flag
    if "arrayValue" in value:
        inner = value["arrayValue"]
        values = inner.get("values", []) if isinstance(inner, Mapping) else None
        if not isinstance(values, list):
            raise ValueError("arrayValue.values must be an array")
        return [decode_any_value(v) for v in values]
    if "kvlistValue" in value:
        inner = value["kvlistValue"]
        values = inner.get("values", []) if isinstance(inner, Mapping) else None
        if not isinstance(values, list):
            raise ValueError("kvlistValue.values must be an array")
        decoded, problems = decode_attributes(values)
        if problems:
            raise ValueError("kvlistValue: " + "; ".join(problems))
        return decoded
    if "bytesValue" in value:
        data = value["bytesValue"]
        if not isinstance(data, str):
            raise ValueError("bytesValue must be a base64 string")
        return data
    raise ValueError("AnyValue has no recognised value field")


def decode_attributes(attributes: Any) -> tuple[dict[str, Any], list[str]]:
    """Decode an OTLP/JSON ``KeyValue`` list into a dict, first key wins.

    Returns the decoded attributes and a list of problems for entries that
    could not be decoded (those entries are skipped, never guessed).
    """
    decoded: dict[str, Any] = {}
    problems: list[str] = []
    if attributes is None:
        return decoded, problems
    if not isinstance(attributes, list):
        return decoded, ["attributes must be an array"]
    for index, entry in enumerate(attributes):
        if not isinstance(entry, Mapping) or not isinstance(entry.get("key"), str):
            problems.append(f"attributes/{index}: missing string key")
            continue
        key = entry["key"]
        try:
            value = decode_any_value(entry.get("value"))
        except ValueError as exc:
            problems.append(f"attributes/{index} ({key}): {exc}")
            continue
        decoded.setdefault(key, value)
    return decoded, problems


# --- Mapped field extraction -----------------------------------------------


def _coerce(mapping: AttributeMapping, name: str, value: Any) -> Any:
    if mapping.value_type == VALUE_INT:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{name}: expected an integer, got {type(value).__name__}")
        return value
    if mapping.value_type == VALUE_STR:
        if not isinstance(value, str):
            raise ValueError(f"{name}: expected a string, got {type(value).__name__}")
        return value
    if mapping.value_type == VALUE_STR_OR_LIST:
        if isinstance(value, str):
            return value
        if isinstance(value, list) and all(isinstance(v, str) for v in value):
            return ",".join(value)
        raise ValueError(f"{name}: expected a string or list of strings")
    return value  # content: any JSON value, hashed later


def extract_mapped_fields(attributes: Mapping[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Apply :data:`ATTRIBUTE_MAPPINGS` to decoded span attributes.

    Returns ``{field: value}`` for every field that has a usable attribute
    (absent fields are simply missing) and a list of problems for attributes
    that were present but of the wrong type — those fields stay absent.
    """
    fields: dict[str, Any] = {}
    problems: list[str] = []
    for mapping in ATTRIBUTE_MAPPINGS:
        for name in mapping.names:
            if name not in attributes:
                continue
            try:
                fields[mapping.field] = _coerce(mapping, name, attributes[name])
            except ValueError as exc:
                problems.append(str(exc))
                continue
            break
    return fields, problems


def unknown_gen_ai_attributes(attributes: Iterable[str]) -> list[str]:
    """Sorted ``gen_ai.*`` attribute names that neither the table nor the
    known-unmapped list recognises."""
    return sorted(
        name
        for name in set(attributes)
        if name.startswith("gen_ai.")
        and name not in MAPPED_ATTRIBUTE_NAMES
        and name not in KNOWN_UNMAPPED_GEN_AI_ATTRIBUTES
    )


def content_from_span_events(events: Iterable[Mapping[str, Any]], field: str) -> Any:
    """The first content value for ``field`` carried by a span event, or ``None``.

    ``events`` are decoded span events (``{"name": ..., "attributes": {...}}``).
    """
    for event in events:
        target = SPAN_EVENT_MAPPINGS.get(str(event.get("name")))
        if target is None or target[0] != field:
            continue
        attributes = event.get("attributes") or {}
        for name in target[1]:
            if name in attributes:
                return attributes[name]
    return None


# --- Timestamps and status -------------------------------------------------


def parse_unix_nano(value: Any) -> int | None:
    """Parse ``startTimeUnixNano`` / ``endTimeUnixNano`` exactly; ``None`` if absent.

    Accepts the string encoding OTLP/JSON uses and a plain int. Raises
    :class:`ValueError` for floats and other shapes (never rounds).
    """
    if value is None:
        return None
    return parse_int_exact(value)


def nanos_to_millis(nanos: int | None) -> int | None:
    """Integer milliseconds from nanoseconds by floor division; ``None`` stays ``None``."""
    return None if nanos is None else nanos // 1_000_000


STATUS_UNSET = "unset"
STATUS_OK = "ok"
STATUS_ERROR = "error"

_STATUS_CODES: dict[Any, str] = {
    0: STATUS_UNSET,
    1: STATUS_OK,
    2: STATUS_ERROR,
    "STATUS_CODE_UNSET": STATUS_UNSET,
    "STATUS_CODE_OK": STATUS_OK,
    "STATUS_CODE_ERROR": STATUS_ERROR,
    "UNSET": STATUS_UNSET,
    "OK": STATUS_OK,
    "ERROR": STATUS_ERROR,
}


def parse_span_status(status: Any) -> str:
    """Map an OTLP span ``status`` object to ``unset`` / ``ok`` / ``error``.

    Both the protobuf-JSON enum names and the collector's integer codes are
    accepted; anything unrecognised is ``unset``.
    """
    if not isinstance(status, Mapping):
        return STATUS_UNSET
    code = status.get("code", 0)
    if isinstance(code, bool):
        return STATUS_UNSET
    return _STATUS_CODES.get(code, STATUS_UNSET)


def event_status(span_status: str, has_result: bool) -> str:
    """``Event.status`` from the span status: ERROR → ``error``; OK, or UNSET
    with a parsed result → ``ok``; otherwise ``unknown``."""
    if span_status == STATUS_ERROR:
        return "error"
    if span_status == STATUS_OK or has_result:
        return "ok"
    return "unknown"


# --- Span kind classification ---------------------------------------------


def is_tool_span(attributes: Mapping[str, Any], fields: Mapping[str, Any]) -> bool:
    """True when the span carries ``gen_ai.tool.*`` attributes or a tool operation name."""
    if fields.get("operation_name") in TOOL_OPERATION_NAMES:
        return True
    return any(name.startswith("gen_ai.tool.") for name in attributes)


def is_model_span(fields: Mapping[str, Any]) -> bool:
    """True when the span names a model operation or carries model / usage fields."""
    if fields.get("operation_name") in MODEL_OPERATION_NAMES:
        return True
    return any(field in fields for field in MODEL_SIGNAL_FIELDS)


def classify_span(
    attributes: Mapping[str, Any], fields: Mapping[str, Any], model_call_descendants: int
) -> str:
    """``Event.kind`` for a span.

    * tool span → ``tool_call``;
    * model span with no model-call descendants (a leaf) → ``model_call``;
    * model span with any model-call descendant, or any span with two or more
      → ``aggregate`` (its usage is never added to its children's);
    * everything else → ``other``.
    """
    if is_tool_span(attributes, fields):
        return "tool_call"
    if is_model_span(fields):
        return "model_call" if model_call_descendants == 0 else "aggregate"
    if model_call_descendants >= 2:
        return "aggregate"
    return "other"


# --- Run-ID fallback -------------------------------------------------------

RUN_ID_SOURCE_APP = "app_attribute"
RUN_ID_SOURCE_CONVERSATION = "conversation_id"
RUN_ID_SOURCE_TRACE = "trace_id"


def run_id_from_attributes(
    span_attributes: Mapping[str, Any],
    resource_attributes: Mapping[str, Any],
    run_id_attribute: str | None,
) -> tuple[str, str] | None:
    """First two steps of the run-ID fallback for one span, or ``None``.

    1. the configured app attribute (span attributes, then resource attributes);
    2. ``gen_ai.conversation.id`` on the span.

    Returns ``(run_id, source)`` where ``source`` is ``app_attribute`` or
    ``conversation_id``. Values must be non-empty strings; the trace-ID step
    is applied by the loader, which flags it in coverage.
    """
    if run_id_attribute:
        for attributes in (span_attributes, resource_attributes):
            value = attributes.get(run_id_attribute)
            if isinstance(value, str) and value:
                return value, RUN_ID_SOURCE_APP
    value = span_attributes.get("gen_ai.conversation.id")
    if isinstance(value, str) and value:
        return value, RUN_ID_SOURCE_CONVERSATION
    return None


if __name__ == "__main__":  # pragma: no cover
    print(render_mapping_table(), end="")
