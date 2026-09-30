import { ReviewNavigation } from '@/components/review-navigation';
import { pageFrame } from '@/components/workspace';
import { cn } from 'cn';
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className={cn(pageFrame(), 'pt-6')}>
        <ReviewNavigation />
      </div>
      {children}
    </>
  );
}
