"""TL-D3 (JG-134): exit codes, ``--include-snippets`` redaction, zero network, no side effects."""

from __future__ import annotations

import json
import os
import shutil
import socket
import tomllib
from pathlib import Path

import pytest

from agentlint.fingerprint import MIN_HASH_INPUT_BYTES
from agentlint.loaders.registry import detect_loader
from agentlint.redact import SNIPPET_MAX_CHARS
from tests.conftest import FIXTURES, complete_records, run_cli, write_bundle

OTLP = FIXTURES / "otlp"
ROOT = Path(__file__).resolve().parents[1]

# Synthetic credential-shaped strings built at test time so no such pattern is committed.
FAKE_AWS_KEY = "AKIA" + "SYNTHETIC0000AAA"
FAKE_API_KEY = "sk-" + "synthetic" + "0" * 24
FAKE_TOKEN = "ghp_" + "S" * 36
SECRET_MARKER = "SYNTHETIC-SECRET-CONTENT"


def _content_records() -> list[dict]:
    raw = {
        "args": {"command": f"{SECRET_MARKER} fetch --key {FAKE_API_KEY}", "password": "hunter-2"},
        "output": f"{FAKE_AWS_KEY} " + "x" * 400 + f" Bearer {FAKE_TOKEN}",
    }
    return complete_records(70000, raw=raw)


# --- Exit codes -----------------------------------------------------------------


class TestExitCodes:
    def test_0_when_everything_is_complete(self, tmp_path: Path) -> None:
        path = write_bundle(tmp_path / "ok.json", "run-ok", complete_records())
        result = run_cli("analyze", str(path))
        assert result.code == 0, result.err
        assert "exit code 0 (analysis complete)" in result.out

    def test_findings_never_change_the_exit_code(self, tmp_path: Path) -> None:
        path = write_bundle(tmp_path / "finding.json", "run-f", complete_records(70000))
        result = run_cli("analyze", str(path), "--format", "json")
        assert result.code == 0
        assert result.json()["summary"]["findings"] == 1

    def test_rule_errors_do_not_change_the_exit_code(self, tmp_path: Path) -> None:
        path = write_bundle(tmp_path / "ok.json", "run-ok", complete_records())
        module = tmp_path / "raising.py"
        module.write_text(
            "META = {'id': 'RAISING_RULE', 'title': 'Raises', 'category': 'test', "
            "'requirements': []}\n"
            "def run(run, config):\n    raise RuntimeError('boom')\n",
            encoding="utf-8",
        )
        result = run_cli("analyze", str(path), "--rules-module", str(module))
        assert result.code == 0, result.err
        assert "Rule errors (1)" in result.out and "RAISING_RULE" in result.out

    def test_2_when_coverage_is_incomplete_and_output_is_still_printed(self) -> None:
        result = run_cli("analyze", str(OTLP / "malformed_record.json"))
        assert result.code == 2
        assert "Coverage: INCOMPLETE" in result.out and "Stats:" in result.out

    def test_2_when_a_directory_has_an_unloadable_file(self, tmp_path: Path) -> None:
        shutil.copy(OTLP / "gen_current.json", tmp_path / "trace.json")
        (tmp_path / "readme.txt").write_text("hello\n", encoding="utf-8")
        result = run_cli("analyze", str(tmp_path), "--format", "json")
        assert result.code == 2
        assert [Path(i["path"]).name for i in result.json()["incomplete"]] == ["readme.txt"]

    def test_3_when_an_input_yields_no_run(self, tmp_path: Path) -> None:
        text = tmp_path / "notes.txt"
        text.write_text("not a trace\n", encoding="utf-8")
        assert run_cli("analyze", str(text)).code == 3
        assert run_cli("analyze", str(tmp_path / "missing.json")).code == 3
        bad = tmp_path / "bad.json"
        bad.write_text('{"resourceSpans": [', encoding="utf-8")
        assert run_cli("analyze", str(bad)).code == 3
        # one good input plus one unparseable input is still 3: a whole input produced nothing
        result = run_cli("analyze", str(OTLP / "gen_current.json"), str(text))
        assert result.code == 3
        assert "== run conv-0001" in result.out  # output is still printed

    def test_3_for_an_empty_directory(self, tmp_path: Path) -> None:
        assert run_cli("analyze", str(tmp_path)).code == 3

    @pytest.mark.parametrize(
        ("fixture", "label", "flags"),
        [
            ("otlp/gen_current.json", "otlp-json", ()),
            ("otlp/jsonl/split_part1.jsonl", "otlp-jsonl", ()),
            ("langfuse/observations_v2.json", "langfuse-observations", ()),
            ("record_bundle/valid_bundle.json", "record-bundle", ()),
            (
                "claude_session/healthy.jsonl",
                "claude-session-jsonl",
                ("--experimental-claude-session",),
            ),
        ],
    )
    def test_every_loader_runs_through_the_cli(self, fixture: str, label: str, flags) -> None:
        result = run_cli("analyze", str(FIXTURES / fixture), "--format", "json", *flags)
        assert result.code in (0, 2), result.err
        document = result.json()
        assert document["inputs"][0]["files"][0]["loader"] == label
        assert document["runs"], "at least one run must load"
        assert document["summary"]["exit_code"] == result.code

    def test_experimental_loader_is_gated(self) -> None:
        session = FIXTURES / "claude_session" / "healthy.jsonl"
        gated = run_cli("analyze", str(session), "--format", "json")
        assert gated.code == 3
        assert gated.json()["incomplete"][0]["reason"].count("--experimental-claude-session") == 1
        enabled = run_cli("analyze", str(session), "--experimental-claude-session")
        assert enabled.code == 0, enabled.out


