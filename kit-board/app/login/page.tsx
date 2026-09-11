'use client';
import { useState, type FormEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
export default function Login() {
  const [error, setError] = useState(''); const [pending, setPending] = useState(false);
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
  return <main className="login-workspace"><div className="login-brand"><span className="portal-mark">j<span>.</span></span><span>Personal observatory</span></div>
    <section className="login-card"><div className="login-orbit" aria-hidden="true"><span/></div><p className="portal-eyebrow">Your private workspace</p><h1>Welcome back<span>.</span></h1><p className="login-description">A little perspective on your day.</p>
      <form onSubmit={submit}><label htmlFor="password">Password</label><Input id="password" name="password" type="password" autoComplete="current-password" required autoFocus disabled={pending} aria-describedby={error ? 'login-error' : undefined}/><p id="login-error" role="alert" className="login-error">{error}</p><Button className="portal-primary" type="submit" disabled={pending}>{pending ? 'Unlocking…' : 'Unlock workspace'}<span aria-hidden="true">→</span></Button></form>
    </section><p className="login-footer">AI usage <span>·</span> Daily tasks <span>·</span> Standup <span>·</span> Readings <span>·</span> Luumen AI</p></main>;
}
