import { requireProducer, requireSession } from '@/lib/auth';
import { digest } from '@/lib/crypto';
import { readJson, reportSchema, RequestError, stableJson } from '@/lib/contracts';
import { storeReport, usageReports } from '@/lib/db';
import { failure, privateHeaders } from '@/lib/http';
import { parseLegacyEnvelope } from '@/lib/usage';
export const maxDuration = 15;

export async function GET() {
  try {
    await requireSession();
    const started = performance.now();
    const records = await usageReports();
    const reports = records.map(({ payload }) => {
      const summary = parseLegacyEnvelope(payload);
      return { ...Object.fromEntries(Object.entries(summary).filter(([key]) => key !== 'reportJson').map(([key, value]) => [key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase()), value])), envelope: payload };
    });
    return Response.json({ reports }, { headers: { ...privateHeaders, 'Server-Timing': `data;dur=${(performance.now() - started).toFixed(1)}` } });
  } catch (error) { return failure(error); }
}

// Compatibility endpoint: existing Codex/Claude exporters can keep their JSON schema.
export async function POST(request: Request) {
  try {
    const producer = requireProducer(request, 'usage');
    const envelope = await readJson(request) as Record<string, unknown>;
    let parsed;
    try { parsed = parseLegacyEnvelope(envelope); if (!Number.isFinite(Date.parse(parsed.generatedAt))) throw new Error('Invalid observation date'); } catch { throw new RequestError('Invalid monthly usage envelope'); }
    const report = reportSchema.parse({
      schema_version: 1, period_key: parsed.month, subject_key: parsed.machineId,
      idempotency_key: digest(stableJson(envelope)), title: `${parsed.machineName} · ${parsed.month}`,
      produced_at: new Date(parsed.generatedAt).toISOString(), status: parsed.periodState ?? 'complete',
      coverage: { schema_version: parsed.schemaVersion, machine_id: parsed.machineId }, payload: envelope,
    });
    const receipt = await storeReport('usage', producer, report);
    return Response.json({ ok: true, machine_id: parsed.machineId, month: parsed.month, ...receipt }, { status: receipt.duplicate ? 200 : 201, headers: privateHeaders });
  } catch (error) { return failure(error); }
}
