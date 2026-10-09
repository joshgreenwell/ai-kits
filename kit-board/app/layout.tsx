import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './base.css';
import './theme.css';
const geist = Geist({ variable: '--font-geist', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
export const metadata: Metadata = { title: 'Personal Observatory', description: 'Josh’s private reports and daily briefings.', robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className={`dark ${geist.variable} ${geistMono.variable}`}><body>{children}</body></html>;
}
