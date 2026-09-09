"""Loader registry: detect a loader per file, load, and keep an input manifest (plan §2.8).

The CLI never guesses at a directory's contents. Every file it is given (or
finds directly inside a given directory) is sniffed against the registered
loaders in a fixed order; the first loader whose ``detect`` accepts the file
loads it, an explicit ``--loader`` label overrides detection for every file,
and files no loader accepts are reported as unloadable rather than skipped.
The result is an :class:`InputManifest` that records, per file, which loader
was used and which runs came out of it, plus the list of everything that
could not be loaded — the ``incomplete`` block the renderers print first.

The experimental ``claude-session-jsonl`` loader is gated: unless
``LoaderOptions.experimental_claude_session`` is set (``--experimental-claude-session``
or ``[loaders] experimental_claude_session = true`` in ``agentlint.toml``), a
file it would accept is reported under ``incomplete`` with the flag named and
the loader is never invoked.

What this module never does:

* never descends into subdirectories (they are listed as skipped);
* never opens a path the caller did not name (directory children aside);
* never touches the network, and never writes a file;
* never turns "no loader recognised this file" into silence.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any

from agentlint.dedup import normalize_runs
from agentlint.loaders import claude_session, langfuse, otlp_json, otlp_jsonl, record_bundle
from agentlint.loaders.base import LoadResult
from agentlint.model import Run
from agentlint.tokens import DEFAULT_TOKEN_CONFIG, TokenConfig

LOADERS: tuple[ModuleType, ...] = (otlp_json, otlp_jsonl, langfuse, record_bundle, claude_session)
"""Registered loader modules in detection order (first accepting loader wins)."""

LOADER_LABELS: tuple[str, ...] = tuple(m.FORMAT_LABEL for m in LOADERS)
"""Format labels accepted by ``--loader``."""

EXPERIMENTAL_LABELS: frozenset[str] = frozenset({claude_session.FORMAT_LABEL})
"""Loaders that run only when explicitly enabled."""

STATUS_LOADED = "loaded"
STATUS_UNLOADABLE = "unloadable"
STATUS_NOT_DETECTED = "not_detected"  # placeholder before detection; never in a result
STATUS_EXPERIMENTAL_DISABLED = "experimental_disabled"
STATUS_MISSING = "missing"
STATUS_SKIPPED = "skipped"


@dataclass(frozen=True, slots=True)
class LoaderOptions:
    """Options the CLI passes down to loaders.

    ``loader`` is an explicit format label that overrides detection;
    ``experimental_claude_session`` enables the gated loader; ``otlp_token_basis``
    and ``otlp_run_id_attribute`` are forwarded to the OTLP loaders; ``token``
    is the shared token configuration used for normalization.
    """

    loader: str | None = None
    experimental_claude_session: bool = False
    otlp_token_basis: str | None = None
    otlp_run_id_attribute: str | None = None
    token: TokenConfig = DEFAULT_TOKEN_CONFIG

    def to_dict(self) -> dict[str, Any]:
        return {
            "loader": self.loader,
            "experimental_claude_session": self.experimental_claude_session,
            "otlp_token_basis": self.otlp_token_basis,
            "otlp_run_id_attribute": self.otlp_run_id_attribute,
        }


DEFAULT_LOADER_OPTIONS = LoaderOptions()


@dataclass(slots=True)
class FileEntry:
    """One file (or skipped subdirectory) of the input manifest."""

    path: str
    status: str
    loader: str | None = None
    reason: str | None = None
    run_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "status": self.status,
            "loader": self.loader,
            "reason": self.reason,
            "run_ids": list(self.run_ids),
        }


@dataclass(slots=True)
class InputEntry:
    """One command-line input: a file, a directory, or a path that does not exist."""

    path: str
    kind: str
    files: list[FileEntry] = field(default_factory=list)

    @property
    def loaded_any_run(self) -> bool:
        return any(f.run_ids for f in self.files)

    def to_dict(self) -> dict[str, Any]:
        return {"path": self.path, "kind": self.kind, "files": [f.to_dict() for f in self.files]}


@dataclass(frozen=True, slots=True)
class IncompleteInput:
    """Something that could not be loaded; rendered before anything else."""

    path: str
    reason: str
    loader: str | None = None
    locator: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "reason": self.reason,
            "loader": self.loader,
            "locator": self.locator,
        }


@dataclass(slots=True)
class InputManifest:
    """Everything loaded from the command-line inputs, and everything that was not."""

    inputs: list[InputEntry] = field(default_factory=list)
    runs: list[Run] = field(default_factory=list)
    incomplete: list[IncompleteInput] = field(default_factory=list)

    @property
    def inputs_without_runs(self) -> list[str]:
        """Inputs (as given) from which no run at all was loaded."""
        return [entry.path for entry in self.inputs if not entry.loaded_any_run]

    def to_dict(self) -> dict[str, Any]:
        return {
            "inputs": [entry.to_dict() for entry in self.inputs],
            "incomplete": [item.to_dict() for item in self.incomplete],
        }


def loader_by_label(label: str) -> ModuleType:
    """The registered loader module whose ``FORMAT_LABEL`` is ``label``.

    Raises ``ValueError`` naming the valid labels for an unknown one.
    """
    for module in LOADERS:
        if label == module.FORMAT_LABEL:
            return module
    raise ValueError(f"unknown loader {label!r}; valid loaders: {', '.join(LOADER_LABELS)}")


def detect_loader(path: str | Path, override: str | None = None) -> str | None:
    """The format label of the first loader whose ``detect`` accepts ``path``.

    ``override`` (an explicit ``--loader`` label) short-circuits detection.
    Returns ``None`` when no loader accepts the file. Only ``path`` is opened.
    """
    if override is not None:
        loader_by_label(override)
        return override
    p = Path(path)
    if not p.is_file():
        return None
    for module in LOADERS:
        if module.detect(p):
            return module.FORMAT_LABEL
    return None


def _config_for(module: ModuleType, options: LoaderOptions) -> Any:
    """The ``config`` argument each loader expects (their signatures differ)."""
    if module in (otlp_json, otlp_jsonl):
        return {
            "token_config": options.token,
            "token_basis": options.otlp_token_basis,
            "run_id_attribute": options.otlp_run_id_attribute,
        }
    if module is claude_session:
        return {"experimental_claude_session": options.experimental_claude_session}
    return options.token


def _call_loader(module: ModuleType, files: Sequence[str], options: LoaderOptions) -> LoadResult:
    config = _config_for(module, options)
    if module is claude_session:
        return module.load(list(files), config, experimental=options.experimental_claude_session)
    return module.load(list(files), config)


def _expand_inputs(paths: Iterable[str | Path]) -> list[InputEntry]:
    entries: list[InputEntry] = []
    for given in paths:
        label = str(given)
        p = Path(given)
        if p.is_dir():
            entry = InputEntry(path=label, kind="directory")
            for child in sorted(p.iterdir(), key=lambda c: c.name):
                child_label = str(Path(label) / child.name)
                if child.is_dir():
                    entry.files.append(
                        FileEntry(
                            path=child_label,
                            status=STATUS_SKIPPED,
                            reason="subdirectories are not descended; pass them explicitly",
                        )
                    )
                elif child.is_file():
                    entry.files.append(FileEntry(path=child_label, status=STATUS_NOT_DETECTED))
            entries.append(entry)
        elif p.is_file():
            entries.append(
                InputEntry(
                    path=label,
                    kind="file",
                    files=[FileEntry(path=label, status=STATUS_NOT_DETECTED)],
                )
            )
        else:
            entries.append(
                InputEntry(
                    path=label,
                    kind="missing",
                    files=[
                        FileEntry(path=label, status=STATUS_MISSING, reason="path does not exist")
                    ],
                )
            )
    return entries


def _runs_for_file(path: str, runs: Sequence[Run]) -> list[str]:
    ids: list[str] = []
    for run in runs:
        if path in run.source_refs or any(e.source_locator.startswith(path) for e in run.events):
            ids.append(run.id)
    return ids


def _attribute(
    label: str, files: list[FileEntry], result: LoadResult, manifest: InputManifest
) -> None:
    """Fill in per-file status from one loader's result; unattributable errors go to incomplete."""
    attributed: set[str] = set()
    for entry in files:
        entry.run_ids = _runs_for_file(entry.path, result.runs)
        attributed.update(entry.run_ids)
    unattributed = [r.id for r in result.runs if r.id not in attributed]
    for entry in files:
        errors = [e for e in result.errors if e.path == entry.path]
        if entry.run_ids:
            entry.status = STATUS_LOADED
            entry.reason = None
        elif errors:
            entry.status = STATUS_UNLOADABLE
            entry.reason = errors[0].reason
            for error in errors:
                manifest.incomplete.append(
                    IncompleteInput(
                        path=error.path, reason=error.reason, loader=label, locator=error.locator
                    )
                )
        elif unattributed:
            entry.status = STATUS_LOADED
            entry.run_ids = list(unattributed)
        else:
            entry.status = STATUS_UNLOADABLE
            entry.reason = "loader produced no run for this file"
            manifest.incomplete.append(
                IncompleteInput(path=entry.path, reason=entry.reason, loader=label)
            )
    file_paths = {f.path for f in files}
    for error in result.errors:
        if error.path not in file_paths:
            manifest.incomplete.append(
                IncompleteInput(
                    path=error.path, reason=error.reason, loader=label, locator=error.locator
                )
            )


