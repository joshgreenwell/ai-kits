'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { sections } from '@/lib/catalog';
import { Button } from './ui/button';
import { cn } from 'cn';
import { pageFrame } from './workspace';

export function Navigation() {
  const pathname = usePathname();
  const startSection = () => window.scrollTo(0, 0);
  const isCurrent = (path: string) => pathname === path || pathname.startsWith(path + '/');

  return (
    <header data-app-header className="bg-background/85 border-border sticky top-0 z-40 border-b backdrop-blur">
      {/* The header spans the dashboard frame on every view, so it holds still when a section changes width. */}
      <div className={cn(pageFrame('dashboard'), 'flex flex-wrap items-center gap-x-6 gap-y-3 py-3')}>
        <Link
          href="/usage"
          scroll={false}
          onNavigate={startSection}
          className="focus-visible:ring-ring/50 flex items-center gap-2 rounded-md text-sm font-bold tracking-tight outline-none focus-visible:ring-[3px]"
        >
          <span
            aria-hidden="true"
            className="bg-primary text-primary-foreground grid size-6 place-items-center rounded-md font-mono text-xs"
          >
            j
          </span>
          <span>
            Personal <span className="text-muted-foreground font-medium">observatory</span>
          </span>
        </Link>

        <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-1">
          {sections.map(section => (
            <Link
              key={section.kind}
              href={section.path}
              scroll={false}
              onNavigate={startSection}
              aria-current={isCurrent(section.path) ? 'page' : undefined}
              className={cn(
                'focus-visible:ring-ring/50 rounded-md px-2.5 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px]',
                isCurrent(section.path)
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {section.title}
            </Link>
          ))}
          <Link
            href="/reviews"
            scroll={false}
            onNavigate={startSection}
            aria-current={isCurrent('/reviews') ? 'page' : undefined}
            className={cn(
              'focus-visible:ring-ring/50 rounded-md px-2.5 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px]',
              isCurrent('/reviews')
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            PR watch
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/settings"
            scroll={false}
            onNavigate={startSection}
            aria-current={isCurrent('/settings') ? 'page' : undefined}
            className={cn(
              'focus-visible:ring-ring/50 rounded-md px-2.5 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px]',
              isCurrent('/settings')
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            Settings
          </Link>
          <Link
            href="/schedules"
            scroll={false}
            onNavigate={startSection}
            aria-current={pathname === '/schedules' ? 'page' : undefined}
            className={cn(
              'focus-visible:ring-ring/50 rounded-md px-2.5 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px]',
              pathname === '/schedules'
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            Schedules
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
