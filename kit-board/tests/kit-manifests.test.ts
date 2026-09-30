import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { kinds } from '../lib/contracts';
import { endpointContracts, endpoints, kits, reportContract, reportContracts, sectionPath, sections } from '../lib/kits';
import { contractRegistry, isPublishedContract } from '../lib/contract-registry';
import { checkReportContract, reportContractRegistry } from '../lib/report-contracts';
import { assertSupported, validate } from '../lib/contract-validator.mjs';

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const sample = '00000000-0000-4000-8000-000000000000';

/** Every route the app serves: its path template as a pattern, and the methods it exports. */
function routes() {
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name === 'route.ts' ? [join(directory, entry.name)] : []);
  return walk('app/api').map(file => {
    const template = '/' + relative('app', file).replace(/\/route\.ts$/, '');
    const source = readFileSync(file, 'utf8');
    const exported = methods.filter(method => new RegExp(`export (?:async )?(?:function|const) ${method}\\b`).test(source));
    const pattern = new RegExp('^' + template.replace(/\[[^\]]+\]/g, '[^/]+') + '$');
    return { template, exported, pattern };
  });
}
const concrete = (path: string) => path.replace(/:[a-z]+/g, sample);

test('every report kind has exactly one kit, and every producer scope is declared', () => {
  for (const kind of kinds) assert.equal(reportContracts.filter(report => report.kind === kind).length, 1, kind);
  const scopes = kits.flatMap(kit => kit.producers as readonly string[]);
  assert.deepEqual([...scopes].sort(), [...kinds, 'pr-watch'].sort());
  assert.deepEqual(sections.map(section => section.path), ['/usage', '/tasks', '/readings', '/audit']);
  assert.equal(sectionPath('standup'), '/tasks', 'standups read beside the briefing');
});

test('the kit manifests list every API route and method, and nothing else', () => {
  const served = routes();
  for (const endpoint of endpoints) {
    const matches = served.filter(route => route.pattern.test(concrete(endpoint.path)));
    assert.equal(matches.length, 1, `${endpoint.method} ${endpoint.path} names one route`);
    assert.ok(matches[0].exported.includes(endpoint.method), `${matches[0].template} exports ${endpoint.method}`);
  }
  for (const route of served) for (const method of route.exported) {
    assert.ok(endpoints.some(endpoint => endpoint.method === method && route.pattern.test(concrete(endpoint.path))), `${method} ${route.template} has an owner in lib/kits/`);
  }
  const keys = endpoints.map(endpoint => `${endpoint.method} ${endpoint.path}`);
  assert.equal(new Set(keys).size, keys.length, 'no endpoint is listed twice');
});

test('the edge proxy admits exactly the endpoints the manifests mark as authenticating themselves', async () => {
  const { proxy } = await import('../proxy');
  const { NextRequest } = await import('next/server');
  for (const endpoint of endpoints) {
    const status = proxy(new NextRequest(`http://localhost${concrete(endpoint.path)}`, { method: endpoint.method })).status;
    assert.equal(status, endpoint.auth === 'session' ? 401 : 200, `${endpoint.method} ${endpoint.path} (${endpoint.auth})`);
  }
});

test('producer endpoints carry a declared scope, and report endpoints name their kind\'s contract', () => {
  for (const endpoint of endpoints) {
    if (endpoint.auth === 'producer' || endpoint.auth === 'producer-or-session') assert.ok(kits.some(kit => (kit.producers as readonly string[]).includes(endpoint.scope ?? '')), `${endpoint.path} scope`);
    const kind = /^\/api\/v1\/reports\/([a-z]+)(?:\/validate)?$/.exec(endpoint.path)?.[1];
    if (kind) {
      assert.equal('contract' in endpoint && endpoint.contract, reportContract(kind as typeof kinds[number]).contract, endpoint.path);
      assert.equal(endpoint.scope, kind, `${endpoint.path} takes the ${kind} producer key`);
    }
  }
  for (const report of reportContracts) if (report.kind !== 'usage') {
    assert.ok(report.contract in reportContractRegistry, report.contract);
    // Each kind's validate route sits in the manifest of the kit that publishes the kind.
    const owner = kits.find(kit => kit.id === report.kit)!;
    assert.ok((owner.endpoints as readonly { path: string }[]).some(endpoint => endpoint.path === `/api/v1/reports/${report.kind}/validate`), `${report.kit} lists the ${report.kind} validate route`);
  }
});

