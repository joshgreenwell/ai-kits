'use client';
import { Suspense } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { cn } from 'cn';

// Configuration lives under /settings; the reset calendar stays reachable from Allowances until USG-024 relocates it.
const VIEWS = [
  ['/usage', 'Tokens'],
  ['/usage/allowances', 'Allowances'],
] as const;
/** The selection that carries between the two views: accounts and providers, never the Tokens-only detail filters. */
const CARRIED = ['accounts', 'providers'] as const;

function Links({ carried }: { carried: string }) {
  const path = usePathname();
  return (
    <nav aria-label="AI usage views" className="border-border flex flex-wrap gap-6 border-b">
      {VIEWS.map(([href, label]) => {
        const current = path === href;
        return (
          <Link
            key={href}
            href={carried ? `${href}?${carried}` : href}
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

function CarriedLinks() {
  const params = useSearchParams();
  const carried = new URLSearchParams();
  for (const key of CARRIED) { const value = params.get(key); if (value) carried.set(key, value); }
  return <Links carried={carried.toString()} />;
}

export function UsageNavigation() {
  return <Suspense fallback={<Links carried="" />}><CarriedLinks /></Suspense>;
}
