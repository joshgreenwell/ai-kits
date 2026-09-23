import { redirect } from 'next/navigation';

// Standups now sit above the briefing for the same day; older links keep their revision.
export default async function Standup({ searchParams }: { searchParams: Promise<{ report?: string }> }) {
  const { report } = await searchParams;
  redirect(report ? `/tasks?report=${encodeURIComponent(report)}` : '/tasks');
}
