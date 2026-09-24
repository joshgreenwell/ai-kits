'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Workspace } from '@/components/workspace';
import { AllowancesOverview } from '@/components/allowances-overview';
import { useLiveData } from '@/components/telemetry-shared';
import { fetchPrivateJson } from '@/lib/fetch-private-json';
import type { InstallsSummary } from '@/lib/usage-store';
import { defaultCollectionSettings, type CollectionSettings } from '@/lib/companion-settings';

const INSTALLS_TTL = 5 * 60_000;

function AllowancesInner() {
  const { data, error, now, retry } = useLiveData();
  const [installs, setInstalls] = useState<InstallsSummary['installs'] | null>(null);
  const [settings, setSettings] = useState<CollectionSettings>(defaultCollectionSettings);
  const installsAt = useRef(0);
  // Identity alerts follow the live refresh: a failed fetch is retried on the next refresh, a good one is kept for a while.
  useEffect(() => {
    if (!data || Date.now() - installsAt.current < INSTALLS_TTL) return;
    const controller = new AbortController();
    fetchPrivateJson<InstallsSummary>('/api/usage-v2', controller.signal)
      .then(summary => {
        if (!controller.signal.aborted) {
          installsAt.current = Date.now();
          setInstalls(summary.installs);
          setSettings(summary.settings);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [data]);
  return <AllowancesOverview data={data} error={error} now={now} onRetry={retry} installs={installs} settings={settings} />;
}

/** The Allowances subtab: one expandable card per account (USG-023), then model history. */
export default function Allowances() {
  return <Suspense fallback={<Workspace width="dashboard"><p className="text-muted-foreground text-sm">Loading allowances…</p></Workspace>}><AllowancesInner /></Suspense>;
}
