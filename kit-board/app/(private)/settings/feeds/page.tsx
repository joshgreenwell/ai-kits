import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { ResetFeedHealth } from '@/components/reset-feed-health';

export default function ResetFeeds() {
  return (
    <Workspace>
      <PageHeader
        eyebrow="Settings · public reset feeds"
        title="Reset feeds"
        description="Connection status for the public Codex and Claude reset feeds that fill the reset calendar."
      />
      <ResetFeedHealth />
    </Workspace>
  );
}
