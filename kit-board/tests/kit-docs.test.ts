import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { kits } from '../lib/kits';
import { isDirectory, sourceLinks } from '../lib/kits/source';
import { reportContractRegistry, validateReport } from '../lib/report-contracts';
import { contractStatus, issuePath, storedBody, type StoredBody } from '../lib/contract-status';
import { contractFields } from '../lib/contract-fields';

const run = promisify(execFile);
const tasksExample = () => structuredClone(reportContractRegistry['tasks-v1'].example) as Record<string, any>;
const row = (body: Record<string, any>, kind = 'tasks'): StoredBody =>
  ({ kind, html: null, ...body, produced_at: new Date(body.produced_at) }) as StoredBody;

test('the validate check accepts an example, refuses a broken envelope, and stores observed drift', () => {
  const example = validateReport('tasks', tasksExample());
  assert.equal(example.accepted, true);
  assert.deepEqual(example.envelope, { valid: true, issues: [] });
  assert.equal(example.contract.valid, true);

  const undated = tasksExample();
  delete undated.produced_at;
  const refused = validateReport('tasks', undated);
  assert.equal(refused.accepted, false);
  assert.equal(refused.envelope.valid, false);
  assert.ok(refused.envelope.issues.some(issue => issue.path.join('.') === 'produced_at'));

  const drifting = tasksExample();
  drifting.payload.sections.work.items[0].priority = 'asap';
  const observed = validateReport('tasks', drifting);
  assert.equal(observed.contract.enforcement, 'observe');
  assert.equal(observed.contract.valid, false);
  assert.equal(observed.accepted, true, 'an observed contract stores a drifting payload, as ingestion does');

  // Ingestion applies the envelope's defaults before it checks the payload contract.
  const uncovered = tasksExample();
  delete uncovered.coverage;
  assert.equal(validateReport('tasks', uncovered).contract.valid, true);
});

test('the validate route authenticates before it reads the body, and answers private', () => {
  const source = readFileSync('app/api/v1/reports/[kind]/validate/route.ts', 'utf8');
  const body = source.indexOf('readJson(request)');
  assert.ok(body > 0);
  for (const check of ['requireProducer(request', 'requireSession()', 'requireSameOrigin(request)']) {
    const at = source.indexOf(check);
    assert.ok(at > 0 && at < body, `${check} runs before the body is read`);
  }
  assert.doesNotMatch(source, /storeReport|from '@\/lib\/db'/, 'the validate route stores nothing');
  assert.equal((source.match(/headers: privateHeaders/g) ?? []).length, 3, 'every answer is private, no-store');
});

test('stored revisions rebuild their request body', () => {
  const example = tasksExample();
  const body = storedBody(row(example));
  assert.equal(body.produced_at, new Date(example.produced_at).toISOString());
  assert.equal('html' in body, false, 'a revision without HTML posts none');
  assert.equal(storedBody({ ...row(example), html: '' }).html, '');
  assert.equal(validateReport('tasks', body).contract.valid, true, 'a stored example still matches its contract');
});

test('contract status counts each issue once per revision, with indexes folded', () => {
  assert.equal(issuePath(['payload', 'sections', 'work', 'items', 3, 'title']), 'payload.sections.work.items[].title');
  assert.equal(issuePath([]), '(body)');

  const drift = () => {
    const body = tasksExample();
    const item = body.payload.sections.work.items[0];
    body.payload.sections.work.items = [{ ...item, title: '' }, { ...item, title: '' }];
    return body;
  };
  const rows = [row(tasksExample()), row(drift()), row(drift()), row(structuredClone(reportContractRegistry['readings-v1'].example) as Record<string, any>, 'readings')];
  const status = contractStatus('tasks', rows);
  assert.equal(status.checked, 3, 'only the kind asked for');
  assert.equal(status.matched, 1);
  assert.equal(status.latest, true, 'the first row is the newest');
  assert.deepEqual(status.issues.map(({ path, revisions }) => ({ path, revisions })), [{ path: 'payload.sections.work.items[].title', revisions: 2 }]);
  assert.deepEqual(contractStatus('audit', []), { kind: 'audit', checked: 0, matched: 0, latest: null, issues: [] });
  assert.equal(contractStatus('tasks', [row(drift()), row(tasksExample())]).latest, false);
});

