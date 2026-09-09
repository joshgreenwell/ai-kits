"""Fixture hygiene check (JG-135): headers present, no credentials, no private identifiers.

Usage, from inside ``agentlint/``::

    uv run python scripts/check_fixture_hygiene.py            # exit 1 on any violation
    uv run python scripts/check_fixture_hygiene.py <dir>...   # check other directories

Walks ``tests/fixtures/`` and ``tests/e2e/`` and enforces three things:

1. **Every fixture declares its provenance.** A data file must carry a header
   with ``origin``, ``ref``, ``completeness`` and ``excerpt_or_raw`` — either
   as a top-level ``_fixture`` / ``fixture`` object inside a JSON document, in a
   sidecar (``<stem>.meta.json`` or ``<file>.fixture.json``), or, for the
   end-to-end controls, in the case directory's ``expected.json``.
2. **No credential-shaped strings.** AWS access keys, ``sk-`` API keys, GitHub
   and Slack tokens and PEM private-key blocks fail the check unless the line
   that carries them says ``SYNTHETIC`` / ``synthetic`` — the only way a
   deliberately fake secret may appear in a redaction fixture.
3. **No private identifiers.** The forbidden list below names the internal
   run-ID prefixes and the product name of the private application whose
   spike produced this tool. This script is the one legitimate place those
   strings appear in the public repository, because a grep needs to know
   what it is looking for; nothing else — fixtures, docs, code, tests — may
   contain them.

The script reads only the files under the directories it is given, never
touches the network, and writes nothing.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIRECTORIES = (ROOT / "tests" / "fixtures", ROOT / "tests" / "e2e")

HEADER_FIELDS = ("origin", "ref", "completeness", "excerpt_or_raw")
ORIGINS = frozenset({"synthetic", "sanitized"})
COMPLETENESS = frozenset({"complete", "incomplete"})
EXCERPT_OR_RAW = frozenset({"excerpt", "raw"})
HEADER_KEYS = ("_fixture", "fixture")
SIDECAR_SUFFIXES = (".meta.json", ".fixture.json")
EXPECTED_NAME = "expected.json"
SKIP_NAMES = frozenset({"__init__.py", "__pycache__", ".DS_Store"})
SKIP_SUFFIXES = frozenset({".py", ".pyc"})

CREDENTIAL_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("aws-access-key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("api-key", re.compile(r"sk-[A-Za-z0-9]{20,}")),
    ("github-token", re.compile(r"ghp_")),
    ("private-key-block", re.compile(r"-----BEGIN")),
    ("slack-token", re.compile(r"xox[baprs]-")),
)
"""Credential shapes that must not appear in a fixture unless marked synthetic."""

SYNTHETIC_MARKER = re.compile(r"SYNTHETIC|synthetic")
"""A line carrying a credential shape passes only if it also says it is synthetic."""

# The private identifiers of the application whose spike produced agentlint.
# They are spelled out here, and only here, so that the check can grep for
# them: two internal run-ID prefixes and the lowercase product name from the
# JG-116 "no Luumen identifiers" acceptance criterion.
PRIVATE_IDENTIFIER_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("private-run-id-prefix", re.compile(r"b6d8574d")),
    ("private-run-id-prefix", re.compile(r"f2e2ba50")),
    ("private-product-name", re.compile(r"luumen", re.IGNORECASE)),
)


def is_sidecar(path: Path) -> bool:
    """True for header sidecars (``*.meta.json``, ``*.fixture.json``, ``expected.json``)."""
    return path.name == EXPECTED_NAME or any(path.name.endswith(s) for s in SIDECAR_SUFFIXES)


def is_checked_file(path: Path) -> bool:
    """True for files the walk should look at (test code and caches are not fixtures)."""
    return (
        path.is_file()
        and path.name not in SKIP_NAMES
        and path.suffix not in SKIP_SUFFIXES
        and "__pycache__" not in path.parts
    )


def _load_json(path: Path) -> object | None:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _header_of(data: object) -> dict | None:
    if not isinstance(data, dict):
        return None
    for key in HEADER_KEYS:
        header = data.get(key)
        if isinstance(header, dict):
            return header
    return None


def find_header(path: Path, e2e_root: Path | None) -> tuple[dict | None, str]:
    """The provenance header for ``path`` and where it was found.

    Looks, in order, at the file's own top-level ``_fixture`` / ``fixture``
    object, at ``<stem>.meta.json`` and ``<file>.fixture.json`` next to it,
    and — for a file inside an end-to-end case directory — at that
    directory's ``expected.json``.
    """
    if path.suffix == ".json":
        header = _header_of(_load_json(path))
        if header is not None:
            return header, str(path)
    for candidate in (path.with_suffix(".meta.json"), path.with_name(path.name + ".fixture.json")):
        if candidate.is_file():
            data = _load_json(candidate)
            header = _header_of(data)
            if header is None and isinstance(data, dict):
                header = data
            return header, str(candidate)
    if e2e_root is not None and path.parent != e2e_root:
        expected = path.parent / EXPECTED_NAME
        if expected.is_file():
            return _header_of(_load_json(expected)), str(expected)
    return None, ""


def check_header(header: dict | None, where: str, path: Path) -> list[str]:
    """Problems with one file's header (empty when it is complete and well-formed)."""
    if header is None:
        return [
            f"{path}: no fixture header (expected _fixture/fixture, a sidecar, or expected.json)"
        ]
    problems: list[str] = []
    for field in HEADER_FIELDS:
        value = header.get(field)
        if not isinstance(value, str) or not value.strip():
            problems.append(f"{path}: header in {where} lacks {field!r}")
    for field, allowed in (
        ("origin", ORIGINS),
        ("completeness", COMPLETENESS),
        ("excerpt_or_raw", EXCERPT_OR_RAW),
    ):
        value = header.get(field)
        if isinstance(value, str) and value and value not in allowed:
            problems.append(
                f"{path}: header in {where} has {field}={value!r}; "
                f"expected one of {sorted(allowed)}"
            )
    return problems