def load_inputs(
    paths: Iterable[str | Path],
    options: LoaderOptions | None = None,
    call: Callable[[ModuleType, Sequence[str], LoaderOptions], LoadResult] | None = None,
) -> InputManifest:
    """Detect, gate and load every file under ``paths``; never raises for bad input.

    Files are grouped by loader and each loader receives its group in one
    call, so runs split across files still merge by run ID. Runs from
    different groups that share an ID are merged too (a ``merge_conflict``
    note records a ``source_format`` disagreement). Runs come back sorted by
    ID. ``call`` exists for tests that stand in for a loader.
    """
    options = options or DEFAULT_LOADER_OPTIONS
    invoke = call or _call_loader
    manifest = InputManifest(inputs=_expand_inputs(paths))
    groups: dict[str, list[FileEntry]] = {}
    for entry in manifest.inputs:
        for file_entry in entry.files:
            if file_entry.status != STATUS_NOT_DETECTED:
                if file_entry.status == STATUS_MISSING:
                    manifest.incomplete.append(
                        IncompleteInput(path=file_entry.path, reason=file_entry.reason or "")
                    )
                continue
            label = detect_loader(file_entry.path, options.loader)
            if label is None:
                file_entry.status = STATUS_UNLOADABLE
                file_entry.reason = "no loader recognised this file"
                manifest.incomplete.append(
                    IncompleteInput(path=file_entry.path, reason=file_entry.reason)
                )
                continue
            file_entry.loader = label
            if label in EXPERIMENTAL_LABELS and not options.experimental_claude_session:
                file_entry.status = STATUS_EXPERIMENTAL_DISABLED
                file_entry.reason = (
                    f"the {label} loader is experimental; enable it with "
                    f"{claude_session.CLI_FLAG} or [loaders] experimental_claude_session = true"
                )
                manifest.incomplete.append(
                    IncompleteInput(path=file_entry.path, reason=file_entry.reason, loader=label)
                )
                continue
            groups.setdefault(label, []).append(file_entry)

    all_runs: list[Run] = []
    for label in sorted(groups):
        files = groups[label]
        module = loader_by_label(label)
        result = invoke(module, [f.path for f in files], options)
        _attribute(label, files, result, manifest)
        all_runs.extend(result.runs)
    manifest.runs = sorted(normalize_runs(all_runs, options.token), key=lambda r: r.id)
    manifest.incomplete.sort(key=lambda i: (i.path, i.loader or "", i.reason))
    return manifest


