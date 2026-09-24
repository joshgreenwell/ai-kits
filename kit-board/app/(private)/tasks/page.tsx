import { notFound } from 'next/navigation';
import { sections } from '@/lib/catalog';
import type { StoredReport } from '@/lib/contracts';
import { reportById, reportHistory } from '@/lib/db';
import { DailyTasksView } from '@/components/daily-tasks-view';
import { requireSession } from '@/lib/auth';
import { dailySelection } from '@/lib/daily-tasks';
import { parseBriefing } from '@/lib/daily-briefing';

// HTML stays on the authenticated artifact route; do not duplicate it into RSC payloads.
const withoutHtml = (report?: StoredReport) =>
  report ? { ...report, payload: { markdown: report.payload.markdown }, html: report.html ? 'available' : undefined } : undefined;

export default async function DailyTasks({ searchParams }: { searchParams: Promise<{ day?: string; report?: string }> }) {
  await requireSession();
  const section = sections.find(item => item.kind === 'tasks')!;
  const request = await searchParams;
  const [briefings, standups] = await Promise.all([reportHistory('tasks'), reportHistory('standup')]);
  const selection = dailySelection(briefings, standups, request);
  if (request.report && selection.briefing?.id !== request.report && selection.standup?.id !== request.report) notFound();
  if (request.day && !selection.days.some(item => item.day === request.day)) notFound();
  const [briefing, standup] = await Promise.all([
    selection.briefing ? reportById(selection.briefing.id) : undefined,
    selection.standup ? reportById(selection.standup.id) : undefined,
  ]);
  // The structured payload is read here, so only the fields the view draws reach the client.
  return <DailyTasksView title={section.title} empty={section.empty} days={selection.days} day={selection.day} briefing={withoutHtml(briefing)} standup={withoutHtml(standup)}
    structured={briefing ? parseBriefing(briefing.payload) : null}/>;
}
