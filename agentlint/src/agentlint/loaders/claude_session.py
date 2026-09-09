"""Experimental loader for Claude Code session logs (``~/.claude/projects/**/*.jsonl``).

Format label ``claude-session-jsonl``. The format is **undocumented upstream**
and changes between Claude Code releases; this loader is modelled on logs
written by Claude Code 2.x (see ``docs/loaders/claude-session.md``) and is
gated behind an explicit opt-in (``load(paths, experimental=True)`` or a
``config`` whose ``experimental`` flag is true; the CLI flag
``--experimental-claude-session`` arrives in a later story).

Identity join:

* ``sessionId`` → ``Run.id`` (and ``Run.conversation_id``);
* record ``uuid`` → ``Event.id`` of a ``model_call``;
* ``tool_use.id`` ↔ ``tool_result.tool_use_id`` → ``Event.tool_call_id`` /
  ``native_tool_call_id`` (and the ``tool_call`` event's ``id``);
* ``parentUuid`` → ordering hint (``Event.seq`` is the record's depth in the
  ``parentUuid`` chain; the raw value is kept under ``scope["claude_session"]``);
* ``isSidechain: true`` + ``agentId`` → a separate run whose ``id`` is the
  ``agentId`` and whose ``conversation_id`` is the parent ``sessionId``.

What this loader never does:

* never reads a file that was not passed in — a directory argument reads only
  the ``*.jsonl`` regular files directly inside it, no recursion, no symlinks;
* never copies prompt text, tool inputs, tool results, file contents, working
  directories or branch names into the model — only hashes, byte counts, token
  counts, timestamps and identifiers survive (``raw_records`` stays empty);
* never merges sidechain (subagent) records into the parent run as if they
  were sequential with it;
* never skips an unrecognised top-level record type or content block type
  silently — each one becomes a coverage reason that marks the run incomplete;
* never sums token counts or invents a total the log did not carry.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
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

FORMAT_LABEL = "claude-session-jsonl"
"""Recorded in ``Run.source_format``."""

EXPERIMENTAL = True
"""This loader is opt-in; see :func:`load`."""

CLI_FLAG = "--experimental-claude-session"
"""The command-line flag that will enable this loader (later story)."""

SCOPE_NAMESPACE = "claude_session"
"""``Event.scope`` namespace for loader-specific hints (``parent_uuid``, ``message_id``)."""

CLAUDE_SESSION_TOKEN_BASIS = TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ
"""Token basis recorded on every ``model_call``.

