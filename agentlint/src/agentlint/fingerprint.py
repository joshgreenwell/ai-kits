"""Fingerprint utilities: canonical JSON, minimum length, representation label.

Plan §2.5 rule 4 and §2.9. A fingerprint is SHA-256 over canonical JSON
(sorted keys, arrays in order, ints / floats / strings kept distinct).

What this module never does:

* never hashes an input shorter than :data:`MIN_HASH_INPUT_BYTES` bytes —
  such hashes are trivially reversible, so :func:`fingerprint` returns ``None``;
* never claims two values are equal unless both fingerprints exist, both are
  ``full``, and neither is the hash of a placeholder (``{}``, ``""``, ``[]``,
  ``null``);
* never stores or returns the value itself.
"""

from __future__ import annotations

import hashlib
from typing import Any

from agentlint.model import REPRESENTATIONS, Fingerprint, canonical_json

MIN_HASH_INPUT_BYTES = 16
"""Inputs whose canonical JSON is shorter than this are never hashed."""

PLACEHOLDER_VALUES: tuple[Any, ...] = ({}, "", [], None)
"""Values that mean "nothing was recorded" rather than "the args were empty"."""


def canonical_bytes(value: Any) -> bytes:
    """UTF-8 bytes of the canonical JSON form of ``value``.

    Key order and whitespace do not affect the result; array order does.
    ``1``, ``1.0`` and ``"1"`` produce different bytes.
    """
    return canonical_json(value).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    """Lowercase hex SHA-256 of ``data``."""
    return hashlib.sha256(data).hexdigest()


PLACEHOLDER_HASHES: frozenset[str] = frozenset(
    sha256_hex(canonical_bytes(v)) for v in PLACEHOLDER_VALUES
)
"""Hashes of the placeholder values, so externally supplied placeholder
fingerprints are recognised even though :func:`fingerprint` never emits them."""


def is_placeholder(value: Any) -> bool:
    """True for ``{}``, ``""``, ``[]`` and ``None`` — values that carry no information."""
    return any(value == p and type(value) is type(p) for p in PLACEHOLDER_VALUES)


def utf8_length(value: Any) -> int:
    """Size in bytes of the model-visible form of ``value``.

    Strings are measured as UTF-8; any other JSON value is measured as its
    canonical JSON text. This is the definition behind ``Event.result_bytes``.
    """
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    return len(canonical_bytes(value))


def fingerprint(value: Any, representation: str = "full") -> Fingerprint | None:
    """Fingerprint ``value`` or return ``None`` when it is too short to hash safely.

    ``representation`` says how much of the original the caller is passing in:
    ``full`` (the whole model-visible value), ``redacted`` (secrets removed) or
    ``truncated`` (an export cut it off). Placeholders are always shorter than
    :data:`MIN_HASH_INPUT_BYTES` and therefore never fingerprinted.
    """
    if representation not in REPRESENTATIONS:
        raise ValueError(f"representation must be one of {sorted(REPRESENTATIONS)}")
    data = canonical_bytes(value)
    if len(data) < MIN_HASH_INPUT_BYTES:
        return None
    return Fingerprint(hash=sha256_hex(data), representation=representation)


def is_placeholder_fingerprint(fp: Fingerprint | None) -> bool:
    """True when ``fp`` is the hash of a placeholder value, wherever it came from."""
    return fp is not None and fp.hash in PLACEHOLDER_HASHES


def fingerprints_equal(a: Fingerprint | None, b: Fingerprint | None) -> bool:
    """Equality claim between two fingerprints, abstaining (``False``) when unsafe.

    Returns ``False`` — meaning "no claim", not "different" — when either side
    is ``None``, is not ``full``, or is a placeholder hash. Only two ``full``
    non-placeholder fingerprints with the same hash are reported equal.
    """
    if a is None or b is None:
        return False
    if a.representation != "full" or b.representation != "full":
        return False
    if is_placeholder_fingerprint(a) or is_placeholder_fingerprint(b):
        return False
    return a.hash == b.hash
