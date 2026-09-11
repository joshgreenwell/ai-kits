#!/usr/bin/env python3
"""Refresh the existing detailed monthly envelope; never invokes a model.

Opt-in through a local collector's detailed_report configuration. Uses a separate
usage-publisher key, keeps exact attempted artifacts for retry, skips unchanged
analysis, and finalizes the previously active month once after rollover.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler

MAX_BYTES = 8 * 1024 * 1024
REQUIRED = ('totals', 'exclusive_composition', 'by_work_mode', 'by_project', 'by_theme',
            'top_root_tasks', 'daily', 'agent_orchestration', 'knowledge_brain', 'api_equivalent_cost')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + '.')
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle, separators=(',', ':')); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def publisher_config(connection, settings):
    config = json.loads(Path(settings['upload_config_path']).expanduser().read_text())
    endpoint = urlparse(config.get('endpoint', ''))
    origin = urlparse(connection['url'])
    local = endpoint.scheme == 'http' and endpoint.hostname in ('localhost', '127.0.0.1', '::1')
    if ((endpoint.scheme != 'https' and not local) or endpoint.username or endpoint.password or
        endpoint.query or endpoint.fragment or endpoint.path != '/api/reports' or
        (endpoint.scheme, endpoint.netloc) != (origin.scheme, origin.netloc)):
        raise ValueError('Report publisher must target the same Observatory /api/reports endpoint')
    if not config.get('api_key') or config['api_key'] == connection.get('key'):
        raise ValueError('A separate usage-publisher credential is required')
    if not settings.get('machine_id'):
        raise ValueError('Pin the existing report machine identity')
    return config


def build_envelope(connection, settings, publisher, month, period_state):
    analyzer = Path(settings['analyzer_path']).expanduser().resolve()
    if not analyzer.is_file() or analyzer.suffix != '.py':
        raise ValueError('Configured analyzer was not found')
    with tempfile.TemporaryDirectory(prefix='observatory-detail-') as temporary:
        output = Path(temporary) / 'report.json'
        argv = [sys.executable, str(analyzer), '--month', month]
        if connection['provider'] == 'codex':
            launcher = analyzer.with_name('run_analyzer.ps1' if sys.platform == 'win32' else 'run_analyzer.sh')
            if not launcher.is_file(): raise ValueError('The supported Codex analyzer launcher is missing')
            argv = (['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(launcher)]
                    if sys.platform == 'win32' else ['bash', str(launcher)]) + ['--month', month]
            argv += ['--top', '10', '--format', 'json']
            if settings.get('codex_home'):
                argv += ['--codex-home', str(Path(settings['codex_home']).expanduser())]
        elif connection['provider'] == 'claude':
            argv += ['--config', str(Path(settings['analyzer_config_path']).expanduser()),
                     '--source', 'claude-code', '--dry-run', '--no-harvest', '--json-out', str(output)]
        else:
            raise ValueError('Unsupported report provider')
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            completed = subprocess.run(argv, stdout=stdout, stderr=stderr, timeout=120, check=False,
                                       env={**os.environ, 'TOKEN_REPORT_PYTHON': sys.executable})
            if completed.returncode:
                raise RuntimeError('Detailed analyzer failed; previous published report is retained')
            if connection['provider'] == 'codex':
                stdout.seek(0); raw = stdout.read(MAX_BYTES + 1)
            else:
                with output.open('rb') as handle: raw = handle.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES: raise ValueError('Detailed report exceeds upload limit')
        data = json.loads(raw)
    if connection['provider'] == 'codex':
        envelope = {'schema_version': data.get('schema_version', 2), 'machine_id': publisher['machine_id'],
                    'machine_name': publisher['machine_name'], 'report': data}
    else:
        envelope = data
    if envelope.get('machine_id') != settings['machine_id']:
        raise ValueError('Analyzer changed the pinned report machine identity')
    report = envelope['report']; current = report['current']
    if current.get('month') != month or any(field not in current for field in REQUIRED):
        raise ValueError('Analyzer omitted required detailed-report fields')
    # Identify the measured content, not the run time or scan diagnostics.
    fingerprint = digest({'machine_id': envelope['machine_id'], 'provider': connection['provider'],
        'account_id': connection['account_id'], 'source_id': connection['source_id'], 'period_state': period_state,
        'current': current, 'previous': report.get('previous'), 'data_scope': report.get('data_scope'),
        'data_quality': report.get('data_quality'), 'optimization_recommendations': report.get('optimization_recommendations'),
        'workflow_tool_recommendations': report.get('workflow_tool_recommendations')})
    report['collection'] = {'kind': 'hourly_detailed_report', 'period_state': period_state,
        'observed_through': report['generated_at_local'], 'interval_minutes': 60,
        'provider': connection['provider'], 'account_id': connection['account_id'], 'source_id': connection['source_id'],
        'analyzer_sha256': hashlib.sha256(analyzer.read_bytes()).hexdigest(),
        'calendar': 'analyzer local calendar', 'content_hash': fingerprint}
    return envelope, fingerprint


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def upload(publisher, envelope):
    payload = json.dumps(envelope, separators=(',', ':')).encode()
    if len(payload) > MAX_BYTES: raise ValueError('Detailed report exceeds upload limit')
    headers = {'Authorization': 'Bearer ' + publisher['api_key'], 'Content-Type': 'application/json'}
    if publisher.get('sites_bypass_token'): headers['OAI-Sites-Authorization'] = 'Bearer ' + publisher['sites_bypass_token']
    request = Request(publisher['endpoint'], data=payload, headers=headers, method='POST')
    with build_opener(NoRedirect).open(request, timeout=45) as response:
        receipt = json.loads(response.read(256_000))
    if not receipt.get('ok') or not receipt.get('id') or receipt.get('machine_id') != envelope['machine_id'] or receipt.get('month') != envelope['report']['current']['month']:
        raise ValueError('Invalid detailed-report receipt; artifact retained for retry')
    return receipt


def refresh_details(config_path, connection, dry_run=False, now=None):
    settings = connection.get('detailed_report')
    if not settings: return {'status': 'not_configured'}
    if connection.get('mode') != 'local': raise ValueError('Only local collectors can refresh detailed reports')
    publisher = publisher_config(connection, settings)
    started = time.monotonic()
    current_month = (now or datetime.now().astimezone()).strftime('%Y-%m')
    folder = Path(config_path).parent / (connection['source_id'] + '.detailed')
    state_path, pending_path = folder / 'state.json', folder / 'pending.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {'reports': {}}
    identity = digest([connection['provider'], connection['account_id'], connection['source_id'], settings['machine_id'], publisher['endpoint']])
    if state.get('identity', identity) != identity: raise ValueError('Detailed report source identity changed')
    state['identity'] = identity
    results = []

    def deliver(pending):
        receipt = upload(publisher, pending['envelope'])
        state['reports'][pending['month']] = {'content_hash': pending['content_hash'], 'period_state': pending['period_state'],
            'observed_through': pending['envelope']['report']['generated_at_local'], 'receipt_id': receipt['id']}
        if pending['period_state'] == 'partial': state['active_month'] = pending['month']
        save(state_path, state); pending_path.unlink(missing_ok=True)
        results.append({'month': pending['month'], 'status': 'uploaded', 'receipt_id': receipt['id']})

    # Never replace an attempted artifact after an uncertain response.
    if pending_path.exists() and not dry_run:
        pending = json.loads(pending_path.read_text())
        if pending['identity'] != identity: raise ValueError('Pending artifact belongs to another report source')
        deliver(pending)
    months = []
    previous = state.get('active_month')
    if previous and previous < current_month and state['reports'].get(previous, {}).get('period_state') != 'complete':
        months.append((previous, 'complete'))
    months.append((current_month, 'partial'))
    for month, period_state in months:
        envelope, fingerprint = build_envelope(connection, settings, publisher, month, period_state)
        if state['reports'].get(month, {}).get('content_hash') == fingerprint:
            results.append({'month': month, 'status': 'unchanged'}); continue
        if dry_run:
            results.append({'month': month, 'status': 'ready', 'tokens': envelope['report']['current']['totals']['total_tokens'],
                'bytes': len(json.dumps(envelope).encode())}); continue
        pending = {'identity': identity, 'month': month, 'period_state': period_state, 'content_hash': fingerprint, 'envelope': envelope}
        save(pending_path, pending)
        deliver(pending)
    return {'status': 'dry_run' if dry_run else 'ok', 'reports': results, 'duration_ms': round((time.monotonic() - started) * 1000)}
