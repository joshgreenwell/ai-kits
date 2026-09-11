'use client';
import { Button } from '@/components/ui/button';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <div className="portal-empty"><h1>Reports are temporarily unavailable</h1><p>Your history is preserved. Try loading it again.</p><Button onClick={reset}>Try again</Button></div>;
}
