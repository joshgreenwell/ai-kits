"""TL-A3 (JG-119): canonical JSON fingerprints, minimum length, representation, abstention."""

from __future__ import annotations

import pytest

from agentlint.fingerprint import (
    MIN_HASH_INPUT_BYTES,
    PLACEHOLDER_HASHES,
    canonical_bytes,
    fingerprint,
    fingerprints_equal,
    is_placeholder,
    is_placeholder_fingerprint,
    sha256_hex,
    utf8_length,
)
from agentlint.model import Fingerprint

LONG = {"query": "an argument value that is comfortably long", "limit": 10}


class TestCanonicalForm:
    def test_key_order_and_whitespace_do_not_matter(self) -> None:
        a = fingerprint({"b": [1, 2], "a": "value long enough"})
        b = fingerprint({"a": "value long enough", "b": [1, 2]})
        assert a is not None and b is not None
        assert a.hash == b.hash
        assert a == Fingerprint(
            hash=sha256_hex(canonical_bytes({"a": "value long enough", "b": [1, 2]})),
            representation="full",
        )

    def test_canonical_bytes_have_no_whitespace_and_sorted_keys(self) -> None:
        assert canonical_bytes({"z": 1, "a": {"y": 2, "b": 3}}) == b'{"a":{"b":3,"y":2},"z":1}'

    def test_arrays_keep_order(self) -> None:
        a = fingerprint({"items": [1, 2, 3, 4, 5, 6, 7]})
        b = fingerprint({"items": [7, 6, 5, 4, 3, 2, 1]})
        assert a is not None and b is not None
        assert a.hash != b.hash

    def test_int_float_string_not_conflated(self) -> None:
        as_int = fingerprint({"value": 1, "padding": "xxxxxxxx"})
        as_float = fingerprint({"value": 1.0, "padding": "xxxxxxxx"})
        as_str = fingerprint({"value": "1", "padding": "xxxxxxxx"})
        assert as_int is not None and as_float is not None and as_str is not None
        assert len({as_int.hash, as_float.hash, as_str.hash}) == 3

    def test_bool_not_conflated_with_int(self) -> None:
        a = fingerprint({"flag": True, "padding": "xxxxxxxx"})
        b = fingerprint({"flag": 1, "padding": "xxxxxxxx"})
        assert a is not None and b is not None
        assert a.hash != b.hash

    def test_unicode_is_measured_and_hashed_as_utf8(self) -> None:
        fp = fingerprint("héllo wörld ünïcode")
        assert fp is not None
        assert utf8_length("héllo") == 6
        assert utf8_length({"a": "b"}) == len(b'{"a":"b"}')

    def test_hash_is_stable_across_calls(self) -> None:
        assert fingerprint(LONG) == fingerprint(dict(LONG))
        assert fingerprint(LONG).hash == sha256_hex(canonical_bytes(LONG))  # type: ignore[union-attr]


class TestMinimumLength:
    def test_constant(self) -> None:
        assert MIN_HASH_INPUT_BYTES == 16

    @pytest.mark.parametrize("value", [{}, "", [], None, "short", {"a": 1}, [1, 2, 3], 12345])
    def test_inputs_shorter_than_16_bytes_return_none(self, value: object) -> None:
        assert len(canonical_bytes(value)) < MIN_HASH_INPUT_BYTES
        assert fingerprint(value) is None

    def test_exactly_16_bytes_is_hashed(self) -> None:
        value = "fourteen chars"  # 14 chars + 2 quotes = 16 bytes canonical
        assert len(canonical_bytes(value)) == 16
        assert fingerprint(value) is not None

    def test_fifteen_bytes_is_not_hashed(self) -> None:
        value = "thirteen char"  # 13 + 2 = 15
        assert len(canonical_bytes(value)) == 15
        assert fingerprint(value) is None


class TestRepresentation:
    def test_default_is_full(self) -> None:
        assert fingerprint(LONG).representation == "full"  # type: ignore[union-attr]

    @pytest.mark.parametrize("rep", ["full", "redacted", "truncated"])
    def test_label_is_kept(self, rep: str) -> None:
        assert fingerprint(LONG, representation=rep).representation == rep  # type: ignore[union-attr]

    def test_unknown_label_rejected(self) -> None:
        with pytest.raises(ValueError):
            fingerprint(LONG, representation="partial")


class TestEquality:
    def test_two_full_fingerprints_of_same_value_are_equal(self) -> None:
        assert fingerprints_equal(fingerprint(LONG), fingerprint(dict(LONG))) is True

    def test_different_values_are_not_equal(self) -> None:
        assert fingerprints_equal(fingerprint(LONG), fingerprint({**LONG, "limit": 11})) is False

    def test_abstains_when_either_is_none(self) -> None:
        assert fingerprints_equal(None, fingerprint(LONG)) is False
        assert fingerprints_equal(fingerprint(LONG), None) is False
        assert fingerprints_equal(None, None) is False

    @pytest.mark.parametrize("rep", ["redacted", "truncated"])
    def test_abstains_when_either_is_not_full(self, rep: str) -> None:
        full = fingerprint(LONG)
        partial = fingerprint(LONG, representation=rep)
        assert partial is not None and partial.hash == full.hash  # type: ignore[union-attr]
        assert fingerprints_equal(full, partial) is False
        assert fingerprints_equal(partial, full) is False
        assert fingerprints_equal(partial, partial) is False

    @pytest.mark.parametrize("placeholder", [{}, "", [], None])
    def test_placeholders_never_produce_an_equality_claim(self, placeholder: object) -> None:
        assert is_placeholder(placeholder)
        # Same bytes on both sides, yet no claim: the fingerprint is never made.
        assert fingerprint(placeholder) is None
        assert fingerprints_equal(fingerprint(placeholder), fingerprint(placeholder)) is False
        # A placeholder hash supplied by an external source is recognised too.
        external = Fingerprint(hash=sha256_hex(canonical_bytes(placeholder)), representation="full")
        assert external.hash in PLACEHOLDER_HASHES
        assert is_placeholder_fingerprint(external)
        assert fingerprints_equal(external, external) is False

    def test_placeholder_detection_is_type_strict(self) -> None:
        assert not is_placeholder(0)
        assert not is_placeholder(False)
        assert not is_placeholder({"a": 1})
