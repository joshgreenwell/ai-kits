"""TL-D1/D3: run stats (numbers only) and snippet redaction helpers."""

from __future__ import annotations

import pytest

from agentlint.model import Evidence, Run
from agentlint.redact import (
    SNIPPET_MAX_CHARS,
    raw_record_for,
    redact_text,
    snippet,
    snippet_for,
    truncate,
)
from agentlint.stats import event_duration_ms, latency_stats, percentile, run_stats
from tests.conftest import make_event, make_run


class TestPercentile:
    def test_nearest_rank_is_always_an_input_value(self) -> None:
        values = [10, 20, 30, 40, 50]
        assert percentile(values, 50) == 30
        assert percentile(values, 90) == 50
        assert percentile([7], 90) == 7
        assert percentile([], 50) is None
        assert percentile([3, 1, 2], 50) == 2


class TestLatency:
    def test_duration_prefers_duration_ms_then_bounds_then_none(self) -> None:
        assert event_duration_ms(make_event("a", duration_ms=5, start_ms=0, end_ms=100)) == 5
        assert event_duration_ms(make_event("b", start_ms=10, end_ms=40)) == 30
        assert event_duration_ms(make_event("c", start_ms=10)) is None

    def test_per_kind_distribution_and_absent_is_null(self) -> None:
        events = [
            make_event("m1", start_ms=0, end_ms=100),
            make_event("m2", start_ms=0, end_ms=300),
            make_event("t1", kind="tool_call", start_ms=0, end_ms=50),
            make_event("t2", kind="tool_call"),  # no duration
            make_event("o1", kind="other"),
        ]
        stats = {s.kind: s for s in latency_stats(events)}
        assert set(stats) == {"model_call", "tool_call", "other"}
        assert (stats["model_call"].min_ms, stats["model_call"].max_ms) == (100, 300)
        assert stats["model_call"].p50_ms == 100 and stats["model_call"].p90_ms == 300
        assert stats["model_call"].slowest_event_id == "m2"
        assert (stats["tool_call"].events, stats["tool_call"].measured) == (2, 1)
        other = stats["other"]
        assert (other.min_ms, other.p50_ms, other.p90_ms, other.max_ms) == (None,) * 4
        assert other.slowest_event_id is None

    def test_run_stats_counts_and_per_basis_totals(self) -> None:
        from agentlint.dedup import normalize_run

        run = normalize_run(
            make_run(
                make_event("m1", token_basis="a", tokens_in=100, model="x", start_ms=0, end_ms=1),
                make_event("m2", token_basis="b", tokens_in=50, model="x", start_ms=2, end_ms=3),
                make_event("t1", kind="tool_call", status="error", start_ms=4, end_ms=5),
                started_at=0,
                ended_at=5,
            )
        )
        stats = run_stats(run).to_dict()
        assert stats["by_kind"] == {"model_call": 2, "tool_call": 1}
        assert stats["by_status"] == {"error": 1, "unknown": 2}
        assert stats["errors"] == 1 and stats["span_ms"] == 5
        assert [t["token_basis"] for t in stats["tokens_by_basis"]] == ["a", "b"]
        assert [t["tokens_in"] for t in stats["tokens_by_basis"]] == [100, 50]
        assert stats["tokens_by_basis"][0]["tokens_out"] is None
        assert stats["events_total"] == 3
        assert "finding" not in str(stats)


class TestRedaction:
    @pytest.mark.parametrize(
        ("text", "marker"),
        [
            ("key sk-" + "a1b2c3d4e5f6g7h8" + " end", "[REDACTED:api-key]"),
            ("AKIA" + "SYNTHETIC0000AAA", "[REDACTED:aws-key]"),
            ("Authorization: Bearer abc.def-ghi_jkl", "[REDACTED:bearer]"),
            ("ghp_" + "S" * 36, "[REDACTED:github-token]"),
            ("github_pat_" + "S" * 30, "[REDACTED:github-token]"),
            ("xoxb-" + "1234567890-abc", "[REDACTED:slack-token]"),
            (
                "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
                "[REDACTED:private-key]",
            ),
            ("-----BEGIN PRIVATE KEY-----\nMIIE (cut off)", "[REDACTED:private-key]"),
            ('{"password": "hunter-2"}', '"password": "[REDACTED]"'),
            ("aws_secret_access_key=abc/def+ghi", "aws_secret_access_key=[REDACTED]"),
            ("api-key: abc", "api-key: [REDACTED]"),
            ("credentials=abc&x=1", "credentials=[REDACTED]&x=1"),
        ],
    )
    def test_patterns_are_redacted(self, text: str, marker: str) -> None:
        redacted = redact_text(text)
        assert marker in redacted
        assert redact_text(redacted) == redacted  # idempotent

    def test_plain_text_is_unchanged(self) -> None:
        text = '{"query": "synthetic search terms", "limit": 5}'
        assert redact_text(text) == text

    def test_truncate_keeps_the_limit_including_the_ellipsis(self) -> None:
        assert truncate("x" * 200) == "x" * 200
        cut = truncate("x" * 201)
        assert len(cut) == SNIPPET_MAX_CHARS and cut.endswith("…")

    def test_snippet_redacts_before_truncating(self) -> None:
        text = "y" * 190 + " sk-" + "0123456789abcdefg"
        result = snippet(text)
        assert len(result) <= SNIPPET_MAX_CHARS
        assert "sk-" not in result


class TestRawRecordResolution:
    def _run(self, raw_records: list) -> Run:
        return make_run(
            make_event("ev-1", kind="tool_call", source_locator="bundle.json#/records/1"),
            raw_records=raw_records,
        )

    def test_matches_locator_then_id_then_json_pointer(self) -> None:
        by_locator = self._run([{"source_locator": "bundle.json#/records/1", "span": {"a": 1}}])
        evidence = Evidence(event_id="ev-1", source_locator="bundle.json#/records/1")
        assert raw_record_for(by_locator, evidence) == {"a": 1}
        by_id = self._run([{"row_id": "ev-1", "b": 2}])
        assert raw_record_for(by_id, evidence) == {"row_id": "ev-1", "b": 2}
        by_pointer = self._run([{"run_id": "r", "records": [{"id": "x"}, {"id": "ev-1", "c": 3}]}])
        assert raw_record_for(by_pointer, evidence) == {"id": "ev-1", "c": 3}
        assert raw_record_for(self._run([]), evidence) is None
        assert snippet_for(self._run([]), evidence) is None
        assert snippet_for(by_pointer, evidence) == '{"c":3,"id":"ev-1"}'
