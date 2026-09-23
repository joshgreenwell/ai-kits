'use client';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, EmptyState, Stat, StatGroup, type Column } from '@/components/kit';
import { useRegistry } from '@/components/registry';
import { when } from '@/components/telemetry-shared';
import { exactTokens } from '@/lib/usage-view';

type ProjectStat = { id: string; name: string; apps: string[]; machines: string[]; folders: number; sessions: number; requests: number; last_seen: string | null };
export type ProjectStats = {
  projects: ProjectStat[]; removed: ProjectStat[];
  not_in_project: Record<'projectless' | 'outside_roots' | 'no_folder' | 'no_project' | 'missing_project' | 'not_reported' | 'unknown', number>;
  as_of: string;
};

const APP_LABELS: Record<string, string> = { codex_desktop: 'Codex app', claude_desktop: 'Claude app', cursor: 'Cursor' };
/** The "Not in a project" buckets, in reading order, with what each one means. */
export const NOT_IN_PROJECT: { key: keyof ProjectStats['not_in_project']; label: string; help: string }[] = [
  { key: 'projectless', label: 'Chats with no project', help: 'conversations the app itself keeps outside every project' },
  { key: 'outside_roots', label: 'Outside every project root', help: 'a folder no app project contains' },
  { key: 'no_folder', label: 'No workspace folder', help: 'a Cursor conversation opened without a folder' },
  { key: 'no_project', label: 'No working directory', help: 'the request recorded that it ran in no folder' },
  { key: 'missing_project', label: 'Project not in the catalog', help: 'placed in an app project this site has not received yet' },
  { key: 'not_reported', label: 'Machine not upgraded', help: 'its companion predates 2.2.0 and reports no projects' },
  { key: 'unknown', label: 'Unknown', help: 'no folder or session evidence the companion could place' },
];

/**
 * Settings > Projects, read-only. Projects are the groups the owner creates in an app (today the Codex
 * app); the companion reports them with the folders and sessions that belong to each, and nothing here
 * creates, renames, or maps anything. Counts come from `GET /api/usage-projects/stats`.
 */
export function ProjectRegistry() {
  const { data, error, refresh } = useRegistry<ProjectStats>('/api/usage-projects/stats', 'The project list is temporarily unavailable.');
  const columns: Column<ProjectStat>[] = [
    { id: 'project', header: 'Project', sortValue: row => row.name, cell: row => <span className="text-xs font-medium">{row.name}</span> },
    { id: 'apps', header: 'Apps', sortValue: row => row.apps.join(','), cell: row => <span className="flex flex-wrap gap-1">{row.apps.map(app => <Badge key={app} variant="outline">{APP_LABELS[app] ?? app}</Badge>)}</span> },
    { id: 'machines', header: 'Machines', sortValue: row => row.machines.join(','), cell: row => <span className="text-xs">{row.machines.join(', ') || '—'}</span> },
    { id: 'folders', header: 'Folders', numeric: true, sortValue: row => row.folders, cell: row => exactTokens(row.folders) },
    { id: 'sessions', header: 'Sessions', numeric: true, sortValue: row => row.sessions, cell: row => exactTokens(row.sessions) },
    { id: 'requests', header: 'Requests', numeric: true, sortValue: row => row.requests, cell: row => exactTokens(row.requests) },
    { id: 'last', header: 'Last seen', sortValue: row => row.last_seen ?? '', cell: row => <span className="font-mono text-[11px]">{when(row.last_seen)}</span> },
  ];
  const outside = data ? NOT_IN_PROJECT.reduce((n, bucket) => n + data.not_in_project[bucket.key], 0) : 0;
  const inside = data ? data.projects.reduce((n, row) => n + row.requests, 0) + data.removed.reduce((n, row) => n + row.requests, 0) : 0;
  return (
    <div className="grid gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Projects are temporarily unavailable</AlertTitle>
          <AlertDescription><p>{error}</p><Button variant="outline" size="sm" className="mt-2" onClick={() => void refresh()}>Retry loading</Button></AlertDescription>
        </Alert>
      )}
      {!data ? (
        !error && <p className="text-muted-foreground text-sm" role="status">Loading projects…</p>
      ) : (
        <>
          <Card className="gap-0 overflow-hidden py-0">
            <StatGroup>
              <Stat label="App projects" value={String(data.projects.length)} caption={`${data.removed.length} removed in the app, kept with their history`} />
              <Stat label="Requests in a project" value={exactTokens(inside)} caption="all time, across every machine" />
              <Stat label="Not in a project" value={exactTokens(outside)} caption="by reason below" />
            </StatGroup>
          </Card>
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="p-4">
              <CardTitle className="text-base">Projects</CardTitle>
              <CardDescription>The projects you created in your apps. Folders inside a project&apos;s roots, including worktrees, belong to it on every machine; a project with the same name in two places is one project.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 p-4">
              <DataTable columns={columns} rows={data.projects} getRowId={row => row.id} defaultSort={{ id: 'requests', dir: 'desc' }} className="max-h-96 overflow-auto"
                empty={(
                  <EmptyState
                    title="No app projects reported yet"
                    description="Projects arrive once a companion at 2.2.0 or later runs with hashed project attribution on. Create projects in the Codex app; the companion reads them and places each folder and conversation."
                    actions={<Button size="sm" variant="outline" asChild><Link href="/settings/collection">Open collection settings</Link></Button>}
                  />
                )} />
              {data.removed.length ? (
                <div className="grid gap-2" data-testid="removed-projects">
                  <h3 className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Removed in the app</h3>
                  <DataTable columns={columns} rows={data.removed} getRowId={row => row.id} defaultSort={{ id: 'requests', dir: 'desc' }} className="max-h-60 overflow-auto" />
                </div>
              ) : null}
            </CardContent>
          </Card>
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="p-4">
              <CardTitle className="text-base">Not in a project</CardTitle>
              <CardDescription>All-time requests that no app project contains, by reason.</CardDescription>
            </CardHeader>
            <CardContent className="p-4">
              <dl className="grid gap-y-1.5" data-testid="not-in-project">
                {NOT_IN_PROJECT.map(bucket => (
                  <div key={bucket.key} className="flex items-baseline gap-3">
                    <dt className="flex min-w-0 flex-1 items-baseline gap-2 text-xs"><span>{bucket.label}</span> <span className="text-muted-foreground truncate">{bucket.help}</span></dt>
                    <dd className="shrink-0 font-mono text-xs tabular-nums">{exactTokens(data.not_in_project[bucket.key])}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Nothing here is edited by hand: rename or remove a project in its app and the next companion run carries the change. Only hashes and the names you gave your projects leave a machine; folder paths never do. Run <span className="font-mono">observatory projects --apps</span> on a machine to see its counts.
          </p>
        </>
      )}
    </div>
  );
}
