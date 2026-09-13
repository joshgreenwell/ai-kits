import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { Badge } from '@/components/ui/badge';
import { CompanionInstalls } from '@/components/companion-installs';

export default function Connections() {
  return (
    <Workspace>
      <PageHeader
        eyebrow="Private collection · no inference"
        title="Usage connections"
        actions={<Badge variant="outline">Hourly by default</Badge>}
      />
      <CompanionInstalls />
    </Workspace>
  );
}
