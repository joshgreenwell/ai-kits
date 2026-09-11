import type { Metadata } from 'next';
import { Manrope, DM_Mono } from 'next/font/google';
import './observatory.css';
import './portal.css';
import './theme.css';
const manrope = Manrope({ variable: '--font-manrope', subsets: ['latin'] });
const mono = DM_Mono({ variable: '--font-dm-mono', subsets: ['latin'], weight: ['400', '500'] });
export const metadata: Metadata = { title: 'Personal Observatory', description: 'Josh’s private reports and daily briefings.', robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className="dark"><body className={`${manrope.variable} ${mono.variable}`}>{children}</body></html>;
}
