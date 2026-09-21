import test from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
import { createUsageQuery, parseUsageQuery, usageQuerySchema, USAGE_QUERY_CACHE_TTL_MS, USAGE_QUERY_SECTIONS } from '../lib/usage-query';
import { DATABASE_JOB_BUDGET_INTERVAL } from '../lib/database-budget';

test('the usage query accepts a section and rejects an unknown one', () => {
  assert.equal(parseUsageQuery(new URLSearchParams()).section, undefined);
  assert.equal(parseUsageQuery(new URLSearchParams('section=overview')).section, 'overview');
  assert.equal(parseUsageQuery(new URLSearchParams('preset=last_7_days&section=tools')).section, 'tools');
  assert.equal(parseUsageQuery(new URLSearchParams('section=knowledge')).section, 'knowledge');
  assert.deepEqual(USAGE_QUERY_SECTIONS, ['overview', 'requests', 'tools', 'knowledge']);
  assert.equal(USAGE_QUERY_CACHE_TTL_MS, 5 * 60_000);
  assert.equal(usageQuerySchema.safeParse({ section: 'everything' }).success, false);
});

const MACHINE = '11111111-1111-4111-8111-111111111111';
const AGENT = 'a'.repeat(64);
const SEPTEMBER = { preset: 'custom', start: '2026-09-01T05:00:00Z', end: '2026-09-14T20:30:00Z', accounts: 'acct' };

/** A database that answers the metadata reads with one account and one machine and records every positional statement. */
function recordingDatabase() {
  const statements: { text: string; values: unknown[] }[] = [];
  const tagged = (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('FROM personal_hub.usage_accounts')) return Promise.resolve([{ id: 'acct', provider: 'claude', label: 'Account' }]);
    if (text.includes('FROM personal_hub.telemetry_sources')) return Promise.resolve([{ id: MACHINE, account_id: 'acct', machine_label: 'host', mode: 'companion' }]);
    return Promise.resolve([]);
  };
  const unsafe = async (text: string, values: unknown[] = []) => { statements.push({ text, values }); return []; };
  const db = Object.assign(tagged, { unsafe, begin: (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => fn({ unsafe }) });
  return { db: db as unknown as ReturnType<typeof postgres>, statements };
}
const run = async (extra: Record<string, string>) => {
  const { db, statements } = recordingDatabase();
  const result = await createUsageQuery(() => db).usageQuery(parseUsageQuery(new URLSearchParams({ ...SEPTEMBER, ...extra })), { now: Date.parse('2026-09-14T20:30:00Z') });
  const find = (marker: string) => statements.find(s => s.text.includes(marker));
  return { result, statements, find };
};
/** The bound value a `$n` placeholder in `text` refers to, so the assertion reads the predicate and its argument together. */
const bound = (statement: { text: string; values: unknown[] }, predicate: RegExp) => {
  const match = statement.text.match(predicate);
  assert.ok(match, `expected ${predicate} in:\n${statement.text}`);
  return statement.values[Number(match![1]) - 1];
};

test('the knowledge section applies the machine filter through the access binding and the agent filter through the invocation caller', async () => {
  const { find, result } = await run({ section: 'knowledge', machines: MACHINE, agents: AGENT });
  const accesses = find('CREATE TEMP TABLE _usage_accesses')!;
  assert.deepEqual(bound(accesses, /AND b\.source_id = ANY\(\$(\d+)::uuid\[\]\)/), [MACHINE], 'accesses are limited to the selected machine\'s binding');
  const invocations = find('CREATE TEMP TABLE _usage_access_invocations')!;
  assert.match(invocations.text, /caller_keys AS/, 'an agent filter is a detail filter, so the calling requests are ranked for the access invocations');
  assert.deepEqual(bound(invocations, /r\.agent_key = ANY\(\$(\d+)::text\[\]\)/), [AGENT]);
  assert.deepEqual(bound(invocations, /source_id = ANY\(\$(\d+)::uuid\[\]\)/), [MACHINE], 'the calling request follows the same machine filter as tools');
  const rows = find('AS distinct_agents')!;
  assert.deepEqual(bound(rows, /WHERE i\.caller_agent_key = ANY\(\$(\d+)::text\[\]\) AND i\.matches/), [AGENT]);
  const total = find('AS distinct_invocations\n')!;
  assert.match(total.text, /WHERE i\.caller_agent_key = ANY\(\$1::text\[\]\) AND i\.matches AND a\.current_configuration/, 'the unduplicated total is filtered like the rows');
  assert.deepEqual(result.knowledge.unsupported_filters, ['detail filters apply through the calling request; invocations without a retained caller request are excluded']);
  assert.equal(find('in_range_invocations AS'), undefined, 'the knowledge section does not read the tools section\'s invocation set');
});

