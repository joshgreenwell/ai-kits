'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from './ui/button';
export function UsageNavigation() {
  const path = usePathname();
  return <nav className="usage-subnav" aria-label="AI usage views">{[
    ['/usage', 'Monthly report'], ['/usage/live', 'Usage & pace'], ['/usage/resets', 'Reset intelligence'], ['/usage/connections', 'Connections'],
  ].map(([href, label]) => <Button key={href} variant={path === href ? 'secondary' : 'ghost'} asChild><Link href={href} aria-current={path === href ? 'page' : undefined}>{label}</Link></Button>)}</nav>;
}
