import { notFound } from 'next/navigation';
import { sections } from '@/lib/catalog';
import { reportById, reportHistory } from '@/lib/db';
import { ReportView } from '@/components/report-view';
import { requireSession } from '@/lib/auth';
import { defaultReport } from '@/lib/report-selection';
export default async function Section({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<{ report?: string }> }) {
  await requireSession();
  const { section: name } = await params;
  const section = sections.find(item => item.kind === name && name !== 'usage');
  if (!section) notFound();
  const history = await reportHistory(section.kind);
  const requested = (await searchParams).report;
  const id = requested ?? defaultReport(section.kind, history)?.id;
  const report = id ? await reportById(id) : undefined;
  if (report && report.kind !== section.kind) notFound();
  if (requested && !report) notFound();
  // HTML stays on the authenticated artifact route; do not duplicate it into RSC payloads.
  return <ReportView title={section.title} empty={section.empty} history={history} report={report ? { ...report, payload: { markdown: report.payload.markdown }, html: report.html ? 'available' : undefined } : undefined}/>;
}
