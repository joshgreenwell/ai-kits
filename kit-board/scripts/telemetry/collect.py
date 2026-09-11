#!/usr/bin/env python3
"""Incremental, zero-inference token collection. Python 3.10+, standard library only.

Reads counters from JSONL; SQLite stores counters/checkpoints, never conversation text.
Run --config connection.json --since 2026-09-01 [--dry-run].
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from urllib.parse import urlparse

VERSION = '1.1.0'
FIELDS = ('input_tokens', 'cached_tokens', 'cache_write_tokens', 'output_tokens')

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def iso(epoch=None):
    return datetime.fromtimestamp(time.time() if epoch is None else epoch, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def epoch(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, AttributeError, TypeError):
        return None

def count(value):
    return int(value) if isinstance(value, (int, float)) and value >= 0 else 0

def uuid_time(value):
    try:
        if value[14] == '7':
            return int(value.replace('-', '')[:12], 16) / 1000
    except (ValueError, IndexError, TypeError):
        pass
    return None

def open_state(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(path, timeout=1)
    os.chmod(path, 0o600)
    db.row_factory = sqlite3.Row
    db.executescript('''
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, inode TEXT, offset INTEGER, context TEXT);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session TEXT, hour TEXT, model TEXT,
      input_tokens INTEGER, cached_tokens INTEGER, cache_write_tokens INTEGER, output_tokens INTEGER);
    CREATE INDEX IF NOT EXISTS event_hours ON events(hour,session,model);
    CREATE TABLE IF NOT EXISTS quotas (hash TEXT PRIMARY KEY, payload TEXT, sent INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS published (key TEXT PRIMARY KEY, hash TEXT);
    CREATE TABLE IF NOT EXISTS outbox (hash TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE IF NOT EXISTS receipts (hash TEXT PRIMARY KEY, received_at TEXT, receipt TEXT);
    ''')
    return db

def components(provider, usage):
    if provider == 'codex':
        cached = count(usage.get('cached_input_tokens'))
        written = count(usage.get('cache_write_input_tokens'))
        return (max(0, count(usage.get('input_tokens')) - cached - written), cached, written, count(usage.get('output_tokens')))
    return (count(usage.get('input_tokens')), count(usage.get('cache_read_input_tokens')),
            count(usage.get('cache_creation_input_tokens')), count(usage.get('output_tokens')))

def save_event(db, event_id, session, timestamp, model, values):
    if not sum(values):
        return
    hour = iso(int(timestamp // 3600) * 3600)
    # Streaming Claude records repeat the same message id; keep a single record.
    # Component-wise maxima also prevent an older mirrored copy regressing usage.
    old = db.execute('SELECT * FROM events WHERE id=?', (event_id,)).fetchone()
    if old:
        values = tuple(max(old[k], v) for k, v in zip(FIELDS, values))
        db.execute('UPDATE events SET input_tokens=?,cached_tokens=?,cache_write_tokens=?,output_tokens=? WHERE id=?', (*values, event_id))
    else:
        db.execute('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', (event_id, session, hour, model, *values))

def save_codex_quotas(db, payload, timestamp):
    limits = payload.get('rate_limits') or {}
    for key in ('primary', 'secondary'):
        window = limits.get(key)
        if not isinstance(window, dict):
            continue
        used, reset, minutes = window.get('used_percent'), window.get('resets_at'), window.get('window_minutes')
        if not isinstance(used, (int, float)) or not 0 <= used <= 100 or not isinstance(reset, (int, float)) or reset <= timestamp or not isinstance(minutes, int) or minutes <= 0:
            continue
        item = {'window_key': str(limits.get('limit_id') or 'codex') + ':' + str(minutes),
                'label': str(limits.get('limit_name') or 'Codex') + (' · weekly' if minutes == 10080 else f' · {minutes // 60}h'),
                'observed_at': iso(timestamp), 'used_percent': used, 'resets_at': iso(reset), 'window_minutes': minutes}
        # Keep at most one reading per window/hour. Actual observation time stays intact.
        slot = item['window_key'] + ':' + iso(int(timestamp // 3600) * 3600)
        old = db.execute('SELECT payload FROM quotas WHERE hash=?', (slot,)).fetchone()
        if not old or json.loads(old['payload'])['observed_at'] < item['observed_at']:
            db.execute('INSERT INTO quotas VALUES(?,?,0) ON CONFLICT(hash) DO UPDATE SET payload=excluded.payload,sent=0', (slot, json.dumps(item)))

def process_line(db, data, ctx, provider, account, since):
    timestamp = epoch(data.get('timestamp'))
    kind, payload = data.get('type'), data.get('payload') or {}
    if provider == 'codex':
        if kind == 'session_meta':
            ctx['session'] = str(payload.get('id') or ctx['session'])
            ctx['created'] = uuid_time(ctx['session']) or epoch(payload.get('timestamp')) or 0
        elif kind == 'turn_context':
            ctx['model'] = str(payload.get('model') or ctx.get('model') or 'unknown')[:100]
        elif kind == 'event_msg' and payload.get('type') == 'task_started':
            started = uuid_time(payload.get('turn_id')) or timestamp or 0
            if started >= ctx.get('created', 0) - 5:
                ctx['own_started'] = True
        elif kind == 'event_msg' and payload.get('type') == 'token_count':
            info = payload.get('info') or {}
            cumulative = info.get('total_token_usage')
            previous = ctx.get('cumulative')
            if cumulative:
                ctx['cumulative'] = cumulative
            if timestamp is None or timestamp < since or timestamp > time.time() + 300 or not ctx.get('own_started'):
                return
            save_codex_quotas(db, payload, timestamp)
            usage = info.get('last_token_usage')
            if not isinstance(usage, dict):
                return
            if cumulative and previous:
                if cumulative == previous:
                    return
                deltas = {k: count(cumulative.get(k)) - count(previous.get(k)) for k in ('input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','total_tokens')}
                if all(v >= 0 for v in deltas.values()):
                    usage = deltas
            session = digest([provider, account, ctx['session']])
            event_id = digest([provider, account, ctx['session'], data['timestamp'], cumulative or usage])
            save_event(db, event_id, session, timestamp, ctx.get('model', 'unknown'), components(provider, usage))
    elif kind == 'assistant' and timestamp is not None and since <= timestamp <= time.time() + 300:
        message = data.get('message') or {}
        if not message.get('id') or not isinstance(message.get('usage'), dict) or message.get('model') == '<synthetic>':
            return
        session = digest([provider, account, data.get('sessionId') or ctx['session']])
        save_event(db, digest([provider, account, message['id']]), session, timestamp, str(message.get('model') or 'unknown')[:100], components(provider, message['usage']))

def scan(db, roots, provider, account, since):
    metrics = {'files': 0, 'bytes_read': 0, 'malformed_lines': 0, 'unavailable_roots': 0, 'collector_version': VERSION}
    seen = set()
    for root in roots:
        root = Path(root).expanduser()
        if not root.is_dir():
            metrics['unavailable_roots'] += 1
            continue
        for path in root.rglob('*.jsonl'):
            if path.is_symlink():
                continue
            try:
                path = path.resolve()
                if str(path) in seen:
                    continue
                seen.add(str(path))
                stat = path.stat()
                if stat.st_mtime < since:
                    continue
                metrics['files'] += 1
                old = db.execute('SELECT * FROM files WHERE path=?', (str(path),)).fetchone()
                inode = f'{stat.st_dev}:{stat.st_ino}'
                if old and old['size'] == stat.st_size and old['mtime'] == stat.st_mtime_ns:
                    continue
                resume = old and old['inode'] == inode and stat.st_size >= old['size']
                offset = old['offset'] if resume else 0
                ctx = json.loads(old['context']) if resume else {'session': path.stem, 'model': 'unknown', 'own_started': False}
                with path.open('rb') as handle:
                    handle.seek(offset)
                    while True:
                        line = handle.readline()
                        metrics['bytes_read'] += len(line)
                        if not line or not line.endswith(b'\n'):
                            break  # A partial trailing record is retried next run.
                        offset = handle.tell()
                        if b'token_count' not in line and b'session_meta' not in line and b'turn_context' not in line and b'task_started' not in line and b'"assistant"' not in line:
                            continue
                        try:
                            data = json.loads(line)
                            process_line(db, data, ctx, provider, account, since)
                        except (json.JSONDecodeError, UnicodeError, TypeError, ValueError, AttributeError):
                            metrics['malformed_lines'] += 1
                db.execute('INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?)', (str(path), stat.st_size, stat.st_mtime_ns, inode, offset, json.dumps(ctx)))
            except OSError:
                metrics['unavailable_roots'] += 1
    return metrics

def bucket_rows(db):
    rows = db.execute('''SELECT session AS session_hash,hour,model,sum(input_tokens) AS input_tokens,
      sum(cached_tokens) AS cached_tokens,sum(cache_write_tokens) AS cache_write_tokens,
      sum(output_tokens) AS output_tokens,count(*) AS calls FROM events GROUP BY session,hour,model ORDER BY hour,session,model''')
    for row in rows:
        result = dict(row)
        result['total_tokens'] = sum(result[k] for k in FIELDS)
        yield result

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def send(config, route, payload):
    parsed = urlparse(config['url'])
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1')):
        raise ValueError('HTTPS required')
    if parsed.username or parsed.password:
        raise ValueError('Invalid upload URL')
    request = Request(config['url'].rstrip('/') + route, data=json.dumps(payload).encode(),
                      headers={'Authorization': 'Bearer ' + config['key'], 'Content-Type': 'application/json'}, method='POST')
    with build_opener(NoRedirect).open(request, timeout=45) as response:
        return json.load(response)

def publish(db, config, coverage, dry_run):
    pending = []
    for row in bucket_rows(db):
        key = digest([row['session_hash'], row['hour'], row['model']])
        old = db.execute('SELECT hash FROM published WHERE key=?', (key,)).fetchone()
        if not old or old['hash'] != digest(row):
            pending.append(row)
    quota_rows = [json.loads(row['payload']) for row in db.execute('SELECT payload FROM quotas WHERE sent=0')]
    bodies = []
    while pending or quota_rows or not bodies:
        body = {'schema_version': 1, 'observed_at': iso(), 'buckets': pending[:400], 'quotas': quota_rows[:90], 'coverage': coverage}
        pending, quota_rows = pending[400:], quota_rows[90:]
        bodies.append(body)
    if dry_run:
        return {'dry_run': True, 'buckets': sum(len(b['buckets']) for b in bodies), 'quotas': sum(len(b['quotas']) for b in bodies), 'upload_bytes': sum(len(json.dumps(b).encode()) for b in bodies)}
    for body in bodies:
        db.execute('INSERT OR IGNORE INTO outbox VALUES(?,?)', (digest(body), json.dumps(body)))
    db.commit()
    sent, upload_bytes = 0, 0
    for pending_row in db.execute('SELECT * FROM outbox ORDER BY rowid').fetchall():
        body = json.loads(pending_row['payload'])
        receipt = send(config, '/api/v1/telemetry', body)
        if not receipt.get('ok') or not receipt.get('id'):
            raise ValueError('Invalid receipt; batch retained')
        for row in body['buckets']:
            db.execute('INSERT OR REPLACE INTO published VALUES(?,?)', (digest([row['session_hash'], row['hour'], row['model']]), digest(row)))
        for q in body['quotas']:
            # Do not mark a newer local reading sent when replaying an older outbox.
            db.execute('UPDATE quotas SET sent=1 WHERE payload=?', (json.dumps(q),))
        db.execute('INSERT OR REPLACE INTO receipts VALUES(?,?,?)', (pending_row['hash'], iso(), json.dumps(receipt)))
        db.execute('DELETE FROM outbox WHERE hash=?', (pending_row['hash'],))
        db.commit()
        sent += 1
        upload_bytes += len(pending_row['payload'].encode())
    return {'ok': True, 'batches': sent, 'upload_bytes': upload_bytes}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--since', default=None)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--refresh-feeds', action='store_true')
    args = parser.parse_args()
    config_path = Path(args.config).expanduser().resolve()
    config = json.loads(config_path.read_text())
    if config.get('provider') not in ('codex', 'claude') or config.get('mode') != 'local':
        raise ValueError('Expected a local collector connection')
    state_path = config_path.parent / (config['source_id'] + '.sqlite3')
    lock_path = state_path.with_suffix('.lock')
    # SQLite BEGIN IMMEDIATE is held during scanning; the OS releases it on a crash.
    lock = sqlite3.connect(lock_path, timeout=1)
    os.chmod(lock_path, 0o600)
    try:
        lock.execute('BEGIN IMMEDIATE')
    except sqlite3.OperationalError:
        print(json.dumps({'skipped': 'collector_already_running'}))
        return
    started = time.monotonic()
    db = open_state(state_path)
    identity = digest([config['account_id'], config['provider'], config.get('roots')])
    previous = db.execute("SELECT value FROM meta WHERE key='identity'").fetchone()
    if previous and previous['value'] != identity:
        raise ValueError('Collector identity or roots changed; create a new connection and state')
    db.execute("INSERT OR IGNORE INTO meta VALUES('identity',?)", (identity,))
    saved = db.execute("SELECT value FROM meta WHERE key='since'").fetchone()
    since_text = saved['value'] if saved else args.since or datetime.now(timezone.utc).strftime('%Y-%m-01')
    if saved and args.since and args.since != since_text:
        raise ValueError('Backfill start is pinned in this state; use a new connection for another range')
    since = epoch(since_text + 'T00:00:00Z')
    if since is None:
        raise ValueError('Invalid start date')
    db.execute("INSERT OR IGNORE INTO meta VALUES('since',?)", (since_text,))
    defaults = [str(Path.home() / '.codex/sessions'), str(Path.home() / '.codex/archived_sessions')] if config['provider'] == 'codex' else [str(Path.home() / '.claude/projects')]
    coverage = scan(db, config.get('roots', defaults), config['provider'], config['account_id'], since)
    if config['provider'] == 'claude' and config.get('quota_inbox'):
        for sample_file in Path(config['quota_inbox']).expanduser().glob('*.json'):
            try:
                for q in json.loads(sample_file.read_text()):
                    if q.get('window_key') not in ('five_hour', 'seven_day') or not isinstance(q.get('used_percent'), (int, float)) or not 0 <= q['used_percent'] <= 100:
                        continue
                    observed, reset = epoch(q.get('observed_at')), epoch(q.get('resets_at'))
                    if observed is None or reset is None or observed < since or observed > time.time() + 300 or reset <= observed:
                        continue
                    safe = {k: q[k] for k in ('window_key','label','observed_at','used_percent','resets_at','window_minutes')}
                    db.execute('INSERT OR IGNORE INTO quotas VALUES(?,?,0)', (digest(safe), json.dumps(safe)))
            except (OSError, ValueError, KeyError, TypeError):
                coverage['malformed_lines'] += 1
    coverage.update(since=since_text, duration_ms=round((time.monotonic() - started) * 1000))
    db.commit()
    result = publish(db, config, coverage, args.dry_run)
    if args.refresh_feeds and not args.dry_run:
        try:
            response = send(config, '/api/reset-feeds', {})
            result['feeds_refreshed'] = not any(r.get('ok') is False for r in response.get('results', []))
        except Exception:
            result['feeds_refreshed'] = False
    if config.get('detailed_report'):
        try:
            from detailed_report import refresh_details
            result['detailed_report'] = refresh_details(config_path, config, args.dry_run)
        except Exception as error:
            # Token collection still succeeds; report freshness is tracked separately.
            result['detailed_report'] = {'status': 'failed', 'error': type(error).__name__}
    print(json.dumps({**result, 'coverage': coverage, 'total_duration_ms': round((time.monotonic() - started) * 1000)}))
    db.close()
    lock.rollback()
    lock.close()

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never log request headers, provider data, local paths, or secret config.
        print(json.dumps({'ok': False, 'error': type(error).__name__, 'http_status': error.code if isinstance(error, HTTPError) else None, 'action': 'Check connection and retry; checkpoints and outbox are retained.'}), file=sys.stderr)
        sys.exit(1)