test('every contract an endpoint names is published, and only the PR watch routes name one outside the reports', () => {
  for (const endpoint of endpoints) for (const id of [endpoint.contract, endpoint.returns]) if (id) assert.ok(id === 'usage-v2' || isPublishedContract(id), `${endpoint.path}: ${id}`);
  assert.deepEqual(kits.flatMap(kit => endpointContracts(kit).map(({ id, endpoint, direction }) => `${kit.id} ${direction} ${endpoint.method} ${endpoint.path} ${id}`)), [
    'pr-watch response GET /api/v1/pr-watches pr-watch-work-v1',
    'pr-watch request POST /api/v1/pr-watches/:id pr-watch-report-v1',
  ]);
});

test('every download a kit offers exists in the repository', () => {
  for (const kit of kits) {
    assert.ok(existsSync(join('..', kit.directory)), `${kit.id} directory ${kit.directory}`);
    for (const download of kit.downloads) assert.ok(existsSync(join('..', download.path)), `${kit.id}: ${download.path}`);
  }
});

test('an extracted kit carries what CONTRIBUTING.md asks of a kit, with a copy of each contract it publishes', () => {
  for (const kit of kits.filter(kit => kit.extracted)) {
    const root = join('..', kit.directory);
    for (const file of ['README.md', 'package.json', 'fixtures/MANIFEST.json', `../.github/workflows/${kit.directory}.yml`]) assert.ok(existsSync(join(root, file)), `${kit.id}: ${file}`);
    // usage-v2 is the companion's own schema, copied into its package rather than beside a validate.mjs.
    const published = [...kit.reports.map(report => report.contract), ...endpointContracts(kit).map(entry => entry.id)].filter(isPublishedContract);
    for (const id of published) {
      for (const suffix of ['schema.json', 'example.json']) {
        const copy = join(root, 'contract', `${id}.${suffix}`);
        assert.equal(readFileSync(copy, 'utf8'), readFileSync(`lib/generated/contracts/${id}.${suffix}`, 'utf8'), `${copy} is a copy: run npm run contracts and copy it`);
      }
    }
    assert.equal(readFileSync(join(root, 'contract/validate.mjs'), 'utf8'), readFileSync('lib/contract-validator.mjs', 'utf8'), `${kit.id}: contract/validate.mjs is a copy`);
  }
});

test('the generated contracts are current, and each example matches its own schema', () => {
  const directory = 'lib/generated/contracts';
  for (const contract of Object.values(contractRegistry)) {
    const schema = JSON.parse(readFileSync(join(directory, `${contract.id}.schema.json`), 'utf8'));
    const { $schema: _, ...generated } = z.toJSONSchema(contract.schema, { io: 'input' }) as Record<string, unknown>;
    const { $schema: __, $id: ___, title: ____, description: _____, ...written } = schema;
    assert.deepEqual(written, generated, `${contract.id}: run npm run contracts`);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, `${contract.id}.example.json`), 'utf8')), contract.example, `${contract.id} example: run npm run contracts`);
    assert.equal(contract.schema.safeParse(contract.example).success, true, contract.id);
    assert.deepEqual(validate(contract.example, schema), { valid: true, issues: [] }, contract.id);
  }
  assert.equal(readFileSync(join(directory, 'validate.mjs'), 'utf8'), readFileSync('lib/contract-validator.mjs', 'utf8'), 'validate.mjs is a copy: run npm run contracts');
});

