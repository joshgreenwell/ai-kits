"""TL-D1 (JG-132): ``agentlint analyze`` — order, incomplete handling, formats, selection."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest

from tests.conftest import FIXTURES, complete_records, run_cli, write_bundle

OTLP = FIXTURES / "otlp"
GEN_CURRENT = OTLP / "gen_current.json"
MALFORMED = OTLP / "malformed_record.json"
LANGFUSE_V2 = FIXTURES / "langfuse" / "observations_v2.json"
VALID_BUNDLE = FIXTURES / "record_bundle" / "valid_bundle.json"


@pytest.fixture
def finding_bundle(tmp_path: Path) -> Path:
    """A fully covered run whose tool result is oversized: one proven finding, exit 0."""
    return write_bundle(tmp_path / "finding.json", "run-finding", complete_records(70000))


@pytest.fixture
def complete_bundle(tmp_path: Path) -> Path:
    """A fully covered run with nothing to report: the honest negative."""
    return write_bundle(tmp_path / "complete.json", "run-complete", complete_records())


# --- Text output order ----------------------------------------------------------


class TestTextOrder:
    def test_coverage_then_findings_then_stats(self, finding_bundle: Path) -> None:
        result = run_cli("analyze", str(finding_bundle))
        assert result.code == 0, result.err
        out = result.out
        coverage, findings, stats = (
            out.index("Coverage:"),
            out.index("Findings ("),
            out.index("Stats:"),
        )
        assert coverage < findings < stats
        assert "OVERSIZED_TOOL_RESULT [proven/high]" in out
        assert "thresholds: min_result_bytes=65536" in out
        assert "evidence (2 citation(s)):" in out  # the result and its projected correlation
        assert "tc-01 @ " in out
        assert "latency (ms, min/p50/p90/max)" in out
        assert "tokens by basis" in out
        assert "input_excludes_cache_read: calls=2 in=2200 out=100" in out

    def test_evidence_is_collapsed_to_one_finding_per_pattern(self, tmp_path: Path) -> None:
        records = complete_records(70000)
        extra = [
            {
                **records[1],
                "id": f"tc-0{i}",
                "tool_call_id": f"call-000{i}",
                "seq": 10 + i,
                "start_ms": 5000 + i * 100,
                "end_ms": 5050 + i * 100,
            }
            for i in range(2, 6)
        ]
        path = write_bundle(tmp_path / "many.json", "run-many", [*records, *extra])
        document = run_cli(
            "analyze", str(path), "--rules", "OVERSIZED_TOOL_RESULT", "--format", "json"
        ).json()
        findings = document["runs"][0]["findings"]
        # tc-01 is followed by a model call (its pattern text carries the projected
        # correlation); tc-02..tc-05 share one pattern and collapse into one finding
        assert [len(f["evidence"]) for f in findings] == [2, 4]
        assert [e["event_id"] for e in findings[1]["evidence"]] == [
            "tc-02",
            "tc-03",
            "tc-04",
            "tc-05",
        ]
        text = run_cli("analyze", str(path), "--rules", "OVERSIZED_TOOL_RESULT").out
        assert text.count("OVERSIZED_TOOL_RESULT [proven/high]") == 2
        assert "evidence (4 citation(s)):" in text and "... +1 more" in text
        assert re.search(r"evidence \(4 citation\(s\)\):\n(\s+- tc-0[234] @ [^\n]+\n){3}", text)

    def test_honest_negative_is_not_called_clean(self, complete_bundle: Path) -> None:
        result = run_cli("analyze", str(complete_bundle))
        assert result.code == 0, result.err
        assert "Findings: none (coverage complete)" in result.out
        assert "clean" not in result.out.lower()


# --- Incomplete is never rendered as clean ---------------------------------------


class TestIncompleteNeverClean:
    @pytest.mark.parametrize("fmt", ["text", "md"])
    def test_rule_abstention_is_prominent(self, fmt: str) -> None:
        result = run_cli("analyze", str(GEN_CURRENT), "--format", fmt)
        assert result.code == 2
        assert "incomplete for rules: [CONTEXT_GROWTH]" in result.out
        assert "INCOMPLETE" in result.out
        assert "coverage complete" not in result.out
        assert "clean result" in result.out  # "not a clean result"
        assert "none (coverage complete)" not in result.out.lower()

    def test_incomplete_run_reason_is_printed_before_findings(self) -> None:
        result = run_cli("analyze", str(MALFORMED))
        assert result.code == 2
        assert "Coverage: INCOMPLETE" in result.out
        assert "reason:" in result.out
        assert result.out.index("Coverage: INCOMPLETE") < result.out.index("Findings")
        assert "not a clean result" in result.out

    def test_json_summary_marks_incomplete(self) -> None:
        result = run_cli("analyze", str(GEN_CURRENT), "--format", "json")
        document = result.json()
        assert document["summary"]["incomplete"] is True
        assert document["summary"]["exit_code"] == 2
        run = document["runs"][0]
        assert run["summary"] == "incomplete for rules: [CONTEXT_GROWTH]"
        assert run["incomplete_for_rules"] == ["CONTEXT_GROWTH"]
        assert run["abstentions"][0]["fields"] == ["token_basis(model_call)"]


# --- JSON: full model and byte determinism --------------------------------------


class TestJson:
    def test_document_is_the_full_model(self) -> None:
        document = run_cli("analyze", str(GEN_CURRENT), "--format", "json").json()
        assert set(document) == {
            "agentlint_version",
            "options",
            "inputs",
            "incomplete",
            "runs",
            "summary",
        }
        run = document["runs"][0]
        assert set(run) == {
            "run",
            "coverage",
            "findings",
            "abstentions",
            "errors",
            "incomplete_for_rules",
            "rules_run",
            "summary",
            "thresholds",
            "stats",
            "exclusions",
        }
        assert run["run"]["events"] and "raw_records" not in run["run"]
        assert run["run"]["raw_records_retained"] == 5
        assert set(run["thresholds"]) == {
            "CONTEXT_GROWTH",
            "IDENTICAL_RETRY_AFTER_FAILURE",
            "NO_PROGRESS_CYCLE",
            "OVERSIZED_TOOL_RESULT",
            "REPEATED_TOOL_RESULT",
        }
        assert run["stats"]["latency"][0]["kind"] == "aggregate"
        assert run["exclusions"]["config"]["tag_namespace"] == "agentlint"
        assert document["inputs"][0]["files"][0]["loader"] == "otlp-json"

    def test_two_runs_are_byte_identical(self) -> None:
        first = run_cli("analyze", str(OTLP), "--format", "json")
        second = run_cli("analyze", str(OTLP), "--format", "json")
        assert first.out.encode("utf-8") == second.out.encode("utf-8")
        assert first.out.endswith("}\n")
        assert json.dumps(first.json(), sort_keys=True, indent=2, ensure_ascii=False) + "\n" == (
            first.out
        )

    def test_absent_values_are_null_never_zero(self) -> None:
        document = run_cli("analyze", str(GEN_CURRENT), "--format", "json").json()
        stats = document["runs"][0]["stats"]
        assert stats["tokens_by_basis"] == []
        assert stats["calls_without_token_basis"] == 2
        events = document["runs"][0]["run"]["events"]
        assert any(e["seq"] is None for e in events)


# --- Markdown: shareable and content-free ----------------------------------------


class TestMarkdown:
    def test_markdown_has_sections_in_order_and_no_content(self, finding_bundle: Path) -> None:
        raw = {"command": "SYNTHETIC-CONTENT-MARKER list --all", "note": "SYNTHETIC-NOTE"}
        path = write_bundle(
            finding_bundle.parent / "md.json", "run-md", complete_records(70000, raw=raw)
        )
        result = run_cli("analyze", str(path), "--format", "md")
        assert result.code == 0, result.err
        out = result.out
        assert out.startswith("# agentlint ")
        assert out.index("### Coverage") < out.index("### Findings") < out.index("### Stats")
        assert "| `OVERSIZED_TOOL_RESULT` | proven / high |" in out
        assert "min_result_bytes=65536" in out
        assert "SYNTHETIC-CONTENT-MARKER" not in out and "SYNTHETIC-NOTE" not in out
        assert "list --all" not in out

    def test_markdown_incomplete_inputs_come_first(self, tmp_path: Path) -> None:
        shutil.copy(GEN_CURRENT, tmp_path / "a.json")
        (tmp_path / "notes.txt").write_text("not a trace\n", encoding="utf-8")
        result = run_cli("analyze", str(tmp_path), "--format", "md")
        assert result.code == 2
        assert result.out.index("## Incomplete input (1)") < result.out.index("## Inputs")
        assert "notes.txt" in result.out and "**not analysed**" in result.out


# --- --run, --rules, --config ------------------------------------------------------


class TestSelection:
    def test_run_selects_one_run_of_a_multi_run_input(self) -> None:
        everything = run_cli("analyze", str(LANGFUSE_V2), "--format", "json").json()
        ids = [r["run"]["id"] for r in everything["runs"]]
        assert len(ids) == 2
        one = run_cli("analyze", str(LANGFUSE_V2), "--run", ids[1], "--format", "json").json()
        assert [r["run"]["id"] for r in one["runs"]] == [ids[1]]
        assert one["summary"]["runs_loaded"] == 2

    def test_unknown_run_id_is_exit_3_and_lists_loaded_runs(self) -> None:
        result = run_cli("analyze", str(LANGFUSE_V2), "--run", "no-such-run")
        assert result.code == 3
        assert "run 'no-such-run' not found; loaded runs:" in result.out
        assert "trace-" in result.out

    def test_rules_restricts_the_rule_set(self, complete_bundle: Path) -> None:
        document = run_cli(
            "analyze",
            str(complete_bundle),
            "--rules",
            "NO_PROGRESS_CYCLE,OVERSIZED_TOOL_RESULT",
            "--format",
            "json",
        ).json()
        run = document["runs"][0]
        assert run["rules_run"] == ["NO_PROGRESS_CYCLE", "OVERSIZED_TOOL_RESULT"]
        assert set(run["thresholds"]) == {"NO_PROGRESS_CYCLE", "OVERSIZED_TOOL_RESULT"}
        assert document["options"]["rules"] == ["NO_PROGRESS_CYCLE", "OVERSIZED_TOOL_RESULT"]

    def test_unknown_rule_id_is_a_usage_error_listing_valid_ids(self, complete_bundle) -> None:
        result = run_cli("analyze", str(complete_bundle), "--rules", "NOPE")
        assert result.code == 1
        assert "unknown rule ID(s) NOPE" in result.err
        assert "NO_PROGRESS_CYCLE" in result.err
        assert result.out == ""

    def test_config_loads_thresholds_and_they_are_shown(
        self, complete_bundle: Path, tmp_path: Path
    ) -> None:
        config = tmp_path / "agentlint.toml"
        config.write_text("[rules.OVERSIZED_TOOL_RESULT]\nmin_result_bytes = 100\n", "utf-8")
        before = run_cli("analyze", str(complete_bundle))
        assert before.code == 0 and "Findings: none" in before.out
        after = run_cli("analyze", str(complete_bundle), "--config", str(config))
        assert after.code == 0, after.err  # findings never change the exit code
        assert "Findings (1):" in after.out
        assert "thresholds: min_result_bytes=100" in after.out
        document = run_cli(
            "analyze", str(complete_bundle), "--config", str(config), "--format", "json"
        ).json()
        assert document["options"]["config"] == str(config)
        assert document["runs"][0]["thresholds"]["OVERSIZED_TOOL_RESULT"] == {
            "min_result_bytes": 100
        }

    def test_bad_config_is_a_usage_error(self, complete_bundle: Path, tmp_path: Path) -> None:
        config = tmp_path / "agentlint.toml"
        config.write_text("[rules.OVERSIZED_TOOL_RESULT]\nnope = 1\n", "utf-8")
        result = run_cli("analyze", str(complete_bundle), "--config", str(config))
        assert result.code == 1 and "unknown threshold(s) nope" in result.err
        assert result.out == ""
        config.write_text("this is not toml [", "utf-8")
        result = run_cli("analyze", str(complete_bundle), "--config", str(config))
        assert result.code == 1 and "invalid TOML" in result.err
        config.write_text("[loaders]\nunknown_key = 1\n", "utf-8")
        result = run_cli("analyze", str(complete_bundle), "--config", str(config))
        assert result.code == 1 and "unknown [loaders] key(s) unknown_key" in result.err
        result = run_cli("analyze", str(complete_bundle), "--config", str(tmp_path / "none"))
        assert result.code == 1 and "cannot read config" in result.err


# --- Negative case: mixed-format directory -------------------------------------------


class TestMixedDirectory:
    @pytest.fixture
    def mixed(self, tmp_path: Path) -> Path:
        shutil.copy(GEN_CURRENT, tmp_path / "trace.json")
        shutil.copy(VALID_BUNDLE, tmp_path / "bundle.json")
        shutil.copy(FIXTURES / "langfuse" / "observations_v2.csv", tmp_path / "obs.csv")
        shutil.copy(OTLP / "jsonl" / "split_part1.jsonl", tmp_path / "spans.jsonl")
        shutil.copy(FIXTURES / "claude_session" / "healthy.jsonl", tmp_path / "session.jsonl")
        (tmp_path / "notes.txt").write_text("not a trace\n", encoding="utf-8")
        (tmp_path / "nested").mkdir()
        return tmp_path

    def test_each_file_has_its_loader_and_unloadable_files_are_incomplete(self, mixed) -> None:
        result = run_cli("analyze", str(mixed), "--format", "json")
        assert result.code == 2
        document = result.json()
        files = {f["path"]: f for f in document["inputs"][0]["files"]}
        by_name = {Path(p).name: f for p, f in files.items()}
        assert by_name["trace.json"]["loader"] == "otlp-json"
        assert by_name["bundle.json"]["loader"] == "record-bundle"
        assert by_name["obs.csv"]["loader"] == "langfuse-observations"
        assert by_name["spans.jsonl"]["loader"] == "otlp-jsonl"
        assert by_name["session.jsonl"]["loader"] == "claude-session-jsonl"
        assert by_name["session.jsonl"]["status"] == "experimental_disabled"
        assert by_name["notes.txt"]["status"] == "unloadable"
        assert by_name["notes.txt"]["loader"] is None
        assert by_name["nested"]["status"] == "skipped"
        for name in ("trace.json", "bundle.json", "obs.csv", "spans.jsonl"):
            assert by_name[name]["status"] == "loaded" and by_name[name]["run_ids"]
        incomplete = {Path(i["path"]).name: i for i in document["incomplete"]}
        assert set(incomplete) == {"notes.txt", "session.jsonl"}
        assert "no loader recognised" in incomplete["notes.txt"]["reason"]
        assert "--experimental-claude-session" in incomplete["session.jsonl"]["reason"]
        # each run's source_format is the loader of the file it came from
        formats = {r["run"]["id"]: r["run"]["source_format"] for r in document["runs"]}
        for entry in by_name.values():
            for run_id in entry["run_ids"]:
                assert formats[run_id] == entry["loader"]
        run_refs = {r["run"]["id"]: r["run"]["source_refs"] for r in document["runs"]}
        assert any(files[p]["path"] in refs for p in files for refs in run_refs.values())

    def test_text_prints_incomplete_block_first(self, mixed: Path) -> None:
        result = run_cli("analyze", str(mixed))
        assert result.code == 2
        assert result.out.index("INCOMPLETE INPUT (2)") < result.out.index("== run ")
        assert "notes.txt: no loader recognised this file" in result.out

    def test_loader_override_forces_one_loader(self, mixed: Path) -> None:
        result = run_cli("analyze", str(mixed / "bundle.json"), "--loader", "otlp-json")
        assert result.code == 3
        assert "[otlp-json]" in result.out
        result = run_cli("analyze", str(mixed / "trace.json"), "--loader", "nope")
        assert result.code == 1 and "invalid choice" in result.err


class TestOutputTarget:
    def test_output_writes_exactly_one_file(self, complete_bundle: Path, tmp_path: Path) -> None:
        target = tmp_path / "out" / "report.json"
        target.parent.mkdir()
        before = sorted(p.name for p in tmp_path.iterdir())
        result = run_cli(
            "analyze", str(complete_bundle), "--format", "json", "--output", str(target)
        )
        assert result.code == 0 and result.out == ""
        assert sorted(p.name for p in tmp_path.iterdir()) == before
        assert [p.name for p in target.parent.iterdir()] == ["report.json"]
        assert json.loads(target.read_text("utf-8"))["summary"]["exit_code"] == 0