def scan_content(path: Path) -> list[str]:
    """Credential shapes (unless marked synthetic) and private identifiers in ``path``."""
    problems: list[str] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return [f"{path}: cannot read ({exc})"]
    for number, line in enumerate(text.splitlines(), start=1):
        for label, pattern in CREDENTIAL_PATTERNS:
            if pattern.search(line) and not SYNTHETIC_MARKER.search(line):
                problems.append(
                    f"{path}:{number}: credential pattern {label} without synthetic marker"
                )
        for label, pattern in PRIVATE_IDENTIFIER_PATTERNS:
            if pattern.search(line):
                problems.append(f"{path}:{number}: private identifier ({label})")
    return problems


def check_directory(directory: Path, e2e: bool = False) -> list[str]:
    """Every hygiene problem under ``directory`` (recursively), sorted by path."""
    problems: list[str] = []
    if not directory.is_dir():
        return [f"{directory}: not a directory"]
    e2e_root = directory if e2e else None
    for path in sorted(p for p in directory.rglob("*") if is_checked_file(p)):
        problems.extend(scan_content(path))
        if is_sidecar(path):
            if path.name == EXPECTED_NAME:
                header = _header_of(_load_json(path))
                problems.extend(check_header(header, str(path), path))
            continue
        header, where = find_header(path, e2e_root)
        problems.extend(check_header(header, where, path))
    return problems


def check(directories: list[Path] | None = None) -> list[str]:
    """Run the hygiene check over ``directories`` (default: fixtures and e2e)."""
    targets = list(directories) if directories else list(DEFAULT_DIRECTORIES)
    problems: list[str] = []
    for directory in targets:
        problems.extend(check_directory(directory, e2e=directory.name == "e2e"))
    return problems


def main(argv: list[str] | None = None) -> int:
    """Print every problem and return 1 when there is at least one, else 0."""
    args = list(sys.argv[1:] if argv is None else argv)
    directories = [Path(a) for a in args] or None
    problems = check(directories)
    for problem in problems:
        print(problem)
    if problems:
        print(f"fixture hygiene: {len(problems)} problem(s)")
        return 1
    checked = ", ".join(str(d) for d in (directories or DEFAULT_DIRECTORIES))
    print(f"fixture hygiene: ok ({checked})")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
