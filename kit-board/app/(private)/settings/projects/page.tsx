import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { ProjectRegistry } from '@/components/project-registry';

export default function Projects() {
  return (
    <Workspace>
      <PageHeader
        eyebrow="Settings · project identity"
        title="Projects"
        description="The projects you created in your apps, with the folders, sessions, and requests each one covers. Read-only: projects come from the apps, and folder paths never leave a machine."
      />
      <ProjectRegistry />
    </Workspace>
  );
}
