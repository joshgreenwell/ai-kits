'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from 'cn';

// The two directions of the PR watch queue: other people's PRs to re-review, and the owner's own PRs to fix up.
const VIEWS = [
  ['/reviews', 'Re-review'],
  ['/reviews/comments', 'Address comments'],
] as const;

export function ReviewNavigation() {
  const path = usePathname();
  return (
    <nav aria-label="PR watch views" className="border-border flex flex-wrap gap-6 border-b">
      {VIEWS.map(([href, label]) => {
        const current = path === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'focus-visible:ring-ring/50 -mb-px rounded-t-sm border-b-2 pb-2.5 text-sm font-semibold outline-none transition-colors focus-visible:ring-[3px]',
              current
                ? 'border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
