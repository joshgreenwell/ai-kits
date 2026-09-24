'use client';
import * as React from 'react';
import { CheckIcon, ExternalLinkIcon, MinusIcon, SignalHighIcon, SignalLowIcon, SignalMediumIcon } from 'lucide-react';
import { cn } from 'cn';
import type { StoredReport } from '@/lib/contracts';
import { parseReadings, type ReadingBullet, type ReadingItem, type ReadingPoint, type ReadingSection, type Readings } from '@/lib/readings';
import { ReportFrame } from './report-frame';
import { PageHeader } from './page-header';
import { Workspace } from './workspace';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { CopyButton, Disclosure, EmptyState, InlineMarkdown, StatusBadge } from './kit';
import { SectionNav } from './kit/section-nav';
import { ReportBody, ReportHistory, ReportStatus, markdownOf, reportDate, statusLabel } from './report-view';

type BadgeVariant = React.ComponentProps<typeof Badge>['variant'];

const label = 'text-muted-foreground text-[10px] font-semibold tracking-wider uppercase';
const mono = 'text-muted-foreground font-mono text-[11px]';

// The period key is a calendar date, so it is formatted in UTC to keep the day the producer meant.
function periodLabel(report: StoredReport) {
  const key = report.period_key;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(key);
  const parsed = new Date(`${day ? key : `${key}-01`}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return key;
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric', ...(day ? { day: 'numeric' } : {}) });
}

const plural = (count: number, noun: string, many = `${noun}s`) => `${count} ${count === 1 ? noun : many}`;

// A tag reads by its first recognisable segment: "AI/Security" is an AI story, "Crypto/Research" a crypto one.
function tagVariant(tag: string): BadgeVariant {
  for (const segment of tag.toLowerCase().split(/[/,]/)) {
    if (/secur|crypt|vuln|privacy|cs\.cr|exploit/.test(segment)) return 'soft-warning';
    if (/research|paper|preprint|peer.reviewed|arxiv|cs\.|eval|benchmark/.test(segment)) return 'soft-info';
    if (/\bai\b|\bml\b|llm|model|agent/.test(segment)) return 'soft';
  }
  return 'outline';
}

const EVIDENCE = {
  strong: { variant: 'soft', icon: SignalHighIcon },
  medium: { variant: 'outline', icon: SignalMediumIcon },
  weak: { variant: 'soft-warning', icon: SignalLowIcon },
} as const;

// "Strong evidence (official, confirmed)" shows its head in the badge and keeps the qualifier as a point.
function evidenceParts(item: ReadingItem) {
  const raw = item.evidenceLabel?.trim() ?? '';
  const cut = raw.search(/\s[(/]/);
  const head = (cut > 0 ? raw.slice(0, cut) : raw).trim();
  return { head: head || null, qualified: cut > 0 };
}

function hostOf(href: string) {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
}

// The producer title-cases its standard headings ("Worth Looking At"); the site writes headings in sentence
// case. Only plain capitalised words are lowered, so "Crypto/Security Lane" and "Hacker News / …" keep theirs.
function displayTitle(section: ReadingSection) {
  if (section.kind === 'other') return section.title;
  const words = section.title.split(' ');
  if (words.length < 2 || !words.every(word => /^[A-Z][a-z]+$|^(?:as|or|at|of|and|the|a|to|for|in|on)$/i.test(word))) return section.title;
  return [words[0], ...words.slice(1).map(word => word.toLowerCase())].join(' ');
}

function navLabel(section: ReadingSection) {
  switch (section.kind) {
    case 'snapshot': return 'Snapshot';
    case 'worth': return 'Worth looking at';
    case 'watchlist': return 'Watchlist';
    case 'skipped': return 'Skipped';
    case 'actions': return 'Actions';
    case 'lane': {
      const name = displayTitle(section).replace(/\s+lane$/i, '');
      return name.length > 18 ? name.split(' / ')[0] : name;
    }
    default: return section.title;
  }
}

function countOf(section: ReadingSection) {
  return section.items.length || section.bullets.length || section.paragraphs.length;
}

function SectionHeading({ section, noun, many }: { section: ReadingSection; noun: string; many?: string }) {
  const count = countOf(section);
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`${section.id}-heading`} className="text-lg font-semibold tracking-tight">
          <InlineMarkdown text={displayTitle(section)} />
        </h2>
        <span className={mono}>{plural(count, noun, many)}</span>
      </div>
      {section.items.length > 0 && section.paragraphs.map((paragraph, index) => (
        <p key={index} className="text-muted-foreground max-w-[72ch] text-sm leading-relaxed">
          <InlineMarkdown text={paragraph} />
        </p>
      ))}
    </div>
  );
}

function Children({ entries, className }: { entries: string[]; className?: string }) {
  if (!entries.length) return null;
  return (
    // base.css resets list padding and margin unlayered, so the indent lives on a wrapper.
    <div className={cn('border-border mt-2 border-l pl-4', className)}>
      <ul className="grid gap-1.5">
        {entries.map((entry, index) => (
          <li key={index} className="text-muted-foreground text-sm leading-relaxed">
            <InlineMarkdown text={entry} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="grid max-w-[75ch] grid-cols-[0.75rem_1fr] gap-2 text-sm leading-relaxed">
      <span aria-hidden className="bg-muted-foreground/60 mt-[0.6em] size-1 rounded-full" />
      <div className="min-w-0">{children}</div>
    </li>
  );
}

// Labeled points read as a definition list; unlabeled runs stay bullets, in the order they were written.
function Points({ points, stacked }: { points: ReadingPoint[]; stacked?: boolean }) {
  const runs: { labeled: boolean; points: ReadingPoint[] }[] = [];
  for (const point of points) {
    const labeled = !!point.label;
    const last = runs.at(-1);
    if (last && last.labeled === labeled) last.points.push(point);
    else runs.push({ labeled, points: [point] });
  }
  return (
    <div className="grid gap-4">
      {runs.map((run, index) =>
        run.labeled ? (
          <dl key={index} className="grid gap-3">
            {run.points.map((point, pointIndex) => (
              <div key={pointIndex} className={cn('grid gap-1', !stacked && 'md:grid-cols-[10rem_1fr] md:gap-6')}>
                <dt className={cn(label, !stacked && 'md:pt-[0.3rem]')}>
                  <InlineMarkdown text={point.label ?? ''} />
                </dt>
                <dd className="min-w-0 max-w-[75ch] text-sm leading-relaxed">
                  <InlineMarkdown text={point.text} />
                  <Children entries={point.children} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <ul key={index} className="grid gap-2">
            {run.points.map((point, pointIndex) => (
              <Bullet key={pointIndex}>
                <InlineMarkdown text={point.text} />
                <Children entries={point.children} />
              </Bullet>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

function ItemCard({ item, compact }: { item: ReadingItem; compact?: boolean }) {
  const evidence = evidenceParts(item);
  const tone = item.evidence ? EVIDENCE[item.evidence] : null;
  const Icon = tone?.icon;
  const extra = item.links.slice(1);
  const points = evidence.qualified && item.evidenceLabel
    ? [...item.points, { label: 'Evidence', text: item.evidenceLabel, children: [] }]
    : item.points;
  const notes = item.notes.map((note, index) => (
    <p key={index} className="text-muted-foreground max-w-[75ch] text-sm leading-relaxed">
      <InlineMarkdown text={note} />
    </p>
  ));
  // A lane card stays short: its points, and the remarks written under them, open on demand.
  const body = compact && points.length ? (
    <Disclosure title={`Key points · ${points.length}`} contentClassName="grid gap-4">
      <Points points={points} stacked />
      {notes}
    </Disclosure>
  ) : (
    <>
      {points.length > 0 && <Points points={points} stacked={compact} />}
      {notes}
    </>
  );
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <article className="grid">
        <header className={cn('grid gap-2', compact ? 'px-4 pt-4' : 'px-5 pt-5')}>
          {(item.tag || evidence.head) && (
            <div className="flex flex-wrap items-center gap-2">
              {item.tag && <Badge variant={tagVariant(item.tag)} className="font-mono text-[10.5px]">{item.tag}</Badge>}
              {evidence.head && (
                <Badge variant={tone?.variant ?? 'outline'} title={item.evidenceLabel ?? undefined}>
                  {Icon && <Icon aria-hidden />}
                  {evidence.head}
                </Badge>
              )}
            </div>
          )}
          <h3 className={cn('font-semibold leading-snug tracking-tight', compact ? 'text-[15px]' : 'text-base')}>
            <InlineMarkdown text={item.title} />
          </h3>
          {item.source && <p className={mono}><InlineMarkdown text={item.source} /></p>}
        </header>
        <div className={cn('grid gap-4', compact ? 'p-4' : 'p-5')}>
          {item.summary && (
            <p className="max-w-[75ch] text-sm leading-relaxed">
              <InlineMarkdown text={item.summary} />
            </p>
          )}
          {body}
        </div>
        {item.link && (
          <footer className={cn('border-border text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 border-t py-3', compact ? 'px-4' : 'px-5')}>
            <a href={item.link} target="_blank" rel="noreferrer noopener" className="text-primary! inline-flex items-center gap-1.5 text-sm font-semibold underline-offset-4 hover:underline!">
              Open source
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <span className={mono}>{hostOf(item.link)}</span>
            {extra.map(link => (
              <a key={link.href} href={link.href} target="_blank" rel="noreferrer noopener" className="hover:text-foreground! text-xs underline! decoration-current/30! underline-offset-4">
                {/^https?:/.test(link.label) ? hostOf(link.href) : link.label}
              </a>
            ))}
          </footer>
        )}
      </article>
    </Card>
  );
}

function BulletText({ bullet }: { bullet: ReadingBullet }) {
  return (
    <>
      {bullet.lead && (
        <strong className="text-foreground font-semibold">
          <InlineMarkdown text={bullet.lead} />
          {bullet.text ? ' ' : ''}
        </strong>
      )}
      {bullet.text && <InlineMarkdown text={bullet.text} />}
    </>
  );
}

function Snapshot({ section }: { section: ReadingSection }) {
  const entries = section.bullets;
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-4">
        <h2 id={`${section.id}-heading`} className="text-lg font-semibold tracking-tight"><InlineMarkdown text={displayTitle(section)} /></h2>
        <span className={mono}>{plural(entries.length, 'point')}</span>
      </div>
      {entries.length === 1 ? (
        <div className="px-5 py-5">
          <p className="max-w-[75ch] text-[15px] leading-relaxed"><InlineMarkdown text={entries[0].text} /></p>
          <Children entries={entries[0].children} />
        </div>
      ) : (
        <ol className="grid">
          {entries.map((entry, index) => (
            <li key={index} className="border-border grid grid-cols-[1.75rem_1fr] gap-3 border-t px-5 py-4 first:border-t-0">
              <span aria-hidden className="text-primary pt-[0.2rem] font-mono text-xs font-medium">
                {String(index + 1).padStart(2, '0')}
              </span>
              <div className="min-w-0">
                <p className="max-w-[75ch] text-[15px] leading-relaxed"><InlineMarkdown text={entry.text} /></p>
                <Children entries={entry.children} />
              </div>
            </li>
          ))}
        </ol>
      )}
      {section.paragraphs.length > 0 && entries.length > 0 && (
        <div className="border-border grid gap-2 border-t px-5 py-4">
          {section.paragraphs.map((paragraph, index) => (
            <p key={index} className="text-muted-foreground text-sm leading-relaxed"><InlineMarkdown text={paragraph} /></p>
          ))}
        </div>
      )}
    </Card>
  );
}

function Actions({ section }: { section: ReadingSection }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-4">
        <h2 id={`${section.id}-heading`} className="text-base font-semibold tracking-tight"><InlineMarkdown text={displayTitle(section)} /></h2>
        <span className={mono}>{plural(section.bullets.length, 'action')}</span>
      </div>
      <div className="p-4">
        <ul className="grid gap-3">
          {section.bullets.map((bullet, index) => (
            <li key={index} className="grid grid-cols-[1rem_1fr] gap-2.5 text-sm leading-relaxed">
              {/* A marker, not a checkbox: nothing here records that an action was done. */}
              <span aria-hidden className="bg-primary mt-[0.7em] h-0.5 w-2.5 rounded-full" />
              <div className="min-w-0">
                {bullet.lead ? (
                  <>
                    <p className="font-semibold"><InlineMarkdown text={bullet.lead} /></p>
                    {bullet.text && <p className="text-muted-foreground"><InlineMarkdown text={bullet.text} /></p>}
                  </>
                ) : (
                  <p><InlineMarkdown text={bullet.text} /></p>
                )}
                <Children entries={bullet.children} />
              </div>
            </li>
          ))}
          {section.paragraphs.map((paragraph, index) => (
            <li key={`p${index}`} className="text-muted-foreground text-sm leading-relaxed"><InlineMarkdown text={paragraph} /></li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function Watchlist({ section }: { section: ReadingSection }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <ul className="grid">
        {section.bullets.map((bullet, index) => (
          <li key={index} className="border-border grid gap-1 border-t px-5 py-4 first:border-t-0">
            {/* The lead and its tail are one sentence ("X said Y, per a filing (Source)."), so they share a line. */}
            <p className="max-w-[75ch] text-sm leading-relaxed">
              {bullet.lead && <strong className="font-semibold"><InlineMarkdown text={bullet.lead} /></strong>}
              {bullet.lead && bullet.text ? ' ' : ''}
              {bullet.text && <span className={cn(bullet.lead && 'text-muted-foreground')}><InlineMarkdown text={bullet.text} /></span>}
            </p>
            {bullet.note && (
              <p className="text-muted-foreground max-w-[75ch] text-xs leading-relaxed">
                <span className={cn(label, 'mr-2')}>On watch</span>
                <InlineMarkdown text={bullet.note} />
              </p>
            )}
            <Children entries={bullet.children} />
          </li>
        ))}
        {section.paragraphs.map((paragraph, index) => (
          <li key={`p${index}`} className="border-border text-muted-foreground border-t px-5 py-4 text-sm leading-relaxed first:border-t-0">
            <InlineMarkdown text={paragraph} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Skipped({ section }: { section: ReadingSection }) {
  return (
    <Disclosure title={`Show ${plural(section.bullets.length + section.paragraphs.length, 'skipped item')}`}>
      <ul className="text-muted-foreground grid gap-2">
        {section.bullets.map((bullet, index) => (
          <Bullet key={index}>
            <span className="text-muted-foreground"><BulletText bullet={bullet} /></span>
            <Children entries={bullet.children} />
          </Bullet>
        ))}
        {section.paragraphs.map((paragraph, index) => (
          <Bullet key={`p${index}`}><InlineMarkdown text={paragraph} /></Bullet>
        ))}
      </ul>
    </Disclosure>
  );
}

function Plain({ section }: { section: ReadingSection }) {
  return (
    <Card className="gap-0 py-0">
      <div className="grid gap-3 p-5">
        {section.bullets.length > 0 && (
          <ul className="grid gap-2">
            {section.bullets.map((bullet, index) => (
              <Bullet key={index}>
                <BulletText bullet={bullet} />
                {bullet.note && <span className="text-muted-foreground"> On watch: <InlineMarkdown text={bullet.note} /></span>}
                <Children entries={bullet.children} />
              </Bullet>
            ))}
          </ul>
        )}
        {section.paragraphs.map((paragraph, index) => (
          <p key={index} className="max-w-[75ch] text-sm leading-relaxed"><InlineMarkdown text={paragraph} /></p>
        ))}
      </div>
    </Card>
  );
}

function Section({ section }: { section: ReadingSection }) {
  const items = section.items.length > 0;
  const entries = !items && section.kind !== 'watchlist' && section.kind !== 'skipped';
  return (
    <section id={section.id} aria-labelledby={`${section.id}-heading`} className="grid min-w-0 scroll-mt-[var(--readings-jump,7rem)] gap-4">
      <SectionHeading section={section} noun={entries ? 'entry' : 'item'} many={entries ? 'entries' : 'items'} />
      {items ? (
        <div className={cn('grid gap-4', section.kind === 'lane' && 'items-start md:grid-cols-2')}>
          {section.items.map((item, index) => <ItemCard key={index} item={item} compact={section.kind === 'lane'} />)}
          {section.bullets.length > 0 && (
            <ul className={cn('grid gap-2', section.kind === 'lane' && 'md:col-span-2')}>
              {section.bullets.map((bullet, index) => <Bullet key={index}><BulletText bullet={bullet} /></Bullet>)}
            </ul>
          )}
        </div>
      ) : section.kind === 'watchlist' ? (
        <Watchlist section={section} />
      ) : section.kind === 'skipped' ? (
        <Skipped section={section} />
      ) : (
        <Plain section={section} />
      )}
    </section>
  );
}

function MetaRow({ report, readings, markdown }: { report: StoredReport; readings: Readings; markdown: string }) {
  const coverage = readings.meta.find(entry => /^coverage/i.test(entry.label));
  const checks = readings.meta.filter(entry => /checked$/i.test(entry.label));
  const rest = readings.meta.filter(entry => entry !== coverage && !checks.includes(entry));
  return (
    <div className="border-border flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border px-4 py-3">
      <div className="flex min-w-0 flex-[1_1_20rem] flex-wrap items-center gap-x-4 gap-y-2">
        <StatusBadge status={report.status === 'failed' ? 'failed' : report.status === 'partial' ? 'incomplete' : 'validated'}>
          {statusLabel(report.status)}
        </StatusBadge>
        {checks.map(entry => {
          const yes = /^yes\b/i.test(entry.value.trim());
          return (
            <Badge key={entry.label} variant={yes ? 'soft' : 'soft-warning'} title={`${entry.label}: ${entry.value}`}>
              {yes ? <CheckIcon aria-hidden /> : <MinusIcon aria-hidden />}
              {entry.label.replace(/\s+checked$/i, '')} {yes ? 'checked' : entry.value}
            </Badge>
          );
        })}
        <span className={mono}>Observed {reportDate(report.produced_at)}</span>
        {coverage && <span className={mono}>Coverage {coverage.value}</span>}
        {rest.map(entry => (
          <span key={entry.label} className={mono}>{entry.label} {entry.value}</span>
        ))}
      </div>
      {markdown && <CopyButton value={markdown} label="Copy markdown" copiedLabel="Copied markdown" variant="outline" />}
    </div>
  );
}

// The authored HTML stays on its sandboxed artifact route; the frame mounts only once someone asks for it.
function OriginalLayout({ report }: { report: StoredReport }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Disclosure title="Original report layout" open={open} onOpenChange={setOpen}>
      {open && <ReportFrame id={report.id} title={report.title} />}
    </Disclosure>
  );
}

// Jump targets must clear the sticky app header and the section nav. The header wraps to three rows on a
// phone, so a fixed scroll margin that suits a desktop hides the heading there; the offset is measured.
function useJumpOffset(active: boolean) {
  React.useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const header = document.querySelector('[data-app-header]');
    const nav = document.querySelector('nav[aria-label="Readings sections"]');
    const measure = () => {
      const height = (header?.getBoundingClientRect().height ?? 0) + (nav?.getBoundingClientRect().height ?? 0);
      root.style.setProperty('--readings-jump', `${Math.ceil(height) + 16}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (header) observer.observe(header);
    if (nav) observer.observe(nav);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--readings-jump');
    };
  }, [active]);
}

