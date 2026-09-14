import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { KnowledgeSourceRegistry } from '@/components/knowledge-source-registry';

export default function KnowledgeSources() {
  return (
    <Workspace>
      <PageHeader
        eyebrow="Settings · knowledge sources"
        title="Knowledge sources"
        description="Name the vaults and folders your tool calls touch and map each install's resource key to one. Roots and connectors stay in the machine's companion.json; only keys and counts arrive here."
      />
      <KnowledgeSourceRegistry />
    </Workspace>
  );
}
