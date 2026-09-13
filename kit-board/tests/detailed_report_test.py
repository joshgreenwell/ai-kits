import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location('detailed', Path(__file__).resolve().parents[1] / 'scripts/telemetry/detailed_report.py')
d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)

class DetailedReports(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.analyzer = self.root / 'analyze_token_usage.py'; self.analyzer.write_text('# analyzer')
        self.analyzer.with_name('run_analyzer.sh').write_text('# launcher')
        self.analyzer.with_name('run_analyzer.ps1').write_text('# launcher')  # the adapter picks the launcher by platform
        self.config_path = self.root / 'connection.json'
        self.publisher = {'endpoint': 'https://example.com/api/reports', 'api_key': 'report-key', 'machine_id': 'mac', 'machine_name': 'Mac'}
        self.upload_config = self.root / 'publisher.json'; self.upload_config.write_text(json.dumps(self.publisher))
        self.settings = {'analyzer_path': str(self.analyzer), 'upload_config_path': str(self.upload_config), 'machine_id': 'mac'}
        self.connection = {'url': 'https://example.com', 'key': 'bucket-key', 'provider': 'codex', 'mode': 'local', 'account_id': 'account', 'source_id': 'source', 'detailed_report': self.settings}
        self.fixture = {'schema_version': 2, 'generated_at_local': '2026-09-10T12:00:00Z', 'current': {field: [] for field in d.REQUIRED}, 'previous': {'totals': {'total_tokens': 50}}}
        self.fixture['current'].update(month='2026-09', totals={'total_tokens': 100, 'calls': 2}, api_equivalent_cost={'estimated_cost_usd': 1.5})
        self.september = datetime(2026, 9, 10, tzinfo=timezone.utc)
        self.sent = []

    def tearDown(self): self.tmp.cleanup()

    def run_analyzer(self, argv, **kwargs):
        self.assertIn('run_analyzer.ps1' if sys.platform == 'win32' else 'run_analyzer.sh', ' '.join(argv)); self.assertNotIn('--upload', argv)
        fixture = copy.deepcopy(self.fixture); fixture['current']['month'] = argv[argv.index('--month') + 1]
        kwargs['stdout'].write(json.dumps(fixture).encode()); return SimpleNamespace(returncode=0)

    def upload(self, publisher, envelope):
        self.sent.append(copy.deepcopy(envelope)); return {'ok': True, 'id': str(len(self.sent))}

    def refresh(self, **kwargs):
        return d.refresh_details(self.config_path, self.connection, now=kwargs.pop('now', self.september), **kwargs)

    def test_full_content_retained_and_generation_time_does_not_create_revision(self):
        with patch.object(d.subprocess, 'run', self.run_analyzer), patch.object(d, 'upload', self.upload):
            self.refresh(); self.fixture['generated_at_local'] = '2026-09-10T13:00:00Z'
            result = self.refresh()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(result['reports'][0]['status'], 'unchanged')
        self.assertEqual(self.sent[0]['report']['current']['api_equivalent_cost'], {'estimated_cost_usd': 1.5})
        self.assertTrue(all(field in self.sent[0]['report']['current'] for field in d.REQUIRED))
        self.assertEqual(self.sent[0]['report']['collection']['period_state'], 'partial')

    def test_timeout_retries_exact_artifact_before_reanalysis(self):
        with patch.object(d.subprocess, 'run', self.run_analyzer), patch.object(d, 'upload', side_effect=TimeoutError):
            with self.assertRaises(TimeoutError): self.refresh()
        pending = json.loads((self.root / 'source.detailed/pending.json').read_text())
        self.fixture['generated_at_local'] = '2026-09-10T13:00:00Z'
        with patch.object(d.subprocess, 'run', self.run_analyzer), patch.object(d, 'upload', self.upload): self.refresh()
        self.assertEqual(self.sent, [pending['envelope']])
        self.assertFalse((self.root / 'source.detailed/pending.json').exists())

    def test_rollover_finalizes_once_then_continues_current_month(self):
        october = datetime(2026, 10, 1, tzinfo=timezone.utc)
        with patch.object(d.subprocess, 'run', self.run_analyzer), patch.object(d, 'upload', self.upload):
            self.refresh(); self.refresh(now=october); self.refresh(now=october)
        self.assertEqual([(e['report']['current']['month'], e['report']['collection']['period_state']) for e in self.sent], [('2026-09', 'partial'), ('2026-09', 'complete'), ('2026-10', 'partial')])

    def test_invalid_or_reduced_analysis_preserves_previous_report(self):
        del self.fixture['current']['by_project']
        with patch.object(d.subprocess, 'run', self.run_analyzer), patch.object(d, 'upload', self.upload):
            with self.assertRaises(ValueError): self.refresh()
        self.assertEqual(self.sent, [])

    def test_publisher_identity_and_scope_are_not_borrowed_from_quota_key(self):
        for changes in [{'endpoint': 'https://elsewhere.test/api/reports'}, {'api_key': 'bucket-key'}, {'endpoint': 'https://example.com/api/reports?redirect=1'}]:
            self.upload_config.write_text(json.dumps({**self.publisher, **changes}))
            with self.assertRaises(ValueError): d.publisher_config(self.connection, self.settings)
        self.upload_config.write_text(json.dumps(self.publisher)); self.settings['machine_id'] = 'other'
        with patch.object(d.subprocess, 'run', self.run_analyzer):
            with self.assertRaises(ValueError): self.refresh()
        self.connection['mode'] = 'browser'
        with self.assertRaises(ValueError): self.refresh()

    def test_dry_run_does_not_publish_or_write_receipts(self):
        with patch.object(d.subprocess, 'run', self.run_analyzer), patch.object(d, 'upload', self.upload):
            self.assertEqual(self.refresh(dry_run=True)['status'], 'dry_run')
        self.assertEqual(self.sent, []); self.assertFalse((self.root / 'source.detailed').exists())