test('the knowledge section ranks no requests without a detail filter and reports the model filter it cannot apply', async () => {
  const plain = await run({ section: 'knowledge' });
  const invocations = plain.find('CREATE TEMP TABLE _usage_access_invocations')!;
  assert.doesNotMatch(invocations.text, /caller_keys AS/);
  assert.match(invocations.text, /SELECT i\.\*, true AS matches FROM invocations i$/);
  assert.doesNotMatch(plain.find('CREATE TEMP TABLE _usage_accesses')!.text, /b\.source_id = ANY/);
  assert.match(plain.find('AS distinct_agents')!.text, /= a\.invocation_key\s+GROUP BY/, 'no access-level predicate without agent or detail filters');
  assert.deepEqual(plain.result.knowledge.unsupported_filters, []);
  assert.doesNotMatch(plain.result.knowledge.note, /model filter/);

  const model = await run({ section: 'knowledge', models: 'm1' });
  assert.deepEqual(model.result.knowledge.unsupported_filters, ['models']);
  assert.match(model.result.knowledge.note, /The model filter is not applied to knowledge accesses/);
  assert.doesNotMatch(model.find('CREATE TEMP TABLE _usage_access_invocations')!.text, /model_actual/, 'a model filter alone has no request to apply through');

  const effort = await run({ section: 'knowledge', efforts: 'high' });
  const ranked = effort.find('CREATE TEMP TABLE _usage_access_invocations')!;
  assert.deepEqual(bound(ranked, /r\.reasoning_effort = ANY\(\$(\d+)::text\[\]\)/), ['high'], 'effort reaches accesses through the calling request');
  assert.match(effort.find('AS distinct_agents')!.text, /WHERE i\.matches GROUP BY/);
});

test('agent lifecycle evidence follows the machine and agent filters and names the ones it cannot apply', async () => {
  const filtered = await run({ section: 'requests', machines: MACHINE, agents: AGENT, efforts: 'high' });
  const events = filtered.find('FROM personal_hub.agent_events e')!;
  assert.deepEqual(bound(events, /AND b\.source_id = ANY\(\$(\d+)::uuid\[\]\)/), [MACHINE]);
  assert.deepEqual(bound(events, /AND e\.agent_key = ANY\(\$(\d+)::text\[\]\)/), [AGENT]);
  assert.match(filtered.result.agents.coverage.note, /the efforts filter does not apply to them/);
  const plain = await run({ section: 'requests' });
  assert.doesNotMatch(plain.find('FROM personal_hub.agent_events e')!.text, /source_id = ANY|agent_key = ANY/);
  assert.doesNotMatch(plain.result.agents.coverage.note, /Spawn events/);
  const two = await run({ section: 'requests', models: 'm1', surfaces: 'cli' });
  assert.match(two.result.agents.coverage.note, /the models, surfaces filters do not apply to them/);
});

test('every section transaction opens by setting the shared read budget on Postgres', async () => {
  // The recording database answers the detail sections; the overview's straddle read needs a row and shares prepareRead anyway.
  for (const section of ['requests', 'tools', 'knowledge']) {
    const { statements } = await run({ section });
    const budget = statements.filter(s => s.text.includes("set_config('statement_timeout'"));
    assert.ok(budget.length >= 1, `${section} sets the budget`);
    for (const statement of budget) {
      assert.deepEqual(statement.values, [DATABASE_JOB_BUDGET_INTERVAL], 'one number, bound as a value, not inlined');
      assert.match(statement.text, /set_config\('transaction_timeout', \$1, true\)/, 'the whole transaction is bounded on Postgres 17');
      assert.match(statement.text, /server_version_num/, 'older servers get only the statement timeout');
    }
    assert.equal(statements[0], budget[0], `${section} sets the budget before any read`);
  }