# --- Content and snippets -------------------------------------------------------


class TestSnippets:
    @pytest.fixture
    def content_bundle(self, tmp_path: Path) -> Path:
        return write_bundle(tmp_path / "content.json", "run-content", _content_records())

    @pytest.mark.parametrize("fmt", ["text", "json", "md"])
    def test_default_output_contains_no_content(self, content_bundle: Path, fmt: str) -> None:
        result = run_cli("analyze", str(content_bundle), "--format", fmt)
        assert result.code == 0, result.err
        for needle in (SECRET_MARKER, FAKE_API_KEY, FAKE_AWS_KEY, FAKE_TOKEN, "hunter-2", "fetch"):
            assert needle not in result.out
        assert "snippet" not in result.out.lower() or fmt == "json"
        if fmt == "json":
            assert "snippets" not in result.json()["runs"][0]

    @pytest.mark.parametrize("fmt", ["text", "json", "md"])
    def test_include_snippets_truncates_and_redacts(self, content_bundle: Path, fmt: str) -> None:
        result = run_cli("analyze", str(content_bundle), "--format", fmt, "--include-snippets")
        assert result.code == 0, result.err
        out = result.out
        assert "[REDACTED:api-key]" in out
        assert FAKE_API_KEY not in out and "AKIA" not in out and FAKE_TOKEN not in out
        assert "hunter-2" not in out
        if fmt == "json":
            snippets = result.json()["runs"][0]["snippets"]
            text = next(v for k, v in snippets.items() if k.startswith("tc-01@"))
            assert len(text) <= SNIPPET_MAX_CHARS and text.endswith("…")
            assert "[REDACTED]" in text  # the password field
            assert all(len(v) <= SNIPPET_MAX_CHARS for v in snippets.values())
        else:
            line = next(ln for ln in out.splitlines() if "snippet:" in ln)
            snippet = line.split("snippet:", 1)[1].strip().strip("`")
            assert len(snippet) <= SNIPPET_MAX_CHARS

    def test_snippets_are_sourced_from_raw_records_only(self, tmp_path: Path) -> None:
        # a bundle without ``raw`` has nothing to show even when snippets are requested
        path = write_bundle(tmp_path / "noraw.json", "run-noraw", complete_records(70000))
        document = run_cli("analyze", str(path), "--format", "json", "--include-snippets").json()
        run = document["runs"][0]
        assert run["findings"] and "raw_records" not in run["run"]
        text = next(v for k, v in run["snippets"].items() if k.startswith("tc-01@"))
        assert '"id":"tc-01"' in text  # the cited record itself, never invented content
        assert "SYNTHETIC" not in text and len(text) <= SNIPPET_MAX_CHARS