test('contract fields list every field with its requirement and rules', () => {
  const fields = contractFields(JSON.parse(readFileSync('lib/generated/contracts/tasks-v1.schema.json', 'utf8')));
  const field = (path: string) => fields.find(entry => entry.path === path);
  assert.deepEqual(field('schema_version'), { path: 'schema_version', depth: 0, type: 'number', required: true, rules: ['always 1'], description: undefined });
  assert.deepEqual(field('payload.sections.work.items[].title')?.rules, ['at least 1 character']);
  assert.equal(field('payload.sections.work.items[].title')?.required, true, 'required within its item');
  assert.equal(field('payload.sections.work.items')?.type, 'object list');
  assert.equal(field('payload.sections.work.items[].priority')?.required, false);
  assert.match(field('payload.sections.work.items[].priority')?.rules[0] ?? '', /^one of "urgent"/);
  assert.equal(field('produced_at')?.rules[0], 'ISO 8601 time with a UTC offset');
  assert.equal(field('payload.sections.*')?.description, 'Any other key', 'catch-all domains are listed');
  assert.ok(fields.findIndex(entry => entry.path === 'payload') < fields.findIndex(entry => entry.path === 'payload.sections'), 'parents come first');
  for (const id of ['readings-v1', 'audit-v1', 'standup-v1', 'report-envelope-v1'])
    assert.ok(contractFields(JSON.parse(readFileSync(`lib/generated/contracts/${id}.schema.json`, 'utf8'))).length > 5, id);
});

test('download links point at the repository, by folder or by file', () => {
  for (const kit of kits) for (const download of kit.downloads)
    assert.equal(isDirectory(download.path), statSync(join('..', download.path)).isDirectory(), download.path);
  assert.deepEqual(sourceLinks('kit-board/scripts/publish.mjs', 'abc123'), {
    view: 'https://github.com/joshgreenwell/ai-kits/blob/abc123/kit-board/scripts/publish.mjs',
    raw: 'https://raw.githubusercontent.com/joshgreenwell/ai-kits/abc123/kit-board/scripts/publish.mjs',
  });
  assert.deepEqual(sourceLinks('kit-ai-usage', 'abc123'), { view: 'https://github.com/joshgreenwell/ai-kits/tree/abc123/kit-ai-usage' });
});

test('a publisher dry run asks the board when it has a credential, and stays local otherwise', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'publish-dry-run-'));
  const report = join(directory, 'report.json');
  writeFileSync(report, JSON.stringify(tasksExample().payload));
  const common = ['scripts/publish.mjs', '--kind', 'tasks', '--producer', 'tasks', '--file', report, '--period', '2026-09-29', '--produced-at', '2026-09-29T09:00:00-05:00', '--dry-run'];
  const env = { ...process.env, PERSONAL_HUB_CONFIG: '' };

  const offline = await run(process.execPath, [...common, '--config', join(directory, 'missing.json'), '--offline'], { env });
  assert.equal(JSON.parse(offline.stdout).checked, 'local');
  assert.equal(offline.stderr, '');

  const unconfigured = await run(process.execPath, [...common, '--config', join(directory, 'missing.json')], { env });
  assert.equal(JSON.parse(unconfigured.stdout).checked, 'local');
  assert.match(unconfigured.stderr, /Checked locally only: No publisher config/);

  // A synthetic board on loopback: it answers as the validate route would, and records what it was sent.
  const seen: { path?: string; authorization?: string; body?: any } = {};
  let answer: unknown = {};
  const board = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; });
    request.on('end', () => {
      Object.assign(seen, { path: request.url, authorization: request.headers.authorization, body: JSON.parse(text) });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>(done => board.listen(0, '127.0.0.1', done));
  try {
    const { port } = board.address() as { port: number };
    const config = join(directory, 'publish.json');
    writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${port}`, producers: { tasks: { key: 'synthetic-test-key', kinds: ['tasks'] } } }));

    answer = validateReport('tasks', tasksExample());
    const checked = await run(process.execPath, [...common, '--config', config], { env });
    const result = JSON.parse(checked.stdout);
    assert.equal(result.checked, 'board');
    assert.equal(result.valid, true);
    assert.equal(seen.path, '/api/v1/reports/tasks/validate');
    assert.equal(seen.authorization, 'Bearer synthetic-test-key');
    assert.equal(seen.body.period_key, '2026-09-29');
    assert.doesNotMatch(checked.stdout + checked.stderr, /synthetic-test-key/, 'the key never reaches the output');

    const undated = tasksExample();
    delete undated.produced_at;
    answer = validateReport('tasks', undated);
    await assert.rejects(run(process.execPath, [...common, '--config', config], { env }), (error: { code: number; stdout: string }) =>
      error.code === 1 && JSON.parse(error.stdout).valid === false, 'a refused body fails the dry run');
  } finally { board.close(); }
});
