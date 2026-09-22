/**
 * The canonical revision order, in one place.
 *
 * The read (`lib/usage-query.ts`), the write-time recompute (`lib/usage-store.ts`) and the backfill
 * migration all spell it from here. If any one of them drifts, the projection is silently built in a
 * different order from the one the reading code believes, and nothing fails: the read just serves a
 * different revision than it used to. The contract test in `tests/usage-store.integration.test.ts`
 * asserting the backfill migration contains these exact fragments is what stands between this design
 * and that failure.
 */

/** A channel's trust order: an API's own accounting outranks a local transcript. */
export const channelRank = (a: string) =>
  `CASE ${a}.channel WHEN 'provider_api' THEN 0 WHEN 'app_server' THEN 1 WHEN 'local_file' THEN 2 WHEN 'local_db' THEN 2 ELSE 3 END`;
/** A session identity's trust order: one the provider stated outranks one derived locally. */
export const identityRank = (a: string) =>
  `CASE ${a}.session_identity WHEN 'provider' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END`;
/** The full canonical order. `id` last makes it strict and total, so a winner is never ambiguous. */
export const rankBy = (a: string) =>
  `${channelRank(a)}, ${identityRank(a)}, ${a}.observed_at DESC, ${a}.received_at DESC, ${a}.id DESC`;

/** Single valued: the ledger's own CHECK already guarantees a row satisfies at most one basis. */
export const projectBasis = (a: string) => `CASE
  WHEN ${a}.project_basis IN ('native','working_directory') AND ${a}.project_key IS NOT NULL THEN ${a}.project_basis
  WHEN ${a}.project_basis = 'none' THEN 'none'
  WHEN ${a}.project_basis IS NULL AND ${a}.project_key IS NULL AND ${a}.project_hash IS NOT NULL THEN 'working_directory'
  ELSE 'unknown' END`;
export const projectKey = (a: string) => `CASE
  WHEN ${a}.project_basis IN ('native','working_directory') AND ${a}.project_key IS NOT NULL THEN ${a}.project_key
  WHEN ${a}.project_basis IS NULL AND ${a}.project_key IS NULL AND ${a}.project_hash IS NOT NULL THEN ${a}.project_hash
  ELSE NULL END`;
/**
 * Project preference outranks channel, then falls back to the canonical order. A key's canonical
 * revision and its project-preferred revision can therefore differ, which is why the projection
 * carries the second one's evidence separately rather than reading it off the winner.
 */
export const projectOrderBy = (a: string) =>
  `CASE (${projectBasis(a)}) WHEN 'native' THEN 0 WHEN 'working_directory' THEN 1 WHEN 'none' THEN 2 ELSE 3 END, ${rankBy(a)}`;

/**
 * The ledger columns the projection carries off the canonical revision, in one list, used to build
 * both the upsert and the backfill. `outcome` is here even though no group-by reads it today: it is
 * a ledger fact, it costs about ten bytes, and dropping a column from a materialised contract
 * because it "appears unused" is how a card loses a field silently.
 */
export const CANONICAL_COLUMNS = [
  'provider', 'session_hash', 'model_actual', 'activity_at', 'surface', 'outcome',
  'reasoning_effort', 'service_tier', 'speed', 'context_window_tokens', 'cache_write_ttl', 'token_state',
  'input_fresh_tokens', 'input_cached_tokens', 'input_cache_write_tokens', 'output_tokens',
  'reasoning_tokens', 'unclassified_tokens', 'observed_total_tokens',
  'agent_key', 'agent_class', 'agent_name', 'agent_depth', 'parent_agent_key', 'agent_identity_basis',
] as const;

/** The winner columns, which are also the upsert guard's comparison tuple. */
export const GUARD_COLUMNS = ['revision_id', 'channel_rank', 'identity_rank', 'observed_at', 'received_at'] as const;
/** The project-preferred revision's evidence. Never a resolved project id or label: those move. */
export const EVIDENCE_COLUMNS = ['effective_project_basis', 'effective_project_key', 'project_provider', 'project_install_id'] as const;
/** Every column the projection maintains, in the order the upsert and the backfill both write them. */
export const PROJECTION_COLUMNS = [...GUARD_COLUMNS, 'source_id', ...CANONICAL_COLUMNS, ...EVIDENCE_COLUMNS] as const;

