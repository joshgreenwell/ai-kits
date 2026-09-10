"""Release prep (JG-137): build, console script from a fresh environment, no-network runtime.

These tests build the distribution with ``uv build``, install the wheel into
a fresh virtual environment with ``uv pip install --offline`` (the wheel has
no dependencies, so nothing needs to be fetched), and run the installed
``agentlint`` console script as a subprocess — once normally and once with
``socket.socket`` replaced by a function that raises, installed through a
``sitecustomize.py`` so that the whole process, not just the test, is
network-free. They are marked ``slow`` (they take a few seconds) and still
run in CI.

The build and install steps happen once per session in a temporary
directory; nothing is written under the repository.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
HEALTHY = ROOT / "tests" / "e2e" / "healthy_run" / "bundle.json"
AGGREGATE = ROOT / "tests" / "e2e" / "aggregate_usage_only" / "bundle.json"
UV = shutil.which("uv")

pytestmark = pytest.mark.slow


SITECUSTOMIZE = '''\
"""Refuse every socket for the life of this interpreter (no-network smoke test)."""
import socket


def _refuse(*args, **kwargs):
    raise RuntimeError("network access attempted: " + repr(args))


socket.socket = _refuse
socket.create_connection = _refuse
socket.getaddrinfo = _refuse
socket.socketpair = _refuse
'''


@dataclass(frozen=True)
class Installed:
    """A built distribution installed into a fresh virtual environment."""

    dist: Path
    sdist: Path
    wheel: Path
    venv: Path
    script: Path
    sandbox: Path  # directory holding sitecustomize.py


def _run(args: list[str], cwd: Path | None = None, env: dict[str, str] | None = None):
    return subprocess.run(
        args, cwd=cwd, env=env, capture_output=True, text=True, timeout=300, check=False
    )


@pytest.fixture(scope="session")
def installed(tmp_path_factory: pytest.TempPathFactory) -> Installed:
    if UV is None:
        pytest.skip("uv is not on PATH; the packaging smoke test needs it")
    base = tmp_path_factory.mktemp("packaging")
    dist = base / "dist"

    build = _run([UV, "build", "--out-dir", str(dist)], cwd=ROOT)
    assert build.returncode == 0, build.stderr
    sdists = sorted(dist.glob("agentlint-*.tar.gz"))
    wheels = sorted(dist.glob("agentlint-*-py3-none-any.whl"))
    assert len(sdists) == 1 and len(wheels) == 1, sorted(p.name for p in dist.iterdir())

    venv = base / "fresh-venv"
    created = _run([UV, "venv", "--python", sys.executable, str(venv)])
    assert created.returncode == 0, created.stderr
    python = venv / ("Scripts" if os.name == "nt" else "bin") / "python"
    # --offline: the wheel has zero dependencies, so installing it must not need the network
    install = _run([UV, "pip", "install", "--offline", "--python", str(python), str(wheels[0])])
    assert install.returncode == 0, install.stderr
    script = python.with_name("agentlint" + (".exe" if os.name == "nt" else ""))
    assert script.is_file(), sorted(p.name for p in script.parent.iterdir())

    sandbox = base / "no-network"
    sandbox.mkdir()
    (sandbox / "sitecustomize.py").write_text(SITECUSTOMIZE, encoding="utf-8")
    return Installed(
        dist=dist, sdist=sdists[0], wheel=wheels[0], venv=venv, script=script, sandbox=sandbox
    )


def _fresh_env(installed: Installed, no_network: bool) -> dict[str, str]:
    """Environment for the console script: no project on the path, optionally no sockets."""
    env = {
        k: v for k, v in os.environ.items() if k not in {"PYTHONPATH", "VIRTUAL_ENV", "PYTHONHOME"}
    }
    env["PYTHONNOUSERSITE"] = "1"
    if no_network:
        env["PYTHONPATH"] = str(installed.sandbox)
    return env


def _pyproject_version() -> str:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"][
        "version"
    ]


class TestBuild:
    def test_uv_build_produces_sdist_and_wheel(self, installed: Installed) -> None:
        version = _pyproject_version()
        assert installed.sdist.name == f"agentlint-{version}.tar.gz"
        assert installed.wheel.name == f"agentlint-{version}-py3-none-any.whl"

    def test_wheel_is_lean_and_metadata_is_complete(self, installed: Installed) -> None:
        import zipfile

        with zipfile.ZipFile(installed.wheel) as wheel:
            names = wheel.namelist()
            metadata = wheel.read(
                next(n for n in names if n.endswith(".dist-info/METADATA"))
            ).decode("utf-8")
            entry_points = wheel.read(
                next(n for n in names if n.endswith(".dist-info/entry_points.txt"))
            ).decode("utf-8")
        assert all(n.startswith(("agentlint/", "agentlint-")) for n in names), names
        assert not any(n.startswith(("docs/", "tests/", "examples/")) for n in names)
        requires = [line for line in metadata.splitlines() if line.startswith("Requires-Dist:")]
        assert all("extra ==" in line for line in requires), requires  # zero runtime dependencies
        assert "Requires-Python: >=3.11" in metadata
        assert "License: BSD-2-Clause" in metadata
        assert "Project-URL: Source, https://github.com/joshgreenwell/ai-kits" in metadata
        assert "agentlint = agentlint.cli:main" in entry_points

    def test_sdist_carries_docs_tests_and_license(self, installed: Installed) -> None:
        import tarfile

        with tarfile.open(installed.sdist) as sdist:
            names = {n.split("/", 1)[1] for n in sdist.getnames() if "/" in n}
        for required in (
            "LICENSE",
            "PRIVACY.md",
            "CHANGELOG.md",
            "docs/record-bundle.schema.json",
            "docs/rules/README.md",
            "scripts/check_fixture_hygiene.py",
            "tests/e2e/healthy_run/expected.json",
        ):
            assert required in names, required


class TestConsoleScript:
    def test_version_from_a_fresh_directory(self, installed: Installed, tmp_path: Path) -> None:
        result = _run(
            [str(installed.script), "--version"], cwd=tmp_path, env=_fresh_env(installed, False)
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == f"agentlint {_pyproject_version()}"

    def test_analyze_healthy_fixture_exits_0(self, installed: Installed, tmp_path: Path) -> None:
        result = _run(
            [str(installed.script), "analyze", str(HEALTHY)],
            cwd=tmp_path,
            env=_fresh_env(installed, False),
        )
        assert result.returncode == 0, result.stderr
        assert "Findings: none (coverage complete)" in result.stdout
        assert "exit code 0" in result.stdout

    def test_installed_package_imports_only_the_standard_library(
        self, installed: Installed, tmp_path: Path
    ) -> None:
        """Every module a full analyze run loads is agentlint or stdlib (no hidden dependency)."""
        code = (
            "import sys, sysconfig, agentlint.cli, io\n"
            "agentlint.cli.main(['analyze', sys.argv[1], '--format', 'json'], out=io.StringIO())\n"
            "stdlib = sysconfig.get_paths()['stdlib']\n"
            "third = sorted(m for m, mod in sys.modules.items()\n"
            "  if getattr(mod, '__file__', None) and 'site-packages' in mod.__file__\n"
            "  and not m.startswith('agentlint')\n"
            "  and m not in ('sitecustomize', '_virtualenv') and not m.startswith('_distutils'))\n"
            "print(third)\n"
        )
        python = installed.script.with_name("python")
        result = _run(
            [str(python), "-c", code, str(HEALTHY)], cwd=tmp_path, env=_fresh_env(installed, False)
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "[]", result.stdout


class TestNoNetworkRuntime:
    def test_sandbox_really_refuses_sockets(self, installed: Installed, tmp_path: Path) -> None:
        python = installed.script.with_name("python")
        result = _run(
            [str(python), "-c", "import socket; socket.socket()"],
            cwd=tmp_path,
            env=_fresh_env(installed, True),
        )
        assert result.returncode != 0
        assert "network access attempted" in result.stderr

    @pytest.mark.parametrize(
        ("fixture", "code"), [(HEALTHY, 0), (AGGREGATE, 2)], ids=["healthy", "aggregate-only"]
    )
    def test_analyze_runs_with_sockets_disabled(
        self, installed: Installed, tmp_path: Path, fixture: Path, code: int
    ) -> None:
        env = _fresh_env(installed, True)
        for fmt in ("text", "json", "md"):
            result = _run(
                [
                    str(installed.script),
                    "analyze",
                    str(fixture),
                    "--format",
                    fmt,
                    "--include-snippets",
                ],
                cwd=tmp_path,
                env=env,
            )
            assert result.returncode == code, (fmt, result.stderr)
            assert result.stdout, fmt
            assert "network access attempted" not in result.stderr
        document = json.loads(
            _run(
                [str(installed.script), "analyze", str(fixture), "--format", "json"],
                cwd=tmp_path,
                env=env,
            ).stdout
        )
        assert document["summary"]["exit_code"] == code
        assert document["agentlint_version"] == _pyproject_version()

    def test_rules_and_explain_with_sockets_disabled(
        self, installed: Installed, tmp_path: Path
    ) -> None:
        env = _fresh_env(installed, True)
        rules = _run([str(installed.script), "rules"], cwd=tmp_path, env=env)
        explain = _run([str(installed.script), "explain", "CONTEXT_GROWTH"], cwd=tmp_path, env=env)
        assert rules.returncode == 0 and "NO_PROGRESS_CYCLE" in rules.stdout
        assert explain.returncode == 0 and "## Thresholds" in explain.stdout
        assert list(tmp_path.iterdir()) == []  # nothing written to the working directory
