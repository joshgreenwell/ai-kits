import { requireSession } from '@/lib/auth';
import { telemetryDashboard } from '@/lib/telemetry-store';
import { failure, privateHeaders } from '@/lib/http';
import { usageCalibrations } from '@/lib/cloud-estimate-store';
export const maxDuration = 15;
export async function GET() {
  try {
    await requireSession(); const started = performance.now();
    const [data, calibrations] = await Promise.all([telemetryDashboard(), usageCalibrations()]);
    return Response.json({ ...data, calibrations }, { headers: { ...privateHeaders, 'Server-Timing': `data;dur=${(performance.now() - started).toFixed(1)}` } });
  }
  catch (error) { return failure(error); }
}