/**
 * The recompute. `%KEYS%` is replaced by a join restricting it to the keys one envelope touched, or
 * by nothing at all for the backfill, which recomputes every key. It ranks a key's WHOLE history
 * with no time window on purpose: that is what makes a late-arriving revision correct in both
 * directions without any reasoning about arrival order.
 */
export const CANONICAL_REQUESTS_SELECT = `
  SELECT r.account_id, r.semantic_key, r.id AS revision_id,
    (${channelRank('r')})::smallint AS channel_rank,
    (${identityRank('r')})::smallint AS identity_rank,
    r.observed_at, r.received_at, b.source_id,
    ${CANONICAL_COLUMNS.map(c => `r.${c}`).join(', ')},
    first_value(${projectBasis('r')}) OVER project_order AS effective_project_basis,
    first_value(${projectKey('r')})   OVER project_order AS effective_project_key,
    first_value(r.provider)           OVER project_order AS project_provider,
    first_value(b.install_id)         OVER project_order AS project_install_id,
    row_number() OVER (PARTITION BY r.account_id, r.semantic_key ORDER BY ${rankBy('r')}) AS rank
  FROM personal_hub.activity_requests r
  %KEYS%
  JOIN personal_hub.companion_bindings b ON b.id = r.binding_id
  WINDOW project_order AS (PARTITION BY r.account_id, r.semantic_key ORDER BY ${projectOrderBy('r')})`;

/**
 * ONE guard for the whole row, which is why every assignment in the upsert is a plain
 * `= EXCLUDED.x` with no CASE per column.
 *
 * Arm 1 is a STRICT WINNER COMPARISON in the rank order, not a change detector. Negating the two
 * ascending ranks turns `rankBy`'s mixed ASC/DESC order into one monotone tuple, so "the candidate
 * outranks the stored row" is a single row comparison. `revision_id` is the ledger's primary key, so
 * the order is strict and total, and every column in both tuples is NOT NULL by the table's DDL,
 * which matters because a row comparison containing a NULL yields NULL and a WHERE reads that as
 * false.
 *
 * Why not `IS DISTINCT FROM`. Two ingests overlap. A recomputes and gets revision x. B recomputes on
 * a snapshot that cannot see A's rows and gets y, ranked below x. A commits, then B commits.
 * Postgres evaluates DO UPDATE against the latest committed version of the row, so B compares
 * against what A wrote, sees y differs from x, and overwrites the winner with the loser. Nothing
 * repairs it, because the next delivery inserts nothing and never revisits the key unless it is
 * touched again, so the read would serve a non-canonical revision indefinitely.
 *
 * Arm 2 covers the case arm 1 misses in ordinary sequential operation: the canonical revision is
 * unchanged but a newly arrived sibling carries better project evidence, which a different ordering
 * chooses. Equality of the guard tuple means equality of `revision_id`, so arm 2 is exactly "same
 * winner, different evidence". It keeps a replay free and keeps the evidence fresh.
 */
export const CANONICAL_GUARD = `(
    (-EXCLUDED.channel_rank, -EXCLUDED.identity_rank, EXCLUDED.observed_at, EXCLUDED.received_at, EXCLUDED.revision_id)
      > (-c.channel_rank, -c.identity_rank, c.observed_at, c.received_at, c.revision_id)
    OR (EXCLUDED.revision_id = c.revision_id
        AND (EXCLUDED.effective_project_basis, EXCLUDED.effective_project_key, EXCLUDED.project_provider, EXCLUDED.project_install_id)
            IS DISTINCT FROM (c.effective_project_basis, c.effective_project_key, c.project_provider, c.project_install_id)))`;

