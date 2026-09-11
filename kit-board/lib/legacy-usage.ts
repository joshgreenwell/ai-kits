import { digest } from './crypto';
import { RequestError, reportSchema, stableJson, type ReportInput } from './contracts';
import { parseLegacyEnvelope } from './usage';

const legacyOrigin = 'https://token-observatory-jg.josh470070.chatgpt.site';
const legacyEndpoint = `${legacyOrigin}/api/reports`;
const maximumResponseBytes = 4_000_000;
const maximumReports = 100;

export type LegacyUsageConfig = {
  endpoint: string;
  apiKey: string;
  sitesBypassToken: string;
};

type LegacyReportRow = { envelope: unknown };

function text(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) throw new RequestError(`Legacy usage ${label} is not configured`, 503);
  return value.trim();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError('Legacy usage response is invalid', 502);
  return value as Record<string, unknown>;
}

function approvedEndpoint(endpoint: string) {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new RequestError('Legacy usage endpoint is invalid', 503); }
  if (url.href !== legacyEndpoint || url.username || url.password || url.search || url.hash) {
    throw new RequestError('Legacy usage endpoint is not allowed', 503);
  }
  return url.href;
}

export function parseLegacyUsageConfig(raw = process.env.LEGACY_USAGE_CONFIG_JSON): LegacyUsageConfig {
  if (!raw) throw new RequestError('Legacy usage sync is not configured', 503);
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(raw)); } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('Legacy usage sync is not configured', 503);
  }
  const endpoint = text(value.endpoint, 'endpoint');
  return { endpoint: approvedEndpoint(endpoint), apiKey: text(value.api_key, 'API key'), sitesBypassToken: text(value.sites_bypass_token, 'Sites token') };
}

async function readResponseJson(response: Response): Promise<unknown> {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new RequestError('Legacy usage response is invalid', 502);
  }
  const advertised = Number(response.headers.get('content-length') ?? 0);
  if (!Number.isFinite(advertised) || advertised > maximumResponseBytes) throw new RequestError('Legacy usage response is too large', 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumResponseBytes) { await reader.cancel(); throw new RequestError('Legacy usage response is too large', 502); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError('Legacy usage response is invalid', 502); }
}

export async function fetchLegacyUsage(config: LegacyUsageConfig, fetcher: typeof fetch = fetch): Promise<LegacyReportRow[]> {
  const endpoint = approvedEndpoint(config.endpoint);
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'OAI-Sites-Authorization': `Bearer ${config.sitesBypassToken}`,
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new RequestError('Legacy usage source is unavailable', 502); }
  if (!response.ok) throw new RequestError('Legacy usage source is unavailable', 502);
  const payload = object(await readResponseJson(response));
  if (!Array.isArray(payload.reports) || payload.reports.length > maximumReports) throw new RequestError('Legacy usage response is invalid', 502);
  return payload.reports.map(row => {
    const candidate = object(row);
    if (!('envelope' in candidate)) throw new RequestError('Legacy usage response is invalid', 502);
    return { envelope: candidate.envelope };
  });
}

export function usageReportFromLegacyEnvelope(envelope: unknown): ReportInput {
  let parsed: ReturnType<typeof parseLegacyEnvelope>;
  try {
    parsed = parseLegacyEnvelope(envelope);
    if (!Number.isFinite(Date.parse(parsed.generatedAt))) throw new Error('invalid observation date');
  } catch { throw new RequestError('Legacy usage response contains an invalid report', 502); }
  return reportSchema.parse({
    schema_version: 1,
    period_key: parsed.month,
    subject_key: parsed.machineId,
    idempotency_key: digest(stableJson(envelope)),
    title: `${parsed.machineName} · ${parsed.month}`,
    // Preserve the observation recorded by the originating machine; never substitute sync time.
    produced_at: new Date(parsed.generatedAt).toISOString(),
    status: parsed.periodState ?? 'complete',
    coverage: { schema_version: parsed.schemaVersion, machine_id: parsed.machineId },
    payload: envelope as Record<string, unknown>,
  });
}

async function existingUsageContent(report: ReportInput) {
  const { database } = await import('./db');
  const contentHash = digest(stableJson(report));
  const rows = await database()`SELECT id FROM personal_hub.report_revisions
    WHERE kind = 'usage' AND content_hash = ${contentHash} LIMIT 1`;
  return rows[0]?.id as string | undefined;
}

export async function syncLegacyUsage(config = parseLegacyUsageConfig()) {
  const sourceRows = await fetchLegacyUsage(config);
  const inserted: string[] = [];
  const skipped: string[] = [];
  const duplicate: string[] = [];
  for (const sourceRow of sourceRows) {
    const report = usageReportFromLegacyEnvelope(sourceRow.envelope);
    const prior = await existingUsageContent(report);
    if (prior) { skipped.push(prior); continue; }
    const { storeReport } = await import('./db');
    const receipt = await storeReport('usage', 'legacy-usage', report);
    (receipt.duplicate ? duplicate : inserted).push(receipt.id);
  }
  return { fetched: sourceRows.length, inserted, skipped, duplicate };
}
