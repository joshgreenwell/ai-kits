'use client';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { when, type LiveData } from '@/components/telemetry-shared';
import { usageStatus } from '@/lib/usage-status';

const tone = { fresh: 'soft', partial: 'soft-warning', stale: 'soft-warning', none: 'outline' } as const;

/** The compact data-status line under a usage header: when, how many collectors, and whether they are current; details live under Settings. */
export function UsageStatusLine({ data, now, error }: { data: LiveData | null; now: number; error?: string }) {
  if (!data) return <p className="text-muted-foreground font-mono text-[11px]" role="status">{error ? 'Status unavailable' : 'Loading status…'} · <Link href="/settings" className="underline underline-offset-4">Settings</Link></p>;
  const status = usageStatus(data.sources, now);
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px]" role="status">
      <span>Updated {when(data.as_of)}</span>
      <span aria-hidden="true">·</span>
      <Link href="/settings" className="underline underline-offset-4">{status.collectors} {status.collectors === 1 ? 'collector' : 'collectors'}</Link>
      <Badge variant={tone[status.state]} className="text-[10px]" title={status.label}>{status.state === 'none' ? 'not connected' : status.state}</Badge>
    </p>
  );
}
