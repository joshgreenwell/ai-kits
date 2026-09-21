import postgres from 'postgres';

/**
 * Two integration files assert what the archived upgrade migrations did to rows that already
 * existed, which needs scripts/test-db.mjs to have seeded their fixtures first. Since the
 * September 22, 2026 squash, supabase/migrations/ holds only the baseline: one file that builds
 * the schema from nothing, with no upgrade path and so no fixture. Those tests skip there, and
 * run again if supabase/migrations-archive/ is replayed through that runner.
 *
 * Returns `false` when the tests should run, or the sentence explaining the skip.
 * See supabase/migrations-archive/README.md.
 */
export async function upgradeFixtureReason(
  url: string | undefined,
  options: Record<string, unknown>,
  accountId: string,
): Promise<false | string> {
  if (!url) return 'no TEST_DATABASE_URL: run through npm run test:db';
  const sql = postgres(url, options);
  try {
    const [row] = await sql`
      SELECT count(*)::int AS rows FROM personal_hub.usage_accounts WHERE id = ${accountId}`;
    if (Number(row.rows) > 0) return false;
    return 'no upgrade fixture: supabase/migrations/ holds the baseline, which has no upgrade path';
  } finally {
    await sql.end({ timeout: 1 });
  }
}
