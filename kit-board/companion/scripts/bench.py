#!/usr/bin/env python3
"""Synthetic backfill benchmark: generate N bytes of Claude Code and Codex JSONL
and time `observatory run --dry-run --offline` over it.

    python3 scripts/bench.py --bytes 1000000000 --exe ../../target/release/observatory

Records are synthetic (no prompt text beyond a fixed marker). The config
directory is a temporary directory with a dry-run key; nothing is uploaded and
nothing on this machine outside the temporary directory is read. Python 3.10+,
standard library only. Informational in CI; the gate is the owner's machines
(statusline under 5 ms, 1 GB backfill under 10 s on the Mac).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


def claude_line(index: int, session: str, hour: int) -> bytes:
    minute = index % 60
    record = {
        "type": "assistant", "timestamp": f"2026-09-{2 + hour // 24:02d}T{hour % 24:02d}:{minute:02d}:{index % 59:02d}.000Z",
        "sessionId": session, "version": "1.0.100", "cwd": "/synthetic",
        "message": {"id": f"msg_{index:012d}", "model": "claude-sonnet-4", "role": "assistant",
                    "usage": {"input_tokens": 12 + index % 7, "cache_read_input_tokens": 2000 + index % 500,
                              "cache_creation_input_tokens": index % 300, "output_tokens": 40 + index % 200},
                    "content": [{"type": "text", "text": "synthetic filler " * 12}]},
    }
    return (json.dumps(record, separators=(",", ":")) + "\n").encode()


def codex_lines(session: str, count: int, hour: int) -> list[bytes]:
    lines = [
        (json.dumps({"timestamp": f"2026-09-02T{hour % 24:02d}:00:00.000Z", "type": "session_meta",
                     "payload": {"id": session, "timestamp": f"2026-09-02T{hour % 24:02d}:00:00.000Z"}}) + "\n").encode(),
        (json.dumps({"timestamp": f"2026-09-02T{hour % 24:02d}:00:01.000Z", "type": "turn_context", "payload": {"model": "gpt-5-codex"}}) + "\n").encode(),
        (json.dumps({"timestamp": f"2026-09-02T{hour % 24:02d}:00:02.000Z", "type": "event_msg", "payload": {"type": "task_started"}}) + "\n").encode(),
    ]
    total = 0
    for index in range(count):
        step = 50 + index % 40
        total += step
        record = {"timestamp": f"2026-09-02T{hour % 24:02d}:{(index // 60) % 60:02d}:{index % 60:02d}.000Z", "type": "event_msg",
                  "payload": {"type": "token_count", "info": {
                      "total_token_usage": {"input_tokens": total, "cached_input_tokens": total // 2, "output_tokens": index * 3, "total_tokens": total + index * 3},
                      "last_token_usage": {"input_tokens": step, "cached_input_tokens": step // 2, "output_tokens": 3, "total_tokens": step + 3}}}}
        lines.append((json.dumps(record, separators=(",", ":")) + "\n").encode())
    return lines


def generate(root: Path, target_bytes: int) -> int:
    written = 0
    claude_root = root / "claude" / "projects" / "-synthetic"
    codex_root = root / "codex" / "sessions" / "2026" / "09" / "02"
    claude_root.mkdir(parents=True)
    codex_root.mkdir(parents=True)
    file_index = 0
    while written < target_bytes:
        session = str(uuid.uuid4())
        with (claude_root / f"{session}.jsonl").open("wb") as handle:
            for index in range(2000):
                line = claude_line(index, session, file_index)
                handle.write(line)
                written += len(line)
        codex_session = str(uuid.uuid4())
        with (codex_root / f"rollout-{codex_session}.jsonl").open("wb") as handle:
            for line in codex_lines(codex_session, 1500, file_index):
                handle.write(line)
                written += len(line)
        file_index += 1
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bytes", type=int, default=64_000_000)
    parser.add_argument("--exe", default="observatory")
    parser.add_argument("--keep", action="store_true", help="print the temporary directory instead of deleting it")
    args = parser.parse_args()
    temp = Path(tempfile.mkdtemp(prefix="observatory-bench-"))
    try:
        started = time.monotonic()
        written = generate(temp / "stores", args.bytes)
        print(f"generated {written / 1e6:.1f} MB of JSONL in {time.monotonic() - started:.1f}s")
        config_dir = temp / "config"
        config_dir.mkdir()
        (config_dir / "companion.json").write_text(json.dumps({
            "schema_version": 1, "url": "https://localhost", "install_id": str(uuid.uuid4()), "key": "SYNTHETIC-DRY-RUN",
            "machine_label": "bench", "since": "2026-09-01",
            "bindings": [
                {"binding_id": str(uuid.uuid4()), "account_id": "claude-bench", "provider": "claude", "roots": [str(temp / "stores" / "claude" / "projects")]},
                {"binding_id": str(uuid.uuid4()), "account_id": "codex-bench", "provider": "codex", "roots": [str(temp / "stores" / "codex" / "sessions")]},
            ],
            "deny": [],
        }))
        env = dict(os.environ, OBSERVATORY_CONFIG_DIR=str(config_dir))
        for label in ("cold", "warm"):
            started = time.monotonic()
            result = subprocess.run([args.exe, "run", "--dry-run", "--offline"], capture_output=True, text=True, env=env)
            elapsed = time.monotonic() - started
            if result.returncode != 0:
                print(result.stdout)
                print(result.stderr, file=sys.stderr)
                return 1
            summary = json.loads(result.stdout)
            adapters = {a["adapter"]: a for a in summary["adapters"]}
            print(f"{label} dry run: {elapsed:.2f}s total; claude files {adapters['claude_execution']['files']}, "
                  f"bytes {adapters['claude_execution']['bytes_read']}; codex files {adapters['codex_execution']['files']}, "
                  f"bytes {adapters['codex_execution']['bytes_read']}; buckets pending {summary['buckets_pending']}")
        if args.keep:
            print(temp)
        return 0
    finally:
        if not args.keep:
            import shutil
            shutil.rmtree(temp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
