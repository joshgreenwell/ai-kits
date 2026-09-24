'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLinkIcon } from 'lucide-react';
import { Alert, AlertDescription } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Disclosure } from './kit/disclosure';
import { EmptyState } from './kit/empty-state';
import { Field } from './kit/field';
import { ListRow, ListRows } from './kit/list-row';
import { fetchPrivateJson } from '@/lib/fetch-private-json';
import type { PrWatch, PrWatchList } from '@/lib/pr-watch-contract';

/** A runner that has not asked for work in this long is not running; its schedule is every five minutes. */
const RUNNER_STALE_MS = 15 * 60_000;

const short = (sha: string | null) => sha?.slice(0, 7) ?? null;
function ago(value: string | null, now: number) {
  if (!value) return null;
  const minutes = Math.max(0, Math.round((now - Date.parse(value)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function WatchBadge({ watch }: { watch: PrWatch }) {
  if (watch.review_state === 'running') return <Badge variant="soft-info">reviewing</Badge>;
  if (watch.status === 'watching' && watch.review_requested_at) return <Badge variant="soft-warning">review requested</Badge>;
  if (watch.status === 'watching' && watch.review_state === 'failed') return <Badge variant="soft-destructive">review failed</Badge>;
  if (watch.status === 'watching') return <Badge variant="soft">{watch.last_checked_at ? 'watching' : 'waiting for first check'}</Badge>;
  if (watch.status === 'merged') return <Badge variant="secondary">merged</Badge>;
  return <Badge variant="outline">{watch.status}</Badge>;
}

function WatchRow({ watch, now, busy, onAction }: { watch: PrWatch; now: number; busy: boolean; onAction: (watch: PrWatch, action: 'stop' | 'review') => void }) {
  const live = watch.status === 'watching';
  const facts = [
    watch.author_login ? `by ${watch.author_login}` : null,
    watch.head_sha ? `head ${short(watch.head_sha)}` : null,
    watch.reviewed_sha ? `reviewed ${short(watch.reviewed_sha)}` : 'no AI review yet',
    `${watch.review_count} ${watch.review_count === 1 ? 'review' : 'reviews'} from the queue`,
    watch.last_checked_at ? `checked ${ago(watch.last_checked_at, now)}` : `added ${ago(watch.created_at, now)}`,
  ].filter(Boolean).join(' · ');
  return (
    <ListRow
      tone={live && watch.review_state === 'failed' ? 'destructive' : 'default'}
      title={
        <span className="grid gap-0.5">
          <a href={watch.url} target="_blank" rel="noreferrer" className="hover:text-primary inline-flex items-center gap-1.5 underline-offset-4 hover:underline">
            {watch.owner}/{watch.repo}#{watch.number}
            <ExternalLinkIcon aria-hidden className="text-muted-foreground size-3" />
          </a>
          {watch.title ? <span className="text-muted-foreground text-sm font-normal">{watch.title}</span> : null}
        </span>
      }
      detail={
        <span className="grid gap-1">
          <span>{facts}</span>
          {watch.last_error && (watch.review_state === 'failed' || live) ? <span className="text-destructive">{watch.last_error}</span> : null}
          {watch.last_note ? <span>{watch.last_note}</span> : null}
        </span>
      }
      aside={
        <>
          <WatchBadge watch={watch} />
          {watch.last_review_url ? (
            <Button asChild variant="ghost" size="xs">
              <a href={watch.last_review_url} target="_blank" rel="noreferrer">Last review</a>
            </Button>
          ) : null}
          {live ? (
            <>
              <Button
                variant="outline"
                size="xs"
                disabled={busy || watch.review_state === 'running' || Boolean(watch.review_requested_at)}
                onClick={() => onAction(watch, 'review')}
              >
                Review now
              </Button>
              <Button variant="outline" size="xs" disabled={busy} onClick={() => onAction(watch, 'stop')} aria-label={`Stop watching ${watch.owner}/${watch.repo}#${watch.number}`}>
                Stop
              </Button>
            </>
          ) : null}
        </>
      }
    />
  );
}

export function PrWatchQueue({ initial, initialError }: { initial: PrWatchList | null; initialError?: string }) {
  const [data, setData] = useState<PrWatchList | null>(initial);
  const [loadError, setLoadError] = useState(initialError ?? '');
  const [url, setUrl] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'destructive'; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [now, setNow] = useState(() => (initial ? Date.parse(initial.as_of) : 0));
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const next = await fetchPrivateJson<PrWatchList>('/api/pr-watches', signal);
      if (signal.aborted) return;
      setData(next); setLoadError(''); setNow(Date.now());
    } catch {
      if (!signal.aborted) setLoadError('The queue could not be loaded. It retries every minute; anything shown is from the last good read.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refreshRef.current = () => refresh(controller.signal);
    const tick = () => { if (!document.hidden) void refresh(controller.signal); };
    const timer = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [refresh]);

  async function send(path: string, method: 'POST' | 'PATCH', body: unknown) {
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'The request could not be completed. Please try again.');
    return payload;
  }

  async function watch(event: FormEvent) {
    event.preventDefault();
    setFieldError(''); setMessage(null);
    if (!url.trim()) { setFieldError('Paste a pull request link first.'); return; }
    setPending('add');
    try {
      const result = await send('/api/pr-watches', 'POST', { url: url.trim() });
      const w = result.watch as PrWatch;
      setUrl('');
      setMessage({ tone: 'success', text: result.duplicate
        ? `Already watching ${w.owner}/${w.repo}#${w.number}.`
        : `Watching ${w.owner}/${w.repo}#${w.number}. The runner takes its first look within five minutes.` });
      await refreshRef.current();
    } catch (error) {
      setFieldError(error instanceof Error ? error.message : 'The watch could not be added.');
    } finally { setPending(null); }
  }

  async function act(target: PrWatch, action: 'stop' | 'review') {
    setMessage(null); setPending(target.id);
    try {
      await send(`/api/pr-watches/${target.id}`, 'PATCH', { action });
      setMessage({ tone: 'success', text: action === 'stop'
        ? `Stopped watching ${target.owner}/${target.repo}#${target.number}.${target.review_state === 'running' ? ' The review already running will still post.' : ''}`
        : `A review of ${target.owner}/${target.repo}#${target.number} starts on the runner's next tick.` });
      await refreshRef.current();
    } catch (error) {
      setMessage({ tone: 'destructive', text: error instanceof Error ? error.message : 'That did not work. Please try again.' });
    } finally { setPending(null); }
  }

  const live = data?.watches.filter(w => w.status === 'watching' || w.review_state === 'running') ?? [];
  const ended = data?.watches.filter(w => !(w.status === 'watching' || w.review_state === 'running')) ?? [];
  const runner = data?.runners[0] ?? null;
  const runnerFresh = runner && now - Date.parse(runner.last_seen_at) < RUNNER_STALE_MS;

  return (
    <div className="grid gap-6">
      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-base">Watch a pull request</CardTitle>
          <CardDescription>
            Every five minutes this Mac checks each watched PR. When its author pushes commits that change the diff,
            a background Claude session (Opus 5.5, medium effort) runs the AI PR review skill again and posts a follow-up
            review that starts from what changed. Rebases and merges from the base that leave the diff alone do not count.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          <form onSubmit={watch} className="flex flex-wrap items-start gap-3">
            <Field label="Pull request link" htmlFor="pr-watch-url" error={fieldError || undefined} className="min-w-[260px] flex-1">
              <Input
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://github.com/owner/repo/pull/123"
                value={url}
                onChange={event => setUrl(event.target.value)}
              />
            </Field>
            <Button type="submit" className="mt-[22px]" disabled={pending === 'add'}>
              {pending === 'add' ? 'Adding…' : 'Watch'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {message ? (
        <Alert variant={message.tone} aria-live="polite">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      {loadError ? (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{loadError}</p>
            <Button variant="outline" size="xs" onClick={() => void refreshRef.current()}>Retry now</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="grid gap-3" aria-labelledby="pr-watch-queue-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="pr-watch-queue-heading" className="text-base font-semibold">Queue</h2>
          {data ? (
            runner ? (
              <Badge variant={runnerFresh ? 'soft' : 'soft-destructive'}>
                {runnerFresh ? 'runner' : 'runner not running'} · last seen {ago(runner.last_seen_at, now)}{runner.machine_label ? ` on ${runner.machine_label}` : ''}
              </Badge>
            ) : (
              <Badge variant="outline">runner never seen</Badge>
            )
          ) : null}
        </div>
        {data && !runnerFresh && live.length ? (
          <Alert variant="warning">
            <AlertDescription>
              <p>Nothing is polling these watches. Start the runner on the Mac that holds your GitHub login and the review skill:</p>
              <code className="font-mono text-xs">node scripts/pr-watch.mjs install</code>
            </AlertDescription>
          </Alert>
        ) : null}
        {live.length ? (
          <ListRows>
            {live.map(w => <WatchRow key={w.id} watch={w} now={now} busy={pending === w.id} onAction={act} />)}
          </ListRows>
        ) : data ? (
          <EmptyState title="No pull requests are being watched" description="Paste a PR link above. Watching starts from the last AI review on the PR, or from its current head if it has none." />
        ) : null}
        {ended.length ? (
          <Disclosure title={`Ended watches (${ended.length})`}>
            <ListRows>
              {ended.map(w => <WatchRow key={w.id} watch={w} now={now} busy={false} onAction={act} />)}
            </ListRows>
          </Disclosure>
        ) : null}
      </section>
    </div>
  );
}
