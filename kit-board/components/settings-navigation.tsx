'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from 'cn';

const VIEWS = [
  ['/settings', 'Connections'],
  ['/settings/collection', 'Collection'],
  ['/settings/projects', 'Projects'],
  ['/settings/sources', 'Knowledge sources'],
  ['/settings/feeds', 'Reset feeds'],
] as const;

export function SettingsNavigation() {
  const path = usePathname();
  return (
    <nav aria-label="Settings views" className="border-border flex flex-wrap gap-6 border-b">
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
