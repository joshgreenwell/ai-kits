'use client';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { when, type LiveData } from '@/components/telemetry-shared';
import { usageStatus } from '@/lib/usage-status';

const tone = { fresh: 'soft', partial: 'soft-warning', stale: 'soft-warning', none: 'outline' } as const;

/** The compact data-status line under a usage header: when, how many collectors, and whether they are current; details live under Settings. */
export function UsageStatusLine({ data, now, error }: { data: LiveData | null; now: number; error?: string }) {
  if (!data) return <p className="text-muted-foreground font-mono text-[11px]" role="status">{error ? 'Status unavailable' : 'Loading status…'} · <Link href="/settings" className="underline underline-offset-4">Settings</Link></p>;
  const status = usageStatus(data.sources, now);
  const accounts = new Map(data.accounts.map(account => [account.id, account.label]));
  const enabled = data.sources.filter(source => !source.disabled);
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px]" role="status">
      <span>Updated {when(data.as_of)}</span>
      <span aria-hidden="true">·</span>
      {/* The count alone says nothing about which collectors those are; hovering names them without
          spending a line of the header, and the link still goes to Settings for the full detail. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Link href="/settings" className="underline decoration-dotted underline-offset-4">{status.collectors} {status.collectors === 1 ? 'collector' : 'collectors'}</Link>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-[22rem]">
          {enabled.length ? (
            <ul className="grid gap-1">
              {enabled.map(source => (
                <li key={source.id} className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-medium">{source.machine_label}</span>
                  <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                    {accounts.get(source.account_id) ?? source.account_id} · {source.mode} · {source.last_seen_at ? when(source.last_seen_at) : 'never seen'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <span>No collectors connected.</span>
          )}
        </TooltipContent>
      </Tooltip>
      <Badge variant={tone[status.state]} className="text-[10px]" title={status.label}>{status.state === 'none' ? 'not connected' : status.state}</Badge>
    </p>
  );
}
