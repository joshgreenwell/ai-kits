import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { ProjectRegistry } from '@/components/project-registry';

export default function Projects() {
  return (
    <Workspace>
      <PageHeader
        eyebrow="Settings · project identity"
        title="Projects"
        description="Name the projects your requests belong to and map each reported identity to one. The hash of a working directory or a provider's native id is all that ever leaves a machine."
      />
      <ProjectRegistry />
    </Workspace>
  );
}