def options_from_mapping(data: Mapping[str, Any], source: str = "config") -> LoaderOptions:
    """Build :class:`LoaderOptions` from an ``agentlint.toml`` ``[loaders]`` table.

    Recognised keys: ``experimental_claude_session`` (bool), ``otlp_token_basis``
    (str), ``otlp_run_id_attribute`` (str), ``loader`` (str). Any other key is
    a ``ValueError`` — a typo is reported, never ignored.
    """
    known = {"experimental_claude_session", "otlp_token_basis", "otlp_run_id_attribute", "loader"}
    unknown = sorted(k for k in data if k not in known)
    if unknown:
        raise ValueError(
            f"unknown [loaders] key(s) {', '.join(unknown)} in {source}; "
            f"known: {', '.join(sorted(known))}"
        )
    experimental = data.get("experimental_claude_session", False)
    if not isinstance(experimental, bool):
        raise ValueError(f"[loaders] experimental_claude_session in {source} must be a boolean")
    for key in ("otlp_token_basis", "otlp_run_id_attribute", "loader"):
        if key in data and not isinstance(data[key], str):
            raise ValueError(f"[loaders] {key} in {source} must be a string")
    loader = data.get("loader")
    if loader is not None:
        loader_by_label(loader)
    return LoaderOptions(
        loader=loader,
        experimental_claude_session=experimental,
        otlp_token_basis=data.get("otlp_token_basis"),
        otlp_run_id_attribute=data.get("otlp_run_id_attribute"),
    )
