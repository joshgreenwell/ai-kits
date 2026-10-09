'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { kits } from '@/lib/kits';
import { Button } from './ui/button';
import { cn } from 'cn';
import { pageFrame } from './workspace';

// Carbon's section links: muted until hovered, and the current one lifted onto a glass chip.
const linkClass = (current: boolean) => cn(
  'focus-visible:outline-ring rounded-md px-2.5 py-1.5 text-[12.5px] font-medium outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
  current
    ? 'bg-fill-emphasis text-foreground shadow-[inset_0_0_0_1px_var(--border-glass)]'
    : 'text-muted-foreground hover:bg-fill-control hover:text-foreground'
);

export function Navigation() {
  const pathname = usePathname();
  const startSection = () => window.scrollTo(0, 0);
  const isCurrent = (path: string) => pathname === path || pathname.startsWith(path + '/');

  return (
    <header data-app-header className="sticky top-0 z-40 border-b border-glass bg-[var(--bar-glass)] shadow-[0_8px_24px_-18px_var(--shadow-flyout)] backdrop-blur-[40px] backdrop-saturate-[1.3]">
      {/* The header spans the dashboard frame on every view, so it holds still when a section changes width. */}
      <div className={cn(pageFrame('dashboard'), 'flex flex-wrap items-center gap-x-6 gap-y-3 py-3')}>
        <Link
          href="/usage"
          scroll={false}
          onNavigate={startSection}
          className="focus-visible:outline-ring flex items-center gap-2 rounded-md text-sm font-semibold tracking-[-.01em] outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <span
            aria-hidden="true"
            className="bg-foreground grid size-6 place-items-center rounded-md font-mono text-xs font-medium text-[#131316]"
          >
            j
          </span>
          <span>
            Personal <span className="text-muted-foreground font-medium">observatory</span>
          </span>
        </Link>

        <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-1">
          {kits.map(kit => (
            <Link
              key={kit.id}
              href={kit.page.path}
              scroll={false}
              onNavigate={startSection}
              aria-current={isCurrent(kit.page.path) ? 'page' : undefined}
              className={linkClass(isCurrent(kit.page.path))}
            >
              {kit.title}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/settings"
            scroll={false}
            onNavigate={startSection}
            aria-current={isCurrent('/settings') ? 'page' : undefined}
            className={linkClass(isCurrent('/settings'))}
          >
            Settings
          </Link>
          <Link
            href="/kits"
            scroll={false}
            onNavigate={startSection}
            aria-current={isCurrent('/kits') ? 'page' : undefined}
            className={linkClass(isCurrent('/kits'))}
          >
            Kits
          </Link>
          <form action="/api/auth/logout" method="post">
            <Button variant="outline" size="sm" type="submit">
              Lock
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
