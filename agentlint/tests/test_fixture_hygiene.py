"""Fixture hygiene (JG-135): every fixture has a header; no credentials or private IDs.

Runs ``scripts/check_fixture_hygiene.py`` against the real fixture trees and
against temporary trees with planted violations. The planted secrets below
are built at test time from fragments so the test file itself never contains
a credential-shaped string.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_fixture_hygiene.py"


@pytest.fixture(scope="module")
def hygiene():
    spec = importlib.util.spec_from_file_location("check_fixture_hygiene", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


HEADER = {
    "origin": "synthetic",
    "ref": "agentlint tests: hygiene test, generated in a temporary directory",
    "completeness": "complete",
    "excerpt_or_raw": "raw",
}


def _write_json(path: Path, data: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1), encoding="utf-8")
    return path


class TestRealTree:
    def test_committed_fixtures_and_controls_are_clean(self, hygiene, capsys) -> None:
        assert hygiene.check() == []
        assert hygiene.main([]) == 0
        assert "fixture hygiene: ok" in capsys.readouterr().out

    def test_every_data_file_is_reached(self, hygiene) -> None:
        """Both default directories exist and contain at least one checked file each."""
        for directory in hygiene.DEFAULT_DIRECTORIES:
            assert directory.is_dir(), directory
            assert any(hygiene.is_checked_file(p) for p in directory.rglob("*")), directory

    def test_forbidden_list_is_declared_only_in_the_script(self, hygiene) -> None:
        """The private identifiers appear in the script and nowhere else under agentlint/."""
        patterns = [p for _, p in hygiene.PRIVATE_IDENTIFIER_PATTERNS]
        offenders: list[str] = []
        for path in sorted(ROOT.rglob("*")):
            if not path.is_file() or path == SCRIPT:
                continue
            if any(
                part in {".venv", "__pycache__", "dist", ".pytest_cache", ".ruff_cache"}
                for part in path.parts
            ):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            if any(p.search(text) for p in patterns):
                offenders.append(str(path.relative_to(ROOT)))
        assert offenders == [], offenders


class TestHeaders:
    def test_missing_header_is_reported(self, hygiene, tmp_path: Path) -> None:
        _write_json(tmp_path / "fixtures" / "plain.json", {"records": []})
        problems = hygiene.check([tmp_path / "fixtures"])
        assert len(problems) == 1 and "no fixture header" in problems[0]

    @pytest.mark.parametrize("field", ["origin", "ref", "completeness", "excerpt_or_raw"])
    def test_each_header_field_is_required(self, hygiene, tmp_path: Path, field: str) -> None:
        header = dict(HEADER)
        del header[field]
        _write_json(tmp_path / "fixtures" / "run.json", {"_fixture": header, "records": []})
        problems = hygiene.check([tmp_path / "fixtures"])
        assert problems == [
            f"{tmp_path / 'fixtures' / 'run.json'}: header in "
            f"{tmp_path / 'fixtures' / 'run.json'} lacks {field!r}"
        ]

    def test_header_vocabulary_is_checked(self, hygiene, tmp_path: Path) -> None:
        header = {**HEADER, "origin": "production", "excerpt_or_raw": "full"}
        _write_json(tmp_path / "fixtures" / "run.json", {"fixture": header, "records": []})
        problems = hygiene.check([tmp_path / "fixtures"])
        assert len(problems) == 2
        assert any("origin='production'" in p for p in problems)
        assert any("excerpt_or_raw='full'" in p for p in problems)

    def test_sidecars_cover_jsonl_and_csv(self, hygiene, tmp_path: Path) -> None:
        d = tmp_path / "fixtures"
        d.mkdir()
        (d / "log.jsonl").write_text('{"a": 1}\n', encoding="utf-8")
        _write_json(d / "log.meta.json", HEADER)
        (d / "rows.csv").write_text("id,traceId\nobs-1,trace-1\n", encoding="utf-8")
        _write_json(d / "rows.csv.fixture.json", HEADER)
        assert hygiene.check([d]) == []
        (d / "orphan.jsonl").write_text("{}\n", encoding="utf-8")
        problems = hygiene.check([d])
        assert len(problems) == 1 and "orphan.jsonl" in problems[0]

    def test_e2e_case_directory_is_covered_by_expected_json(self, hygiene, tmp_path: Path) -> None:
        e2e = tmp_path / "e2e"
        case = e2e / "some_control"
        (case / "trace.jsonl").parent.mkdir(parents=True)
        (case / "trace.jsonl").write_text("{}\n", encoding="utf-8")
        (case / "agentlint.toml").write_text("[loaders]\n", encoding="utf-8")
        _write_json(case / "expected.json", {"_fixture": HEADER, "exit_code": 0})
        assert hygiene.check([e2e]) == []
        # a case without a header in expected.json fails for expected.json and every data file
        _write_json(case / "expected.json", {"exit_code": 0})
        problems = hygiene.check([e2e])
        assert len(problems) == 3, problems
        assert all("no fixture header" in p for p in problems)

    def test_file_at_e2e_root_needs_its_own_header(self, hygiene, tmp_path: Path) -> None:
        e2e = tmp_path / "e2e"
        _write_json(e2e / "stray.json", {"records": []})
        _write_json(e2e / "expected.json", {"_fixture": HEADER})
        problems = hygiene.check([e2e])
        assert len(problems) == 1 and "stray.json" in problems[0]


def _planted_secrets() -> dict[str, str]:
    """Credential-shaped strings assembled at test time (never present verbatim in the repo)."""
    return {
        "aws-access-key": "AKIA" + "ABCDEFGHIJKLMNOP",
        "api-key": "sk-" + "a1b2c3d4e5f6a1b2c3d4e5f6",
        "github-token": "gh" + "p_" + "0000",
        "private-key-block": "-----" + "BEGIN PRIVATE KEY-----",
        "slack-token": "xox" + "b-0000",
    }


class TestCredentials:
    @pytest.mark.parametrize("label", sorted(_planted_secrets()))
    def test_credential_pattern_fails_without_synthetic_marker(
        self, hygiene, tmp_path: Path, label: str
    ) -> None:
        value = _planted_secrets()[label]
        _write_json(
            tmp_path / "fixtures" / "run.json",
            {"_fixture": HEADER, "records": [{"id": "r-1", "raw": {"token": value}}]},
        )
        problems = hygiene.check([tmp_path / "fixtures"])
        assert len(problems) == 1 and f"credential pattern {label}" in problems[0], problems

    @pytest.mark.parametrize("marker", ["SYNTHETIC", "synthetic"])
    def test_credential_pattern_passes_when_marked_synthetic(
        self, hygiene, tmp_path: Path, marker: str
    ) -> None:
        value = _planted_secrets()["aws-access-key"]
        path = tmp_path / "fixtures" / "run.json"
        path.parent.mkdir()
        path.write_text(
            json.dumps(
                {"_fixture": HEADER, "records": [{"id": "r-1", "note": marker, "v": value}]}
            ),
            encoding="utf-8",
        )
        assert hygiene.check([tmp_path / "fixtures"]) == []

    def test_sidecars_are_scanned_too(self, hygiene, tmp_path: Path) -> None:
        d = tmp_path / "fixtures"
        d.mkdir()
        (d / "log.jsonl").write_text("{}\n", encoding="utf-8")
        _write_json(d / "log.meta.json", {**HEADER, "notes": _planted_secrets()["api-key"]})
        problems = hygiene.check([d])
        assert len(problems) == 1 and "log.meta.json" in problems[0]


class TestPrivateIdentifiers:
    def test_each_forbidden_pattern_is_reported(self, hygiene, tmp_path: Path) -> None:
        for index, (label, pattern) in enumerate(hygiene.PRIVATE_IDENTIFIER_PATTERNS):
            # the forbidden strings come from the script's own list; never spelled out here
            sample = (
                pattern.pattern.upper() if "IGNORECASE" in str(pattern.flags) else pattern.pattern
            )
            _write_json(
                tmp_path / "fixtures" / f"run-{index}.json",
                {"_fixture": HEADER, "run_id": f"{sample}-0001"},
            )
            problems = hygiene.check([tmp_path / "fixtures"])
            assert any(f"run-{index}.json" in p and label in p for p in problems), problems

    def test_private_product_name_is_case_insensitive(self, hygiene, tmp_path: Path) -> None:
        name = next(
            p.pattern
            for label, p in hygiene.PRIVATE_IDENTIFIER_PATTERNS
            if label == "private-product-name"
        )
        _write_json(tmp_path / "fixtures" / "run.json", {"_fixture": HEADER, "app": name.title()})
        problems = hygiene.check([tmp_path / "fixtures"])
        assert len(problems) == 1 and "private-product-name" in problems[0]

    def test_main_reports_every_problem_and_exits_1(self, hygiene, tmp_path: Path, capsys) -> None:
        _write_json(tmp_path / "fixtures" / "a.json", {"records": []})
        _write_json(tmp_path / "fixtures" / "b.json", {"records": []})
        assert hygiene.main([str(tmp_path / "fixtures")]) == 1
        out = capsys.readouterr().out
        assert "a.json" in out and "b.json" in out and "2 problem(s)" in out
