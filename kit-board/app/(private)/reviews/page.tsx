import { requireSession } from '@/lib/auth';
import { prWatchStore } from '@/lib/pr-watch-store';
import type { PrWatchList } from '@/lib/pr-watch-contract';
import { PageHeader } from '@/components/page-header';
import { PrWatchQueue } from '@/components/pr-watch-queue';
import { Workspace } from '@/components/workspace';

export default async function Reviews() {
  await requireSession();
  let initial: PrWatchList | null = null;
  let initialError: string | undefined;
  try { initial = await prWatchStore.list(); }
  catch { initialError = 'The queue could not be loaded. It retries every minute.'; }

  return (
    <Workspace>
      <PageHeader
        eyebrow="Pull requests"
        title="PR watch"
        description="Watch a pull request and get a follow-up AI review each time its author pushes new changes."
      />
      <PrWatchQueue initial={initial} initialError={initialError} />
    </Workspace>
  );
}
