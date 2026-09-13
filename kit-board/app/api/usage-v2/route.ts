import { requireSession } from '@/lib/auth';
import { failure, privateHeaders } from '@/lib/http';
import { usageStore } from '@/lib/usage-store';
export const maxDuration = 15;
/** Installs, bindings, coverage, settings, ledger counts, and current allowance readings for the new views. */
export async function GET() {
  try {
    await requireSession(); const started = performance.now();
    const data = await usageStore.usageDashboard();
    return Response.json(data, { headers: { ...privateHeaders, 'Server-Timing': `data;dur=${(performance.now() - started).toFixed(1)}` } });
  } catch (error) { return failure(error); }
}