/** The upsert the ingest path runs, and, with `keysJoin` empty, the statement the backfill runs. */
export const canonicalRequestsUpsert = (keysJoin: string, touched?: string) => `
  ${touched ?? ''}${touched ? ',\n  ' : 'WITH '}ranked AS (${CANONICAL_REQUESTS_SELECT.replace('%KEYS%', keysJoin)})
  INSERT INTO personal_hub.canonical_requests AS c
    (account_id, semantic_key, ${PROJECTION_COLUMNS.join(', ')}, updated_at)
  SELECT account_id, semantic_key, ${PROJECTION_COLUMNS.join(', ')}, now()
  FROM ranked WHERE rank = 1
  ORDER BY account_id, semantic_key
  ON CONFLICT (account_id, semantic_key) DO UPDATE SET
    ${PROJECTION_COLUMNS.map(c => `${c} = EXCLUDED.${c}`).join(', ')},
    updated_at = now()
  WHERE ${CANONICAL_GUARD}`;

/**
 * Rebuild the projection from the ledger. This is the repair route, and the rule it enforces is
 * operational: ANY path that writes personal_hub.activity_requests outside `ingestUsage` must call
 * this afterwards, or the projection will not know those keys exist and the reads will not show them.
 * That covers migrations that insert or delete ledger rows, and test fixtures that seed with raw SQL.
 *
 * With no arguments it recomputes every key, which is what the backfill migration does. It carries
 * the same guard as the ingest upsert, so it is idempotent and cannot lower a winner a concurrent
 * envelope has just raised. A rebuild after a ledger DELETE needs the unguarded form instead, because
 * a deleted winner must be allowed to be replaced by a lower-ranked survivor.
 */
export const refreshCanonicalRequests = (
  sql: { unsafe: (query: string) => Promise<unknown> }, keysJoin = '', touched?: string,
) => sql.unsafe(canonicalRequestsUpsert(keysJoin, touched));

/*
 * THE TOOL PROJECTION.
 *
 * personal_hub.canonical_tool_invocations holds one row per (account_id, invocation_key) with TWO
 * independent registers: the canonical invocation revision, and the latest result revision. The read
 * used to find the second with one index lookup into tool_events per invocation, 64,745 of them for a
 * month, which measured 34-46 s on its own against a 30 s section budget.
 *
 * Two registers rather than one winner, because the two facts arrive independently. A result can land
 * in a later envelope than its invocation, or in an earlier one, and either can be replayed. Folding
 * both into one guarded tuple would lose an update under concurrency: an envelope that saw the newer
 * invocation but not the newer result would win the comparison and overwrite the result another
 * envelope had just stored. So each register keeps its own strict guard.
 *
 * ONE statement, not one per register. Two statements each locked only the keys that had a row of their
 * own kind, so a transaction carrying an invocation for one key and a result for another locked them in
 * opposite orders, and two concurrent envelopes deadlocked: a review reproduced 4 in 500. It also wrote
 * every row twice, which roughly doubled the backfilled table. Here the two winners are joined per key,
 * each key is locked once in one sorted pass, and each register's columns are assigned through its own
 * guard. Every SET expression reads the same locked row, so the guards stay independent.
 *
 * Tool revisions rank by recency alone, the order the read always used: observed_at, received_at, id.
 */
const toolRecency = (a: string) => `${a}.observed_at DESC, ${a}.received_at DESC, ${a}.id DESC`;
const NIL_UUID = `'00000000-0000-0000-0000-000000000000'::uuid`;

/** The invocation register: its winner, then the facts the tools card reads off it. */
export const TOOL_INVOCATION_COLUMNS = [
  'inv_revision_id', 'inv_observed_at', 'inv_received_at', 'source_id',
  'tool_name', 'tool_namespace', 'tool_class', 'outcome', 'caller_request_key', 'caller_agent_key', 'session_hash',
] as const;
/** The result register: its winner, then the outcome it reports. */
export const TOOL_RESULT_COLUMNS = ['res_revision_id', 'res_observed_at', 'res_received_at', 'res_outcome'] as const;

/**
 * True when the candidate register outranks the stored one, with an empty stored register older than any
 * revision. The candidate side is NULL when this envelope's keys had no revision of that kind; the row
 * comparison is then NULL, and coalesce turns that into "keep what is stored".
 */
