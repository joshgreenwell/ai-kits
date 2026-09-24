import { UsageNavigation } from '@/components/usage-navigation';
import { pageFrame } from '@/components/workspace';
import { cn } from 'cn';
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className={cn(pageFrame('dashboard'), 'pt-6')}>
        <UsageNavigation />
      </div>
      {children}
    </>
  );
}
