import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('collector', Path(__file__).resolve().parents[1] / 'scripts/telemetry/collect.py')
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)

class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db = c.open_state(self.root / 'state.sqlite3')
        self.since = c.epoch('2026-09-01T00:00:00Z')

    def tearDown(self):
        self.db.close(); self.tmp.cleanup()

    def codex(self, at, total, last=None):
        return {'type': 'event_msg', 'timestamp': at, 'payload': {'type': 'token_count', 'info': {'total_token_usage': {'input_tokens': total, 'output_tokens': 0, 'total_tokens': total}, 'last_token_usage': {'input_tokens': last or total, 'output_tokens': 0, 'total_tokens': last or total}}}}

    def claude(self, at, output=10, session='s'):
        return {'type': 'assistant', 'timestamp': at, 'sessionId': session, 'message': {'id': 'msg-repeat', 'model': 'claude', 'usage': {'input_tokens': 2, 'cache_read_input_tokens': 20, 'cache_creation_input_tokens': 8, 'output_tokens': output}, 'content': 'PRIVATE SENTINEL'}}

    def test_codex_cumulative_duplicate_and_reset(self):
        ctx = {'session': 's', 'model': 'codex', 'own_started': True}
        for at, total, last in [('2026-09-02T01:00:00Z', 100, 100), ('2026-09-02T01:01:00Z', 160, 60), ('2026-09-02T01:02:00Z', 160, 60), ('2026-09-02T01:03:00Z', 40, 40)]:
            c.process_line(self.db, self.codex(at, total, last), ctx, 'codex', 'main', self.since)
        bucket = list(c.bucket_rows(self.db))[0]
        self.assertEqual(bucket['total_tokens'], 200)
        self.assertEqual(bucket['calls'], 3)

    def test_inherited_history_is_not_counted(self):
        ctx = {'session': 'child', 'model': 'codex', 'own_started': False, 'created': self.since}
        c.process_line(self.db, self.codex('2026-09-02T01:00:00Z', 100), ctx, 'codex', 'main', self.since)
        c.process_line(self.db, {'type': 'event_msg', 'timestamp': '2026-09-02T02:00:00Z', 'payload': {'type': 'task_started'}}, ctx, 'codex', 'main', self.since)
        c.process_line(self.db, self.codex('2026-09-02T02:01:00Z', 130, 30), ctx, 'codex', 'main', self.since)
        self.assertEqual(list(c.bucket_rows(self.db))[0]['total_tokens'], 30)

    def test_claude_streaming_records_and_mirrors_count_once(self):
        for output, session in [(10, 'original'), (10, 'copy'), (20, 'original'), (5, 'copy')]:
            c.process_line(self.db, self.claude('2026-09-02T02:00:00Z', output, session), {}, 'claude', 'main', self.since)
        bucket = list(c.bucket_rows(self.db))[0]
        self.assertEqual(bucket['total_tokens'], 50)
        self.assertEqual(bucket['calls'], 1)
        self.assertNotIn('PRIVATE SENTINEL', json.dumps(bucket))

    def test_partial_line_checkpoint_unchanged_scan_and_rotation(self):
        root = self.root / 'logs'; root.mkdir()
        file = root / 'a.jsonl'
        text = json.dumps(self.claude('2026-09-02T02:00:00Z'))
        file.write_text(text[:40])
        c.scan(self.db, [root], 'claude', 'main', self.since)
        self.assertEqual(len(list(c.bucket_rows(self.db))), 0)
        with file.open('a') as f: f.write(text[40:] + '\n')
        c.scan(self.db, [root], 'claude', 'main', self.since)
        self.assertEqual(list(c.bucket_rows(self.db))[0]['calls'], 1)
        self.assertEqual(c.scan(self.db, [root], 'claude', 'main', self.since)['bytes_read'], 0)
        file.unlink(); file.write_text(text + '\n')
        c.scan(self.db, [root], 'claude', 'main', self.since)
        self.assertEqual(list(c.bucket_rows(self.db))[0]['calls'], 1)

    def test_quota_observation_time_is_not_upload_time(self):
        at = c.epoch('2026-09-02T02:00:00Z')
        payload = {'rate_limits': {'primary': {'used_percent': 20, 'resets_at': at + 3600, 'window_minutes': 300}}}
        c.save_codex_quotas(self.db, payload, at)
        c.save_codex_quotas(self.db, payload, at - 30)
        q = json.loads(self.db.execute('SELECT payload FROM quotas ORDER BY payload DESC').fetchone()[0])
        self.assertEqual(q['observed_at'], c.iso(at))

    def test_failed_upload_is_replayed_without_rescan(self):
        c.process_line(self.db, self.claude('2026-09-02T02:00:00Z'), {}, 'claude', 'main', self.since)
        original = c.send
        def fail(*args): raise OSError('offline')
        c.send = fail
        try:
            with self.assertRaises(OSError): c.publish(self.db, {}, {'collector_version': 'test'}, False)
            self.assertEqual(self.db.execute('SELECT count(*) FROM outbox').fetchone()[0], 1)
            c.send = lambda *args: {'ok': True, 'id': 'receipt'}
            c.publish(self.db, {}, {'collector_version': 'test'}, False)
            self.assertEqual(self.db.execute('SELECT count(*) FROM outbox').fetchone()[0], 0)
            self.assertEqual(c.publish(self.db, {}, {'collector_version': 'test'}, True)['buckets'], 0)
        finally: c.send = original

if __name__ == '__main__': unittest.main()