class TestMinimumHashLength:
    def test_short_values_are_never_hashed_at_the_cli_level(self, tmp_path: Path) -> None:
        assert MIN_HASH_INPUT_BYTES == 16
        source = json.loads((OTLP / "gen_current.json").read_text(encoding="utf-8"))
        for rs in source["resourceSpans"]:
            for ss in rs["scopeSpans"]:
                for span in ss["spans"]:
                    for attribute in span["attributes"]:
                        if attribute["key"] == "gen_ai.tool.call.arguments":
                            attribute["value"] = {"stringValue": "ok"}
        short = tmp_path / "short.json"
        short.write_text(json.dumps(source), encoding="utf-8")
        original = run_cli("analyze", str(OTLP / "gen_current.json"), "--format", "json").json()
        modified = run_cli("analyze", str(short), "--format", "json").json()
        tool = lambda doc: next(  # noqa: E731
            e for e in doc["runs"][0]["run"]["events"] if e["kind"] == "tool_call"
        )
        assert tool(original)["args_fingerprint"]["hash"]
        assert tool(modified)["args_fingerprint"] is None
        for event in modified["runs"][0]["run"]["events"]:
            for key in ("args_fingerprint", "result_fingerprint"):
                fp = event[key]
                assert fp is None or len(fp["hash"]) == 64


# --- Zero network, no side effects, dependency audit --------------------------------


def _accepted_fixture_dirs() -> list[Path]:
    dirs: list[Path] = []
    for directory in [*sorted(p for p in FIXTURES.rglob("*") if p.is_dir()), FIXTURES]:
        if any(detect_loader(f) for f in directory.iterdir() if f.is_file()):
            dirs.append(directory)
    return dirs


class TestZeroNetwork:
    def test_analyze_every_accepted_fixture_directory_without_sockets(self, monkeypatch) -> None:
        def refuse(*args, **kwargs):
            raise AssertionError("network access attempted")

        monkeypatch.setattr(socket, "socket", refuse)
        monkeypatch.setattr(socket, "create_connection", refuse)
        monkeypatch.setattr(socket, "getaddrinfo", refuse)
        directories = _accepted_fixture_dirs()
        assert len(directories) >= 5, directories
        for directory in directories:
            for fmt in ("text", "json", "md"):
                result = run_cli(
                    "analyze",
                    str(directory),
                    "--format",
                    fmt,
                    "--experimental-claude-session",
                    "--include-snippets",
                )
                assert result.code in (0, 2), (directory, result.err)
                assert result.out
        assert run_cli("rules").code == 0
        assert run_cli("explain", "CONTEXT_GROWTH").code == 0

    def test_no_files_written_and_no_state_kept(self, tmp_path: Path, monkeypatch) -> None:
        home = tmp_path / "home"
        cwd = tmp_path / "cwd"
        home.mkdir()
        cwd.mkdir()
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.setenv("XDG_CACHE_HOME", str(home))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(home))
        monkeypatch.chdir(cwd)
        fixture = OTLP / "gen_current.json"
        first = run_cli("analyze", str(fixture), "--format", "json")
        second = run_cli("analyze", str(fixture), "--format", "json")
        assert first.out == second.out
        assert list(home.iterdir()) == [] and list(cwd.iterdir()) == []
        assert os.listdir(tmp_path) == ["home", "cwd"] or sorted(os.listdir(tmp_path)) == [
            "cwd",
            "home",
        ]


FORBIDDEN_PACKAGES = frozenset(
    {"pandas", "numpy", "requests", "httpx", "aiohttp", "urllib3", "openai", "anthropic", "boto3"}
)


class TestDependencyAudit:
    def test_lockfile_has_no_forbidden_packages(self) -> None:
        lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
        names = {p["name"].lower() for p in lock["package"]}
        assert not names & FORBIDDEN_PACKAGES, names & FORBIDDEN_PACKAGES
        assert not [n for n in names if "sdk" in n], [n for n in names if "sdk" in n]
        # urllib3 must not be a direct dependency of agentlint either
        agentlint = next(p for p in lock["package"] if p["name"] == "agentlint")
        direct = {d["name"] for d in agentlint.get("dependencies", [])}
        assert not direct & (FORBIDDEN_PACKAGES | {"urllib3"})

    def test_runtime_dependencies_are_cli_and_terminal_only(self) -> None:
        project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
        allowed = {"click", "rich", "colorama"}
        deps = {
            d.split("[")[0].split(">")[0].split("=")[0].strip() for d in project["dependencies"]
        }
        assert deps <= allowed, deps
        assert "argparse" not in deps  # standard library
