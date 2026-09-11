'use client';
import { useEffect, useRef, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import type { QuotaSample } from '@/lib/telemetry-contract';
import { fetchPrivateJson } from '@/lib/fetch-private-json';
import type { Calibration } from '@/lib/cloud-estimate';
export type LiveData = {
  accounts: { id: string; label: string; provider: string }[];
  sources: { id: string; account_id: string; machine_label: string; mode: string; disabled: boolean; last_seen_at: string | null;
    coverage: { since?: string; files?: number; bytes_read?: number; duration_ms?: number; malformed_lines?: number; unavailable_roots?: number } | null }[];
  hourly: { account_id: string; hour: string; model: string; total_tokens: number; input_tokens: number; cached_tokens: number; cache_write_tokens: number; output_tokens: number; calls: number }[];
  quotas: (QuotaSample & { id: string; account_id: string })[];
  calibrations?: Calibration[];
  history: { machine_id: string; machine_name: string; month: string; total_tokens: number; daily: { date: string; total_tokens: number; calls: number }[] }[];
  as_of: string;
};
export function useLiveData() {
  const [data, setData] = useState<LiveData | null>(null), [error, setError] = useState('');
  const [now, setNow] = useState(0);
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (document.hidden || inFlight || controller.signal.aborted) return;
      inFlight = true;
      setNow(Date.now());
      try { const result = await fetchPrivateJson<LiveData>('/api/usage-live', controller.signal);
        if (!controller.signal.aborted) { setData(result); setError(''); } }
      catch { if (!controller.signal.aborted) setError('Usage is temporarily unavailable. Retry below; any previous readings remain visible.'); }
      finally { inFlight = false; }
    };
    retry.current = () => { void refresh(); };
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    void refresh(); const timer = setInterval(refresh, 60_000);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, []);
  return { data, error, now, retry: () => retry.current() };
}
export function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return <label className="grid gap-1.5"><span className="text-muted-foreground text-xs font-semibold">{label}</span><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger><SelectContent position="popper">{options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select></label>;
}
export const tokens = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
export const when = (v: string | null) => v ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not connected';
export function countdown(v: string, now: number) {
  const h = (Date.parse(v) - now) / 3_600_000;
  if (h <= 0) return 'Awaiting new window';
  return h >= 24 ? `${Math.floor(h / 24)}d ${Math.floor(h % 24)}h` : `${Math.floor(h)}h ${Math.floor((h % 1) * 60)}m`;
}
