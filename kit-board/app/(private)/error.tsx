'use client';
import { Button } from '@/components/ui/button';
import { Workspace } from '@/components/workspace';
import { EmptyState } from '@/components/kit';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <Workspace>
      <EmptyState
        title="Reports are temporarily unavailable"
        description="Your history is preserved. Try loading it again."
        actions={<Button onClick={reset}>Try again</Button>}
      />
    </Workspace>
  );
}
