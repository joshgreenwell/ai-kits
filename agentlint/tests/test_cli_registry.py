"""TL-D1 (JG-132): loader registry — detection, override, gate, manifest."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from agentlint.loaders import claude_session, langfuse, otlp_json, otlp_jsonl, record_bundle
from agentlint.loaders.base import LoadError, LoadResult
from agentlint.loaders.registry import (
    EXPERIMENTAL_LABELS,
    LOADER_LABELS,
    LOADERS,
    LoaderOptions,
    detect_loader,
    load_inputs,
    loader_by_label,
    options_from_mapping,
)
from tests.conftest import FIXTURES

CASES = [
    ("otlp/gen_current.json", "otlp-json"),
    ("otlp/jsonl/split_part1.jsonl", "otlp-jsonl"),
    ("langfuse/observations_v2.json", "langfuse-observations"),
    ("langfuse/observations_v2.csv", "langfuse-observations"),
    ("langfuse/observations_v2.jsonl", "langfuse-observations"),
    ("record_bundle/valid_bundle.json", "record-bundle"),
    ("claude_session/healthy.jsonl", "claude-session-jsonl"),
]


class TestDetection:
    def test_registry_holds_the_five_loaders_in_order(self) -> None:
        assert (otlp_json, otlp_jsonl, langfuse, record_bundle, claude_session) == LOADERS
        assert LOADER_LABELS == (
            "otlp-json",
            "otlp-jsonl",
            "langfuse-observations",
            "record-bundle",
            "claude-session-jsonl",
        )
        assert {"claude-session-jsonl"} == EXPERIMENTAL_LABELS
        for label in LOADER_LABELS:
            assert label == loader_by_label(label).FORMAT_LABEL
        with pytest.raises(ValueError, match="valid loaders"):
            loader_by_label("nope")

    @pytest.mark.parametrize(("fixture", "label"), CASES)
    def test_detects_by_shape(self, fixture: str, label: str) -> None:
        assert detect_loader(FIXTURES / fixture) == label

    def test_rejects_unknown_shapes_and_non_files(self, tmp_path: Path) -> None:
        text = tmp_path / "a.txt"
        text.write_text("hello\n", encoding="utf-8")
        assert detect_loader(text) is None
        assert detect_loader(tmp_path) is None
        assert detect_loader(tmp_path / "missing") is None
        assert detect_loader(FIXTURES / "rules" / "npc_positive.json") is None

    def test_override_wins_and_is_validated(self, tmp_path: Path) -> None:
        text = tmp_path / "a.txt"
        text.write_text("hello\n", encoding="utf-8")
        assert detect_loader(text, override="otlp-json") == "otlp-json"
        with pytest.raises(ValueError, match="unknown loader"):
            detect_loader(text, override="nope")


class TestManifest:
    def test_directory_manifest_records_loader_per_file(self, tmp_path: Path) -> None:
        shutil.copy(FIXTURES / "otlp" / "gen_current.json", tmp_path / "a.json")
        shutil.copy(FIXTURES / "record_bundle" / "valid_bundle.json", tmp_path / "b.json")
        (tmp_path / "c.txt").write_text("x\n", encoding="utf-8")
        (tmp_path / "sub").mkdir()
        manifest = load_inputs([str(tmp_path)])
        (entry,) = manifest.inputs
        assert entry.kind == "directory"
        statuses = {Path(f.path).name: (f.loader, f.status) for f in entry.files}
        assert statuses == {
            "a.json": ("otlp-json", "loaded"),
            "b.json": ("record-bundle", "loaded"),
            "c.txt": (None, "unloadable"),
            "sub": (None, "skipped"),
        }
        assert [Path(i.path).name for i in manifest.incomplete] == ["c.txt"]
        assert sorted(r.id for r in manifest.runs) == ["conv-0001", "run-bundle-0001"]
        assert {r.source_format for r in manifest.runs} == {"otlp-json", "record-bundle"}
        assert manifest.inputs_without_runs == []

    def test_missing_path_is_incomplete_and_without_runs(self, tmp_path: Path) -> None:
        manifest = load_inputs([str(tmp_path / "nope.json")])
        assert manifest.inputs[0].kind == "missing"
        assert manifest.incomplete[0].reason == "path does not exist"
        assert manifest.inputs_without_runs == [str(tmp_path / "nope.json")]
        assert manifest.runs == []

    def test_experimental_gate_never_invokes_the_loader(self, tmp_path: Path) -> None:
        shutil.copy(FIXTURES / "claude_session" / "healthy.jsonl", tmp_path / "s.jsonl")
        calls: list[str] = []

        def spy(module, files, options):
            calls.append(module.FORMAT_LABEL)
            return LoadResult(format_label=module.FORMAT_LABEL)

        manifest = load_inputs([str(tmp_path)], LoaderOptions(), call=spy)
        assert calls == []
        (file_entry,) = manifest.inputs[0].files
        assert file_entry.status == "experimental_disabled"
        assert claude_session.CLI_FLAG in (file_entry.reason or "")
        enabled = load_inputs(
            [str(tmp_path)], LoaderOptions(experimental_claude_session=True), call=spy
        )
        assert calls == ["claude-session-jsonl"]
        assert enabled.inputs[0].files[0].loader == "claude-session-jsonl"

    def test_files_are_grouped_per_loader_in_one_call(self, tmp_path: Path) -> None:
        shutil.copy(FIXTURES / "otlp" / "pages" / "page_1.json", tmp_path / "p1.json")
        shutil.copy(FIXTURES / "otlp" / "pages" / "page_2.json", tmp_path / "p2.json")
        seen: list[list[str]] = []

        def spy(module, files, options):
            seen.append(list(files))
            return module.load(list(files), None)

        manifest = load_inputs([str(tmp_path)], call=spy)
        assert len(seen) == 1 and len(seen[0]) == 2
        assert len(manifest.runs) == 1  # the two pages merge into one run
        assert all(f.run_ids == [manifest.runs[0].id] for f in manifest.inputs[0].files)

    def test_loader_errors_for_a_file_make_it_unloadable(self, tmp_path: Path) -> None:
        shutil.copy(FIXTURES / "otlp" / "gen_current.json", tmp_path / "a.json")
        label = str(tmp_path / "a.json")

        def failing(module, files, options):
            return LoadResult(
                format_label=module.FORMAT_LABEL,
                errors=[LoadError(path=label, reason="synthetic failure", locator=f"{label}#/0")],
            )

        manifest = load_inputs([label], call=failing)
        (file_entry,) = manifest.inputs[0].files
        assert file_entry.status == "unloadable" and file_entry.reason == "synthetic failure"
        assert manifest.incomplete[0].locator == f"{label}#/0"
        assert manifest.incomplete[0].loader == "otlp-json"
        assert manifest.inputs_without_runs == [label]


class TestOptionsFromMapping:
    def test_reads_known_keys(self) -> None:
        options = options_from_mapping(
            {
                "experimental_claude_session": True,
                "otlp_token_basis": "input_excludes_cache_read",
                "otlp_run_id_attribute": "app.run_id",
                "loader": "otlp-json",
            }
        )
        assert options.experimental_claude_session is True
        assert options.otlp_token_basis == "input_excludes_cache_read"
        assert options.otlp_run_id_attribute == "app.run_id"
        assert options.loader == "otlp-json"
        assert options.to_dict()["loader"] == "otlp-json"

    def test_rejects_unknown_keys_and_bad_types(self) -> None:
        with pytest.raises(ValueError, match="unknown \\[loaders\\] key"):
            options_from_mapping({"experimental": True})
        with pytest.raises(ValueError, match="must be a boolean"):
            options_from_mapping({"experimental_claude_session": "yes"})
        with pytest.raises(ValueError, match="must be a string"):
            options_from_mapping({"otlp_token_basis": 1})
        with pytest.raises(ValueError, match="unknown loader"):
            options_from_mapping({"loader": "nope"})

    def test_otlp_token_basis_flows_through_to_the_run(self) -> None:
        options = LoaderOptions(otlp_token_basis="input_includes_cache_read")
        manifest = load_inputs([str(FIXTURES / "otlp" / "gen_current.json")], options)
        bases = {e.token_basis for e in manifest.runs[0].events if e.kind == "model_call"}
        assert bases == {"input_includes_cache_read"}
