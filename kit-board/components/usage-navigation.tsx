'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from 'cn';

const VIEWS = [
  ['/usage', 'Monthly report'],
  ['/usage/live', 'Usage & pace'],
  ['/usage/resets', 'Reset intelligence'],
  ['/usage/connections', 'Connections'],
  ['/usage/settings', 'Settings'],
] as const;

export function UsageNavigation() {
  const path = usePathname();
  return (
    <nav aria-label="AI usage views" className="border-border flex flex-wrap gap-6 border-b">
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
