import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { Badge } from '@/components/ui/badge';
import { CompanionInstalls } from '@/components/companion-installs';
import { BrowserConnections } from '@/components/browser-connections';

export default function Connections() {
  return (
    <Workspace>
      <PageHeader
        eyebrow="Settings · private collection, no inference"
        title="Connections"
        description="Every machine and browser that reports to this Observatory, with what each one can do, what it last delivered, and what it still needs."
        actions={<Badge variant="outline">Hourly by default</Badge>}
      />
      <CompanionInstalls />
      <BrowserConnections />
    </Workspace>
  );
}
