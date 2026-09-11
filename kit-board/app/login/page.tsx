'use client';
import { useState, type FormEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/kit';

export default function Login() {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPending(true);
    const password = new FormData(event.currentTarget).get('password');
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Unable to sign in');
      window.location.assign('/usage');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to sign in'); setPending(false); }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-between gap-10 px-6 py-10">
      <div className="flex w-full items-center gap-2 text-sm font-bold tracking-tight">
        <span aria-hidden="true" className="bg-primary text-primary-foreground grid size-6 place-items-center rounded-md font-mono text-xs">j</span>
        <span>Personal <span className="text-muted-foreground font-medium">observatory</span></span>
      </div>

      <Card className="w-full max-w-[400px]">
        <CardHeader>
          <CardDescription className="font-mono text-[11px] tracking-wide">Your private workspace</CardDescription>
          <CardTitle className="text-2xl">Welcome back</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-6 text-sm leading-relaxed">A little perspective on your day.</p>
          <form onSubmit={submit} className="grid gap-4">
            <Field htmlFor="password" label="Password" error={error || undefined}>
              <Input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                autoFocus
                disabled={pending}
              />
            </Field>
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? 'Unlocking…' : 'Unlock workspace'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-center font-mono text-[11px] leading-relaxed">
        AI usage · Daily tasks · Standup · Readings · Luumen AI
      </p>
    </main>
  );
}
