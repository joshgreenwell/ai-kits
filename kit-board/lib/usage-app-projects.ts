import { createHash } from 'node:crypto';

/**
 * The usage_projects id of an app project: derived from its name alone, so same-named projects on the
 * PC, the Mac and in different apps merge into one project (spec section 10, merge by
 * lower(btrim(name))). The shape is the one 20260913235900 gives identities: md5 split 8-4-(4)3-(8)3-12
 * with the version and variant nibbles fixed. `appProjectIdSql` is the same derivation in SQL, and the
 * integration test proves the two agree (I3).
 *
 * `btrim` here strips only U+0020, exactly as Postgres `btrim(text)` does, and names arrive already
 * trimmed by the contract, so the two are the same in practice. `lower` is JS's default Unicode case
 * mapping; it matches Postgres `lower` under an ICU or UTF-8 libc collation for the names the parity
 * test covers. The JS derivation is the one ingest uses, so a collation difference could only ever
 * affect a comparison made in SQL, and nothing in the application derives it there.
 */
export const APP_PROJECT_ID_PREFIX = 'app-project-name:';
const btrim = (text: string) => text.replace(/^ +| +$/g, '');
export function appProjectId(name: string): string {
  const h = createHash('md5').update(`${APP_PROJECT_ID_PREFIX}${btrim(name).toLowerCase()}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The same derivation in SQL over a text expression, for the parity test and any repair that needs it. */
export const appProjectIdSql = (name: string) => {
  const m = `md5('${APP_PROJECT_ID_PREFIX}' || lower(btrim(${name})))`;
  return `(substr(${m}, 1, 8) || '-' || substr(${m}, 9, 4) || '-4' || substr(${m}, 14, 3) || '-8' || substr(${m}, 18, 3) || '-' || substr(${m}, 21, 12))::uuid`;
};
