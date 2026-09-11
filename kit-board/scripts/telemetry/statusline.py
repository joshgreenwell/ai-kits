#!/usr/bin/env python3
"""Save only Claude Code quota fields to a local inbox; no network or inference.

Set PERSONAL_HUB_QUOTA_INBOX or pass --inbox. Add this to an existing statusline
wrapper, preserving its output, or use this as the standalone statusline command.
"""
import argparse
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

WINDOWS = [('five_hour', 300), ('seven_day', 10080)]


def record_status(inbox, data, limits, published, now):
    """Note that the hook ran and which allowance windows Claude offered it.

    An empty inbox on its own is ambiguous: the hook may never be invoked on this
    surface, or it may be invoked with no publishable allowance window. This file
    separates those. It sits beside the inbox rather than inside it so the
    collector, which reads every *.json in the inbox, never parses it as a
    sample. Counts and allowance percentages only; no cwd, session id or
    transcript path is retained.
    """
    target = Path(inbox).expanduser().parent / 'claude-statusline-status.json'
    try:
        previous = json.loads(target.read_text())
    except (OSError, ValueError):
        previous = {}
    stamp = now.isoformat().replace('+00:00', 'Z')
    status = {
        'last_invocation_at': stamp,
        'invocations': int(previous.get('invocations') or 0) + 1,
        'claude_code_version': data.get('version'),
        'entrypoint': data.get('entrypoint'),
        'rate_limits_present': isinstance(data.get('rate_limits'), dict),
        # Any key here that WINDOWS does not cover is an allowance window this
        # collector currently discards, such as a gateway spend limit.
        'rate_limit_keys': sorted(limits),
        'offered_windows': {key: limits[key] for key, _ in WINDOWS if isinstance(limits.get(key), dict)},
        'published_windows': [quota['window_key'] for quota in published],
        'last_published_at': stamp if published else previous.get('last_published_at'),
    }
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = target.parent / (target.name + f'.{os.getpid()}.tmp')
    temp.write_text(json.dumps(status, indent=2, sort_keys=True))
    os.chmod(temp, 0o600)
    temp.replace(target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--inbox', default=os.environ.get('PERSONAL_HUB_QUOTA_INBOX'))
    args = parser.parse_args()
    data = json.load(sys.stdin)
    raw = data.get('rate_limits')
    limits = raw if isinstance(raw, dict) else {}
    now = datetime.now(timezone.utc)
    quotas = []
    for key, minutes in WINDOWS:
        value = limits.get(key) or {}
        used, reset = value.get('used_percentage'), value.get('resets_at')
        if not isinstance(used, (int, float)) or not 0 <= used <= 100 or not isinstance(reset, (int, float)) or reset <= now.timestamp():
            continue
        quotas.append({'window_key': key, 'label': 'Claude · ' + ('5h' if minutes == 300 else 'weekly'),
                       'observed_at': now.isoformat().replace('+00:00', 'Z'), 'used_percent': used,
                       'resets_at': datetime.fromtimestamp(reset, timezone.utc).isoformat().replace('+00:00', 'Z'), 'window_minutes': minutes})
    if args.inbox and quotas:
        target = Path(args.inbox).expanduser()
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        # One sample per UTC hour; atomic rename, no conversation fields retained.
        output = target / (now.strftime('%Y-%m-%dT%H') + '.json')
        temp = target / (output.name + f'.{os.getpid()}.tmp')
        temp.write_text(json.dumps(quotas)); os.chmod(temp, 0o600); temp.replace(output)
    if args.inbox:
        try:
            record_status(args.inbox, data, limits, quotas, now)
        except Exception:
            pass  # Diagnostics must never cost a real reading.
    print(' · '.join(f"{q['label']} {100-q['used_percent']:.0f}% left" for q in quotas) or 'Claude')

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # A metrics hook must never break or expose the session's statusline input.
        print('Claude')
