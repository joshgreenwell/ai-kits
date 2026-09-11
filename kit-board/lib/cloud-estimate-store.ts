import 'server-only';
import { randomUUID } from 'node:crypto';
import { database } from './db';
import { telemetryDashboard } from './telemetry-store';
import { RequestError } from './contracts';
import { readCache } from './read-cache';
import { calibrationPreview, calibrationRequest, type Calibration, type EstimateData } from './cloud-estimate';

const saved = readCache(30_000, async () => {
  const rows = await database()`SELECT * FROM personal_hub.usage_calibrations
    WHERE revoked_at IS NULL AND ended_at >= now() - interval '30 days' ORDER BY confirmed_at DESC LIMIT 250`;
  return JSON.parse(JSON.stringify(rows)) as Calibration[];
});
export const usageCalibrations = () => saved.get();

export async function saveCalibration(input: unknown) {
  const request = calibrationRequest.parse(input);
  const data = await telemetryDashboard() as EstimateData;
  const preview = calibrationPreview(data, request.account_id, request.start_sample_id, request.end_sample_id);
  if (!preview.ok) throw new RequestError(preview.reason, 422);
  const c = preview.value;
  const rows = await database()`INSERT INTO personal_hub.usage_calibrations
    (id, account_id, window_key, window_minutes, start_sample_id, end_sample_id, started_at, ended_at,
     local_tokens, percent_delta, tokens_per_point, method_version)
    VALUES (${randomUUID()}, ${c.account_id}, ${c.window_key}, ${c.window_minutes}, ${c.start_sample_id}, ${c.end_sample_id},
      ${c.started_at}, ${c.ended_at}, ${c.local_tokens}, ${c.percent_delta}, ${c.tokens_per_point}, ${c.method_version})
    ON CONFLICT (account_id, start_sample_id, end_sample_id, method_version) WHERE revoked_at IS NULL DO NOTHING RETURNING id`;
  saved.invalidate();
  return { ok: true, duplicate: rows.length === 0 };
}

export async function revokeCalibration(id: string) {
  await database()`UPDATE personal_hub.usage_calibrations SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL`;
  saved.invalidate();
}
