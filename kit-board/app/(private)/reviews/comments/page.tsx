import { requireSession } from '@/lib/auth';
import { prWatchStore } from '@/lib/pr-watch-store';
import type { PrWatchList } from '@/lib/pr-watch-contract';
import { PageHeader } from '@/components/page-header';
import { PrWatchQueue } from '@/components/pr-watch-queue';
import { Workspace } from '@/components/workspace';

export default async function AddressComments() {
  await requireSession();
  let initial: PrWatchList | null = null;
  let initialError: string | undefined;
  try { initial = await prWatchStore.list('address'); }
  catch { initialError = 'The queue could not be loaded. It retries every minute.'; }

  return (
    <Workspace>
      <PageHeader
        eyebrow="Pull requests"
        title="Address comments"
        description="Watch one of your own pull requests, and have new review comments worked through and the fixes pushed."
      />
      <PrWatchQueue kind="address" initial={initial} initialError={initialError} />
    </Workspace>
  );
}