Anthropic ``usage.input_tokens`` counts only the uncached part of the prompt:
``cache_read_input_tokens`` and ``cache_creation_input_tokens`` are reported
separately and are *not* included in ``input_tokens``. ``tokens_in`` therefore
excludes cache reads, which is exactly what this basis label says.
"""

MAPPED_RECORD_TYPES: frozenset[str] = frozenset({"user", "assistant"})
"""Top-level ``type`` values that produce events."""

IGNORED_RECORD_TYPES: frozenset[str] = frozenset(
    {
        "summary",
        "system",
        "file-history-snapshot",
        "progress",
        "attachment",
        "queue-operation",
        "last-prompt",
    }
)
"""Top-level ``type`` values that are recognised, counted in a coverage note and
otherwise ignored: they describe UI state, hooks, snapshots or queue bookkeeping,
not model or tool operations. Anything else marks the run ``incomplete``."""

IGNORED_BLOCK_TYPES: frozenset[str] = frozenset(
    {"text", "thinking", "redacted_thinking", "image", "document"}
)
"""``message.content[]`` block types that carry no operation and are skipped
(their content is never read). Any other block type marks the run ``incomplete``."""

_VERSION_REF_PREFIX = "claude-code-version="
_USAGE_INT_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
)


# --- Experimental gate -----------------------------------------------------


def _experimental_enabled(config: Any, experimental: bool) -> bool:
    if experimental:
        return True
    if config is None:
        return False
    if isinstance(config, Mapping):
        return bool(config.get("experimental_claude_session") or config.get("experimental"))
    return bool(
        getattr(config, "experimental_claude_session", False)
        or getattr(config, "experimental", False)
    )


def experimental_error(paths: Sequence[str | Path]) -> LoadError:
    """The single :class:`LoadError` returned when the loader is not enabled."""
    return LoadError(
        path=", ".join(str(p) for p in paths) if paths else "",
        reason=(
            f"the {FORMAT_LABEL} loader is experimental (undocumented upstream format); "
            "enable it with load(paths, experimental=True), a config whose "
            f"'experimental' flag is true, or the {CLI_FLAG} command-line flag"
        ),
    )


# --- Detection -------------------------------------------------------------


def detect(path: str | Path, max_lines: int = 5) -> bool:
    """Cheap sniff: a ``.jsonl`` file whose first lines look like session records.

    A record looks right when it is a JSON object with a string ``type`` and
    either a ``sessionId`` or a ``uuid``. Only ``path`` is opened; never raises.
    """
    p = Path(path)
    try:
        if p.suffix != ".jsonl" or not p.is_file():
            return False
        with p.open(encoding="utf-8") as handle:
            seen = 0
            for line in handle:
                if not line.strip():
                    continue
                seen += 1
                record = json.loads(line)
                if _looks_like_record(record):
                    return True
                if seen >= max_lines:
                    break
    except (OSError, ValueError, UnicodeDecodeError):
        return False
    return False


def _looks_like_record(record: Any) -> bool:
    return (
        isinstance(record, Mapping)
        and isinstance(record.get("type"), str)
        and (isinstance(record.get("sessionId"), str) or isinstance(record.get("uuid"), str))
    )


# --- Parsing helpers -------------------------------------------------------


def parse_timestamp_ms(value: Any) -> int | None:
    """ISO-8601 timestamp string → integer Unix milliseconds, or ``None``.

    Accepts a trailing ``Z`` or an explicit offset; naive timestamps are read as
    UTC. Anything unparseable yields ``None`` (never a zero).
    """
    if not isinstance(value, str) or not value:
        return None
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return round(parsed.timestamp() * 1000)


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _content_blocks(record: Mapping[str, Any]) -> list[Any]:
    message = record.get("message")
    if not isinstance(message, Mapping):
        return []
    content = message.get("content")
    return list(content) if isinstance(content, list) else []


def _jsonl_files(path: Path) -> list[Path]:
    """The regular ``*.jsonl`` files directly inside ``path`` (sorted); no recursion."""
    return sorted(
        child
        for child in path.iterdir()
        if child.suffix == ".jsonl" and child.is_file() and not child.is_symlink()
    )


# --- Per-file parse state --------------------------------------------------


@dataclass(slots=True)
class _Record:
    """One parsed JSONL line with its locator."""

    data: Mapping[str, Any]
    locator: str
    line: int


@dataclass(slots=True)
class _ToolUse:
    id: str
    name: str | None
    args_fingerprint: Fingerprint | None
    locator: str
    parent_event_id: str
    parent_uuid: str | None
    start_ms: int | None
    seq: int | None


@dataclass(slots=True)
class _ToolResult:
    tool_use_id: str
    locator: str
    is_error: bool
    result_bytes: int
    result_fingerprint: Fingerprint | None
    end_ms: int | None
    record_uuid: str | None


@dataclass(slots=True)
class _RunBuilder:
    """Accumulates one run (a main session or one sidechain) from one file."""

    run_id: str
    conversation_id: str
    path: str
    versions: list[str] = field(default_factory=list)
    timestamps: list[int] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    notes: list[CoverageNote] = field(default_factory=list)
    model_calls: dict[str, dict[str, Any]] = field(default_factory=dict)
    model_call_order: list[str] = field(default_factory=list)
    tool_uses: dict[str, _ToolUse] = field(default_factory=dict)
    tool_results: dict[str, _ToolResult] = field(default_factory=dict)
    ignored_types: dict[str, int] = field(default_factory=dict)
    unknown_types: dict[str, list[str]] = field(default_factory=dict)
    unknown_blocks: dict[str, list[str]] = field(default_factory=dict)
    unmapped_sidechain: list[str] = field(default_factory=list)
    sidechain_agents: list[str] = field(default_factory=list)

    def add_reason(self, reason: str) -> None:
        if reason not in self.reasons:
            self.reasons.append(reason)


def _depths(records: Iterable[_Record]) -> dict[str, int]:
    """``uuid`` → depth in the ``parentUuid`` chain, across every record given.

    A record whose parent is not among the records gets depth ``0``; cycles
    (which a well-formed log never has) are cut at the first repeated uuid.
    """
    parents: dict[str, str | None] = {}
    for record in records:
        uuid = record.data.get("uuid")
        parent = record.data.get("parentUuid")
        if isinstance(uuid, str):
            parents[uuid] = parent if isinstance(parent, str) else None
    depths: dict[str, int] = {}

    def depth(uuid: str) -> int:
        chain: list[str] = []
        cursor: str | None = uuid
        while cursor is not None and cursor not in depths and cursor in parents:
            if cursor in chain:
                break
            chain.append(cursor)
            cursor = parents[cursor]
        base = depths.get(cursor, -1) if cursor is not None else -1
        for i, item in enumerate(reversed(chain)):
            depths[item] = base + 1 + i
        return depths.get(uuid, 0)

    for uuid in parents:
        depth(uuid)
    return depths


def _tool_use_ids(records: Iterable[_Record]) -> frozenset[str]:
    """Every ``tool_use`` block id found in assistant records, across all files."""
    ids: set[str] = set()
    for record in records:
        if record.data.get("type") != "assistant":
            continue
        for block in _content_blocks(record.data):
            if isinstance(block, Mapping) and block.get("type") == "tool_use":
                tool_id = block.get("id")
                if isinstance(tool_id, str) and tool_id:
                    ids.add(tool_id)
    return frozenset(ids)


def _read_records(path: Path, locator_path: str) -> tuple[list[_Record], list[tuple[str, str]]]:
    """Parse every line of ``path``; returns records and ``(locator, problem)`` pairs."""
    records: list[_Record] = []
    problems: list[tuple[str, str]] = []
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            locator = f"{locator_path}:{line_no}"
            try:
                data = json.loads(line)
            except ValueError:
                problems.append((locator, "unparseable JSON line"))
                continue
            if not isinstance(data, Mapping):
                problems.append((locator, "line is not a JSON object"))
                continue
            records.append(_Record(data=data, locator=locator, line=line_no))
    return records, problems


# --- Record mapping --------------------------------------------------------


def _record_run_key(record: _Record, default_session: str) -> tuple[str, str]:
    """``(run_id, conversation_id)`` for a record.

    Records without a ``sessionId`` (snapshots, summaries) belong to the file's
    first session. Sidechain records with an ``agentId`` form their own run.
    """
    session = record.data.get("sessionId")
    if not isinstance(session, str) or not session:
        session = default_session
    if record.data.get("isSidechain") is True:
        agent = record.data.get("agentId")
        if isinstance(agent, str) and agent:
            return (agent, session)
        return (session, session)  # unmapped sidechain: flagged on the parent run
    return (session, session)


def _map_assistant(builder: _RunBuilder, record: _Record, depths: dict[str, int]) -> None:
    data = record.data
    message = data.get("message")
    if not isinstance(message, Mapping):
        builder.add_reason(f"assistant_record_without_message:{record.locator}")
        return
    uuid = data.get("uuid")
    if not isinstance(uuid, str) or not uuid:
        builder.add_reason(f"assistant_record_without_uuid:{record.locator}")
        return
    message_id = message.get("id") if isinstance(message.get("id"), str) else None
    key = message_id or uuid
    start_ms = parse_timestamp_ms(data.get("timestamp"))
    seq = depths.get(uuid)
    parent_uuid = data.get("parentUuid") if isinstance(data.get("parentUuid"), str) else None
    call = builder.model_calls.get(key)
    if call is None:
        call = {
            "id": uuid,
            "locator": record.locator,
            "message_id": message_id,
            "parent_uuid": parent_uuid,
            "start_ms": start_ms,
            "seq": seq,
            "record_uuids": [uuid],
            "model": None,
            "usage": None,
            "stop_reason": None,
            "error": data.get("isApiErrorMessage") is True,
        }
        builder.model_calls[key] = call
        builder.model_call_order.append(key)
    else:
        call["record_uuids"].append(uuid)
        if data.get("isApiErrorMessage") is True:
            call["error"] = True
    # Later lines of a streamed message carry the final usage / stop reason.
    if isinstance(message.get("model"), str):
        call["model"] = message["model"]
    usage = message.get("usage")
    if isinstance(usage, Mapping):
        call["usage"] = usage
    if isinstance(message.get("stop_reason"), str):
        call["stop_reason"] = message["stop_reason"]

    for index, block in enumerate(_content_blocks(record.data)):
        block_locator = f"{record.locator}#/message/content/{index}"
        block_type = block.get("type") if isinstance(block, Mapping) else None
        if block_type == "tool_use":
            tool_id = block.get("id")
            if not isinstance(tool_id, str) or not tool_id:
                builder.add_reason(f"tool_use_without_id:{block_locator}")
                continue
            name = block.get("name") if isinstance(block.get("name"), str) else None
            args = block.get("input")
            builder.tool_uses[tool_id] = _ToolUse(
                id=tool_id,
                name=name,
                args_fingerprint=fingerprint(args) if args is not None else None,
                locator=block_locator,
                parent_event_id=call["id"],
                parent_uuid=parent_uuid,
                start_ms=start_ms,
                seq=seq,
            )
        elif block_type not in IGNORED_BLOCK_TYPES:
            builder.unknown_blocks.setdefault(str(block_type), []).append(block_locator)


def _map_user(builder: _RunBuilder, record: _Record) -> None:
    data = record.data
    end_ms = parse_timestamp_ms(data.get("timestamp"))
    record_uuid = data.get("uuid") if isinstance(data.get("uuid"), str) else None
    for index, block in enumerate(_content_blocks(record.data)):
        block_locator = f"{record.locator}#/message/content/{index}"
        block_type = block.get("type") if isinstance(block, Mapping) else None
        if block_type == "tool_result":
            tool_id = block.get("tool_use_id")
            if not isinstance(tool_id, str) or not tool_id:
                builder.add_reason(f"tool_result_without_tool_use_id:{block_locator}")
                continue
            content = block.get("content")
            builder.tool_results[tool_id] = _ToolResult(
                tool_use_id=tool_id,
                locator=block_locator,
                is_error=block.get("is_error") is True,
                result_bytes=utf8_length(content if content is not None else ""),
                result_fingerprint=fingerprint(content) if content is not None else None,
                end_ms=end_ms,
                record_uuid=record_uuid,
            )
        elif block_type not in IGNORED_BLOCK_TYPES:
            builder.unknown_blocks.setdefault(str(block_type), []).append(block_locator)


def _map_record(builder: _RunBuilder, record: _Record, depths: dict[str, int]) -> None:
    data = record.data
    if data.get("isSidechain") is True and not isinstance(data.get("agentId"), str):
        builder.unmapped_sidechain.append(record.locator)
        return
    version = data.get("version")
    if isinstance(version, str) and version and version not in builder.versions:
        builder.versions.append(version)
    ts = parse_timestamp_ms(data.get("timestamp"))
    if ts is not None:
        builder.timestamps.append(ts)
    record_type = data.get("type")
    if record_type == "assistant":
        _map_assistant(builder, record, depths)
    elif record_type == "user":
        _map_user(builder, record)
    elif record_type in IGNORED_RECORD_TYPES:
        builder.ignored_types[record_type] = builder.ignored_types.get(record_type, 0) + 1
    else:
        builder.unknown_types.setdefault(str(record_type), []).append(record.locator)


# --- Run assembly ----------------------------------------------------------


def _model_call_event(call: Mapping[str, Any]) -> Event:
    usage = call["usage"]
    counts: dict[str, int | None] = dict.fromkeys(_USAGE_INT_FIELDS)
    if usage is not None:
        counts = {name: _optional_int(usage.get(name)) for name in _USAGE_INT_FIELDS}
    has_usage = usage is not None
    scope: dict[str, Any] = {"parent_uuid": call["parent_uuid"], "message_id": call["message_id"]}
    if len(call["record_uuids"]) > 1:
        scope["record_uuids"] = list(call["record_uuids"])
    return Event(
        id=call["id"],
        source_locator=call["locator"],
        kind="model_call",
        status="error" if call["error"] else ("ok" if has_usage else "unknown"),
        seq=call["seq"],
        model=call["model"],
        adapter="claude-code",
        token_basis=CLAUDE_SESSION_TOKEN_BASIS if has_usage else None,
        start_ms=call["start_ms"],
        error_type="api_error" if call["error"] else None,
        tokens_in=counts["input_tokens"],
        tokens_out=counts["output_tokens"],
        cache_read_tokens=counts["cache_read_input_tokens"],
        cache_write_tokens=counts["cache_creation_input_tokens"],
        finish_reason=call["stop_reason"],
        scope={SCOPE_NAMESPACE: scope},
    )


def _tool_call_event(use: _ToolUse | None, result: _ToolResult | None) -> Event:
    """One ``tool_call`` from a ``tool_use`` block and/or its ``tool_result`` block."""
    if use is not None:
        tool_id, locator = use.id, use.locator
    elif result is not None:
        tool_id, locator = result.tool_use_id, result.locator
    else:  # pragma: no cover - callers always pass at least one side
        raise ValueError("a tool_call needs a tool_use or a tool_result")
    start_ms = use.start_ms if use is not None else None
    end_ms = result.end_ms if result is not None else None
    duration = end_ms - start_ms if start_ms is not None and end_ms is not None else None
    status = "unknown" if result is None else ("error" if result.is_error else "ok")
    scope: dict[str, Any] = {}
    if use is not None:
        scope["parent_uuid"] = use.parent_uuid
    if result is not None:
        scope["result_record_uuid"] = result.record_uuid
        scope["result_locator"] = result.locator
    return Event(
        id=tool_id,
        source_locator=locator,
        kind="tool_call",
        status=status,
        parent_id=use.parent_event_id if use is not None else None,
        seq=use.seq if use is not None else None,
        name=use.name if use is not None else None,
        adapter="claude-code",
        start_ms=start_ms,
        end_ms=end_ms,
        duration_ms=duration if duration is not None and duration >= 0 else None,
        error_type="tool_error" if status == "error" else None,
        tool_call_id=tool_id,
        native_tool_call_id=tool_id,
        args_fingerprint=use.args_fingerprint if use is not None else None,
        result_fingerprint=result.result_fingerprint if result is not None else None,
        result_bytes=result.result_bytes if result is not None else None,
        scope={SCOPE_NAMESPACE: scope},
    )


def _build_run(builder: _RunBuilder, known_tool_uses: frozenset[str]) -> Run:
    """Turn one builder into an un-normalized :class:`Run` with its coverage notes.

    ``known_tool_uses`` holds every ``tool_use`` id seen in *any* loaded file, so
    a result whose call sits in another part of a split session is not flagged.
    """
    events: list[Event] = [
        _model_call_event(builder.model_calls[key]) for key in builder.model_call_order
    ]
    for tool_id in sorted(set(builder.tool_uses) | set(builder.tool_results)):
        events.append(
            _tool_call_event(builder.tool_uses.get(tool_id), builder.tool_results.get(tool_id))
        )
    orphans = sorted(set(builder.tool_results) - known_tool_uses)
    if orphans:
        builder.add_reason("tool_result_without_tool_use")
        builder.notes.append(
            CoverageNote(
                code="tool_result_without_tool_use",
                message=(
                    f"{len(orphans)} tool_result block(s) reference tool_use ids not found in "
                    "the loaded files (continuation of a session not passed in?)"
                ),
                fields=["name", "args_fingerprint"],
                event_ids=orphans,
            )
        )
    for record_type in sorted(builder.unknown_types):
        locators = builder.unknown_types[record_type]
        builder.add_reason(f"unknown_record_type:{record_type}")
        builder.notes.append(
            CoverageNote(
                code="unknown_record_type",
                message=(
                    f"{len(locators)} record(s) of unrecognised top-level type {record_type!r} "
                    f"were not mapped (first at {locators[0]})"
                ),
            )
        )
    for block_type in sorted(builder.unknown_blocks):
        locators = builder.unknown_blocks[block_type]
        builder.add_reason(f"unknown_content_block:{block_type}")
        builder.notes.append(
            CoverageNote(
                code="unknown_content_block",
                message=(
                    f"{len(locators)} content block(s) of unrecognised type {block_type!r} "
                    f"were not mapped (first at {locators[0]})"
                ),
            )
        )
    if builder.unmapped_sidechain:
        builder.add_reason("sidechain_without_agent_id")
        builder.notes.append(
            CoverageNote(
                code="sidechain_without_agent_id",
                message=(
                    f"{len(builder.unmapped_sidechain)} isSidechain record(s) carry no agentId "
                    "and were left out rather than merged into the parent run "
                    f"(first at {builder.unmapped_sidechain[0]})"
                ),
            )
        )
    for record_type in sorted(builder.ignored_types):
        builder.notes.append(
            CoverageNote(
                code="ignored_record_type",
                message=(
                    f"{builder.ignored_types[record_type]} record(s) of type {record_type!r} "
                    "carry no model or tool operation and were ignored"
                ),
            )
        )
    if builder.sidechain_agents:
        builder.notes.append(
            CoverageNote(
                code="sidechain_split",
                message=(
                    "subagent (sidechain) records were loaded as separate run(s): "
                    + ", ".join(builder.sidechain_agents)
                ),
            )
        )
    source_refs = [builder.path, *(_VERSION_REF_PREFIX + v for v in builder.versions)]
    if not builder.versions:
        builder.notes.append(
            CoverageNote(
                code="claude_code_version_unknown",
                message="no record carried a Claude Code 'version' string",
            )
        )
    return Run(
        id=builder.run_id,
        source_format=FORMAT_LABEL,
        conversation_id=builder.conversation_id,
        source_refs=source_refs,
        started_at=min(builder.timestamps) if builder.timestamps else None,
        ended_at=max(builder.timestamps) if builder.timestamps else None,
        coverage=Coverage(
            completeness="incomplete" if builder.reasons else "complete",
            reasons=list(builder.reasons),
            notes=list(builder.notes),
        ),
        events=events,
    )


def _runs_for_file(
    locator_path: str,
    records: list[_Record],
    problems: list[tuple[str, str]],
    depths: dict[str, int],
    known_tool_uses: frozenset[str],
) -> tuple[list[Run], list[LoadError]]:
    sessions = [
        r.data["sessionId"]
        for r in records
        if isinstance(r.data.get("sessionId"), str) and r.data["sessionId"]
    ]
    if not sessions:
        return [], [
            LoadError(
                path=locator_path,
                reason=(
                    "no record carries a sessionId; not a Claude Code session log"
                    if records
                    else "no JSON records found"
                ),
                locator=problems[0][0] if problems else None,
            )
        ]
    default_session = sessions[0]
    builders: dict[str, _RunBuilder] = {}
    order: list[str] = []
    without_session = 0
    for record in records:
        if not isinstance(record.data.get("sessionId"), str):
            without_session += 1
        run_id, conversation_id = _record_run_key(record, default_session)
        builder = builders.get(run_id)
        if builder is None:
            builder = _RunBuilder(run_id=run_id, conversation_id=conversation_id, path=locator_path)
            builders[run_id] = builder
            order.append(run_id)
        _map_record(builder, record, depths)
    main = builders.get(default_session)
    for run_id in order:
        if run_id != default_session and main is not None:
            main.sidechain_agents.append(run_id)
    for locator, problem in problems:
        target = main if main is not None else builders[order[0]]
        target.add_reason(f"unparseable_line:{locator}")
        target.notes.append(CoverageNote(code="unparseable_line", message=f"{locator}: {problem}"))
    if without_session and main is not None:
        main.notes.append(
            CoverageNote(
                code="records_without_session_id",
                message=(
                    f"{without_session} record(s) carry no sessionId and were attributed to "
                    "the file's first session"
                ),
            )
        )
    return [_build_run(builders[run_id], known_tool_uses) for run_id in order], []


# --- Entry point -----------------------------------------------------------


def _expand_paths(paths: Sequence[str | Path]) -> tuple[list[tuple[Path, str]], list[LoadError]]:
    files: list[tuple[Path, str]] = []
    errors: list[LoadError] = []
    for given in paths:
        p = Path(given)
        if p.is_dir():
            children = _jsonl_files(p)
            if not children:
                errors.append(LoadError(path=str(given), reason="directory holds no *.jsonl files"))
            files.extend((child, str(Path(given) / child.name)) for child in children)
        elif p.is_file():
            files.append((p, str(given)))
        else:
            errors.append(LoadError(path=str(given), reason="path is not a file or directory"))
    files.sort(key=lambda item: item[1])  # caller order never changes the output
    return files, errors


def load(
    paths: Sequence[str | Path] | str | Path,
    config: Any = None,
    *,
    experimental: bool = False,
) -> LoadResult:
    """Load Claude Code session logs into normalized runs.

    ``paths`` are files or directories; a directory contributes only the
    ``*.jsonl`` regular files directly inside it. Nothing outside ``paths`` is
    ever opened. Unless ``experimental=True`` is passed or ``config`` carries a
    true ``experimental`` (or ``experimental_claude_session``) flag, the result
    holds no runs and one :class:`LoadError` explaining how to opt in.

    Runs sharing an ``id`` across files are merged with
    :func:`agentlint.dedup.normalize_runs`; the result is sorted by run id so
    the output is byte-identical for the same input.
    """
    path_list: list[str | Path] = (
        [paths] if isinstance(paths, str | Path) else list(paths)  # type: ignore[list-item]
    )
    if not _experimental_enabled(config, experimental):
        return LoadResult(format_label=FORMAT_LABEL, errors=[experimental_error(path_list)])
    files, errors = _expand_paths(path_list)
    parsed: list[tuple[str, list[_Record], list[tuple[str, str]]]] = []
    for path, locator_path in files:
        try:
            records, problems = _read_records(path, locator_path)
        except (OSError, UnicodeDecodeError) as exc:
            errors.append(LoadError(path=locator_path, reason=f"cannot read file: {exc}"))
            continue
        parsed.append((locator_path, records, problems))
    all_records = [r for _, records, _ in parsed for r in records]
    depths = _depths(all_records)
    known_tool_uses = _tool_use_ids(all_records)
    runs: list[Run] = []
    for locator_path, records, problems in parsed:
        file_runs, file_errors = _runs_for_file(
            locator_path, records, problems, depths, known_tool_uses
        )
        runs.extend(file_runs)
        errors.extend(file_errors)
    normalized = sorted(normalize_runs(runs), key=lambda r: r.id)
    errors.sort(key=lambda e: (e.path, e.locator or ""))
    return LoadResult(format_label=FORMAT_LABEL, runs=normalized, errors=errors)
