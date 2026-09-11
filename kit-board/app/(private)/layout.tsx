import { redirect } from 'next/navigation';
import { authenticated } from '@/lib/auth';
import { Navigation } from '@/components/navigation';
export const dynamic = 'force-dynamic';
export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  if (!(await authenticated())) redirect('/login');
  return <><a className="skip-link" href="#portal-content">Skip navigation</a><Navigation/><div id="portal-content">{children}</div></>;
}