export function ReadingsView({ title, empty, history, report }: { title: string; empty: string; history: StoredReport[]; report?: StoredReport }) {
  const markdown = report ? markdownOf(report) : '';
  const readings = React.useMemo(() => parseReadings(markdown), [markdown]);
  const { snapshot, actions, body, jumps } = React.useMemo(() => {
    const snapshot = readings.sections.find(section => section.kind === 'snapshot' && section.bullets.length > 0);
    const actions = readings.sections.find(section => section.kind === 'actions' && countOf(section) > 0);
    const body = readings.sections.filter(section => section !== snapshot && section !== actions && countOf(section) > 0);
    // The nav follows the page order: the snapshot and actions sit together at the top whatever the markdown's order.
    const jumps = [snapshot, actions, ...body].flatMap(section => section ? [{ anchor: section.id, label: `${navLabel(section)} · ${countOf(section)}` }] : []);
    return { snapshot, actions, body, jumps };
  }, [readings]);
  const recognized = !!report && readings.recognized;
  useJumpOffset(recognized && jumps.length > 1);

  return (
    // overflow-wrap: a long identifier in a report (an env var, a URL) wraps instead of widening a card.
    <Workspace className="[overflow-wrap:anywhere]">
      <PageHeader
        eyebrow={report ? `Daily technology intelligence · ${periodLabel(report)}` : 'Daily technology intelligence'}
        title={title}
        description={recognized && readings.overall ? <InlineMarkdown text={readings.overall} /> : undefined}
        actions={!!history.length && <ReportHistory history={history} report={report} />}
      />

      {!report ? (
        <EmptyState title="No published reports yet" description={empty} />
      ) : !recognized ? (
        <>
          <ReportStatus report={report} />
          <ReportBody report={report} />
        </>
      ) : (
        <>
          <MetaRow report={report} readings={readings} markdown={markdown} />
          {jumps.length > 1 && <SectionNav label="Readings sections" jumps={jumps} />}

          {(snapshot || actions) && (
            <div className={cn('grid items-start gap-4', snapshot && actions && 'lg:grid-cols-3')}>
              {snapshot && (
                <section id={snapshot.id} aria-labelledby={`${snapshot.id}-heading`} className={cn('min-w-0 scroll-mt-[var(--readings-jump,7rem)]', actions && 'lg:col-span-2')}>
                  <Snapshot section={snapshot} />
                </section>
              )}
              {actions && (
                <section id={actions.id} aria-labelledby={`${actions.id}-heading`} className="min-w-0 scroll-mt-[var(--readings-jump,7rem)]">
                  <Actions section={actions} />
                </section>
              )}
            </div>
          )}

          {body.map(section => <Section key={section.id} section={section} />)}

          {report.html && (
            <div className="border-border border-t pt-4">
              <OriginalLayout key={report.id} report={report} />
            </div>
          )}
        </>
      )}
    </Workspace>
  );
}