const registerGuard = (prefix: 'inv' | 'res') => `coalesce((EXCLUDED.${prefix}_observed_at, EXCLUDED.${prefix}_received_at, EXCLUDED.${prefix}_revision_id)
      > (coalesce(c.${prefix}_observed_at, '-infinity'::timestamptz), coalesce(c.${prefix}_received_at, '-infinity'::timestamptz), coalesce(c.${prefix}_revision_id, ${NIL_UUID})), false)`;

/**
 * The tool projection upsert. `keysJoin` joins alias `t` to the keys one envelope touched; empty recomputes
 * every invocation, as the backfill does. Both registers recompute from the ledger over the invocation's
 * whole history, so arrival order never matters.
 */
export const canonicalToolUpsert = (keysJoin: string, touched?: string) => {
  const inv = TOOL_INVOCATION_COLUMNS, res = TOOL_RESULT_COLUMNS;
  const assign = (columns: readonly string[], prefix: 'inv' | 'res') =>
    columns.map(c => `${c} = CASE WHEN ${registerGuard(prefix)} THEN EXCLUDED.${c} ELSE c.${c} END`).join(',\n    ');
  return `
  ${touched ? `${touched},\n  ` : 'WITH '}inv AS (
    SELECT t.account_id, t.invocation_key, t.id AS inv_revision_id, t.observed_at AS inv_observed_at, t.received_at AS inv_received_at,
      b.source_id, t.tool_name, t.tool_namespace, t.tool_class, t.outcome, t.caller_request_key, t.caller_agent_key, t.session_hash,
      row_number() OVER (PARTITION BY t.account_id, t.invocation_key ORDER BY ${toolRecency('t')}) AS rank
    FROM personal_hub.tool_events t
    ${keysJoin}
    JOIN personal_hub.companion_bindings b ON b.id = t.binding_id
    WHERE t.event_kind = 'invocation'
  ), res AS (
    SELECT t.account_id, t.invocation_key, t.id AS res_revision_id, t.observed_at AS res_observed_at, t.received_at AS res_received_at,
      t.outcome AS res_outcome,
      row_number() OVER (PARTITION BY t.account_id, t.invocation_key ORDER BY ${toolRecency('t')}) AS rank
    FROM personal_hub.tool_events t
    ${keysJoin}
    WHERE t.event_kind = 'result'
  ), merged AS (
    SELECT coalesce(i.account_id, r.account_id) AS account_id, coalesce(i.invocation_key, r.invocation_key) AS invocation_key,
      ${inv.map(c => `i.${c}`).join(', ')},
      ${res.map(c => `r.${c}`).join(', ')}
    FROM (SELECT * FROM inv WHERE rank = 1) i
    FULL OUTER JOIN (SELECT * FROM res WHERE rank = 1) r ON r.account_id = i.account_id AND r.invocation_key = i.invocation_key
  )
  INSERT INTO personal_hub.canonical_tool_invocations AS c (account_id, invocation_key, ${[...inv, ...res].join(', ')}, updated_at)
  SELECT account_id, invocation_key, ${[...inv, ...res].join(', ')}, now()
  FROM merged
  ORDER BY account_id, invocation_key
  ON CONFLICT (account_id, invocation_key) DO UPDATE SET
    ${assign(inv, 'inv')},
    ${assign(res, 'res')},
    updated_at = now()
  WHERE ${registerGuard('inv')} OR ${registerGuard('res')}`;
};

/** The recency order, exported so the contract test can assert the backfill migration spells it. */
export const toolRankBy = toolRecency;

/**
 * Rebuild the tool projection from the ledger. The same rule as `refreshCanonicalRequests`: any path
 * that writes personal_hub.tool_events outside `ingestUsage` must call this afterwards.
 */
export const refreshCanonicalToolInvocations = (sql: { unsafe: (query: string) => Promise<unknown> }) =>
  sql.unsafe(canonicalToolUpsert(''));

/** Both projections, for fixtures and repairs that touch both ledgers. */
export const refreshCanonicalProjections = async (sql: { unsafe: (query: string) => Promise<unknown> }) => {
  await refreshCanonicalRequests(sql);
  await refreshCanonicalToolInvocations(sql);
};