test('the dependency-free validator and the zod source agree on what they refuse', () => {
  const example = <T extends keyof typeof reportContractRegistry>(id: T) => structuredClone(reportContractRegistry[id].example) as Record<string, any>;
  const refused: [keyof typeof reportContractRegistry, Record<string, any>][] = [];
  const tasks = example('tasks-v1');
  delete tasks.payload.sections;
  refused.push(['tasks-v1', tasks]);
  const untitled = example('tasks-v1');
  untitled.payload.sections.work.items[0].title = '';
  refused.push(['tasks-v1', untitled]);
  const priority = example('tasks-v1');
  priority.payload.sections.work.items[0].priority = 'asap';
  refused.push(['tasks-v1', priority]);
  const domain = example('tasks-v1');
  domain.payload.sections.errands = { items: [{ context: 'no title' }] };
  refused.push(['tasks-v1', domain]);
  const blank = example('standup-v1');
  blank.payload.markdown = '  \n ';
  refused.push(['standup-v1', blank]);
  const readings = example('readings-v1');
  readings.payload.markdown = 42;
  refused.push(['readings-v1', readings]);
  const audit = example('audit-v1');
  delete audit.html;
  refused.push(['audit-v1', audit]);
  const extra = example('report-envelope-v1');
  extra.unexpected = true;
  refused.push(['report-envelope-v1', extra]);
  const untitledReport = example('report-envelope-v1');
  untitledReport.title = '  ';
  refused.push(['report-envelope-v1', untitledReport]);
  const period = example('report-envelope-v1');
  period.period_key = '29-09-2026';
  refused.push(['report-envelope-v1', period]);

  for (const [id, body] of refused) {
    const schema = JSON.parse(readFileSync(`lib/generated/contracts/${id}.schema.json`, 'utf8'));
    assert.equal(reportContractRegistry[id].schema.safeParse(body).success, false, `zod refuses the ${id} case`);
    assert.equal(validate(body, schema).valid, false, `validate.mjs refuses the ${id} case`);
  }
  // Fields the board does not read yet pass both, so producers can add them first.
  const added = example('tasks-v1');
  added.payload.sections.work.items[0].estimate = '30m';
  added.payload.weather = 'clear';
  assert.equal(reportContractRegistry['tasks-v1'].schema.safeParse(added).success, true);
  assert.equal(validate(added, JSON.parse(readFileSync('lib/generated/contracts/tasks-v1.schema.json', 'utf8'))).valid, true);
});

test('the validator refuses schemas it cannot fully check, and its command line exits 1 on a mismatch', () => {
  assert.throws(() => assertSupported({ type: 'object', if: { type: 'object' } }), /unsupported keyword if/);
  assert.throws(() => assertSupported({ $ref: 'https://example.com/schema.json' }), /local/);
  const directory = mkdtempSync(join(tmpdir(), 'kit-contract-'));
  const report = join(directory, 'report.json');
  writeFileSync(report, JSON.stringify(reportContractRegistry['standup-v1'].example));
  const schema = 'lib/generated/contracts/standup-v1.schema.json';
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['lib/generated/contracts/validate.mjs', schema, report], { encoding: 'utf8' })), { valid: true });
  writeFileSync(report, JSON.stringify({ ...reportContractRegistry['standup-v1'].example, payload: {} }));
  assert.throws(() => execFileSync(process.execPath, ['lib/generated/contracts/validate.mjs', schema, report], { encoding: 'utf8', stdio: 'pipe' }),
    (error: { status: number; stdout: string }) => error.status === 1 && /markdown/.test(error.stdout));
});

test('ingestion reads the contract result in observe mode, with at most twenty issues', () => {
  const valid = checkReportContract('tasks', reportContractRegistry['tasks-v1'].example);
  assert.deepEqual(valid, { id: 'tasks-v1', enforcement: 'observe', valid: true, issues: [] });
  const drifted = structuredClone(reportContractRegistry['tasks-v1'].example) as Record<string, any>;
  drifted.payload.sections.work.items = Array.from({ length: 30 }, () => ({ priority: 'asap' }));
  const result = checkReportContract('tasks', drifted);
  assert.equal(result.valid, false);
  assert.equal(result.enforcement, 'observe');
  assert.equal(result.issues.length, 20);
  assert.deepEqual(result.issues[0].path.slice(0, 5), ['payload', 'sections', 'work', 'items', 0]);
  for (const kind of ['standup', 'readings', 'audit'] as const) assert.equal(checkReportContract(kind, {}).valid, false, kind);
});
