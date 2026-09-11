'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { sections } from '@/lib/catalog';
import { Button } from './ui/button';
export function Navigation() {
  const pathname = usePathname();
  const startSection = () => window.scrollTo(0, 0);
  return <header className="portal-header">
    <Link href="/usage" className="portal-brand" scroll={false} onNavigate={startSection}><span className="portal-mark" aria-hidden="true">j<span>.</span></span><span>Personal<span className="brand-secondary">observatory</span></span></Link>
    <nav aria-label="Main navigation">{sections.map(section => <Link key={section.kind} href={section.path} scroll={false} onNavigate={startSection} aria-current={pathname === section.path || pathname.startsWith(section.path + '/') ? 'page' : undefined}>{section.title}</Link>)}</nav>
    <div className="portal-account"><Link href="/schedules" scroll={false} onNavigate={startSection} aria-current={pathname === '/schedules' ? 'page' : undefined}>Schedules</Link><form action="/api/auth/logout" method="post"><Button variant="outline" type="submit">Lock <span aria-hidden="true">↗</span></Button></form></div>
  </header>;
}
