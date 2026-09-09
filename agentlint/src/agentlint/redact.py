"""Snippet redaction for ``--include-snippets`` (plan §2.9).

By default no renderer prints content: findings cite identifiers, hashes,
counts and sizes only. With ``--include-snippets`` a finding's evidence may
be accompanied by a *snippet*: the canonical JSON of the raw source record
the evidence cites, taken from ``Run.raw_records`` (an OTLP span, a
record-bundle record's ``raw`` value, or the record itself when it carries
no ``raw``), passed through :func:`redact_text` and then cut to
:data:`SNIPPET_MAX_CHARS` characters.
Redaction happens **before** truncation so a secret can never be cut in a
way that hides it from the patterns.

Patterns redacted (each replaced by a labelled ``[REDACTED:<kind>]`` marker):

* API keys of the ``sk-...`` family;
* AWS access key IDs (``AKIA...``) and ``aws_secret_access_key`` values;
* ``Bearer <token>`` authorization values;
* GitHub tokens (``ghp_...``, ``github_pat_...``, ``gho_``, ``ghs_``, ``ghr_``);
* Slack tokens (``xoxb-``, ``xoxp-``, ``xoxa-``, ``xoxr-``, ``xoxs-``);
* PEM private-key blocks (``-----BEGIN ... PRIVATE KEY-----``);
* the value of any field whose name contains ``password``, ``passwd``,
  ``pwd``, ``secret``, ``token``, ``api_key`` / ``apikey``, ``access_key``,
  ``private_key``, ``authorization`` or ``credential`` (JSON, ``key=value``
  and ``key: value`` forms).

What this module never does:

* never reads a file or a network resource — it only transforms text it is
  given;
* never returns more than :data:`SNIPPET_MAX_CHARS` characters from
  :func:`snippet`;
* never invents a snippet: when no raw record matches the evidence, the
  result is ``None``.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from agentlint.model import Evidence, Run, canonical_json

SNIPPET_MAX_CHARS = 200
"""Hard cap on the length of any snippet, ellipsis included."""

ELLIPSIS = "…"

_KEY_NAMES = (
    r"password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|"
    r"private[_-]?key|authorization|credential"
)

_PATTERNS: tuple[tuple[str, re.Pattern[str], str], ...] = (
    (
        "private-key",
        re.compile(
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
            re.DOTALL,
        ),
        "[REDACTED:private-key]",
    ),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]{8,}"), "Bearer [REDACTED:bearer]"),
    ("aws-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b"), "[REDACTED:aws-key]"),
    (
        "github-token",
        re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
        "[REDACTED:github-token]",
    ),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{8,}\b"), "[REDACTED:slack-token]"),
    ("api-key", re.compile(r"\bsk-[A-Za-z0-9_\-]{8,}\b"), "[REDACTED:api-key]"),
    (
        "secret-field",
        re.compile(
            r"(?i)([\"']?[A-Za-z0-9_\-]*(?:" + _KEY_NAMES + r")[A-Za-z0-9_\-]*[\"']?"
            r"\s*[:=]\s*[\"']?)(?!\[REDACTED)([^\"'\s,;&}\]]+)"
        ),
        r"\1[REDACTED]",
    ),
)
"""``(kind, pattern, replacement)`` in application order."""

REDACTION_KINDS: tuple[str, ...] = tuple(kind for kind, _, _ in _PATTERNS)


def redact_text(text: str) -> str:
    """Replace every credential-looking value in ``text`` with a labelled marker.

    Applies every pattern in :data:`_PATTERNS`; a text with nothing to
    redact comes back unchanged. Idempotent.
    """
    for _kind, pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def truncate(text: str, limit: int = SNIPPET_MAX_CHARS) -> str:
    """Cut ``text`` to at most ``limit`` characters, ending in an ellipsis when cut."""
    if len(text) <= limit:
        return text
    return text[: limit - len(ELLIPSIS)] + ELLIPSIS


def _resolve_pointer(document: Any, pointer: str) -> Any:
    """Resolve an RFC 6901 JSON pointer (``/records/3``) inside ``document``."""
    if not pointer:
        return document
    current = document
    for token in pointer.lstrip("/").split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, Mapping) and token in current:
            current = current[token]
        elif isinstance(current, list) and token.isdigit() and int(token) < len(current):
            current = current[int(token)]
        else:
            return None
    return current


def raw_record_for(run: Run, evidence: Evidence) -> Any:
    """The raw source record cited by ``evidence``, or ``None`` when none matches.

    Looks, in order, for a raw record whose ``source_locator`` / ``locator``
    equals the evidence locator, one whose ``id`` / ``row_id`` / ``event_id``
    / ``span_id`` equals the evidence event ID, and finally a document in
    which the locator's JSON pointer fragment (``<file>#/records/3``)
    resolves. A wrapper is unwrapped to the original: an OTLP wrapper yields
    its ``span``, a record-bundle record its ``raw`` value when it has one.
    Never synthesises.
    """
    for record in run.raw_records:
        if not isinstance(record, Mapping):
            continue
        if evidence.source_locator in (record.get("source_locator"), record.get("locator")):
            return _unwrap(record)
    for record in run.raw_records:
        if not isinstance(record, Mapping):
            continue
        for key in ("id", "row_id", "event_id", "span_id"):
            if record.get(key) == evidence.event_id:
                return _unwrap(record)
    _file, sep, fragment = evidence.source_locator.partition("#")
    if sep and fragment.startswith("/"):
        for record in run.raw_records:
            resolved = _resolve_pointer(record, fragment)
            if resolved is not None:
                return _unwrap(resolved)
    return None


def _unwrap(record: Any) -> Any:
    """The original record inside a loader wrapper (``span`` / ``raw``), else the record."""
    if isinstance(record, Mapping):
        for key in ("span", "raw"):
            if key in record:
                return record[key]
    return record


def snippet(value: Any, limit: int = SNIPPET_MAX_CHARS) -> str:
    """Redacted, truncated canonical JSON of ``value`` (a string is used as is)."""
    text = value if isinstance(value, str) else canonical_json(value)
    return truncate(redact_text(text), limit)


def snippet_for(run: Run, evidence: Evidence, limit: int = SNIPPET_MAX_CHARS) -> str | None:
    """The snippet for one evidence item, or ``None`` when no raw record backs it."""
    record = raw_record_for(run, evidence)
    if record is None:
        return None
    return snippet(record, limit)
