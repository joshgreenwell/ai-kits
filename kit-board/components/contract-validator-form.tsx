'use client';
import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Field } from './kit/field';
import type { ReportValidation } from '@/lib/report-contracts';

type Issue = ReportValidation['contract']['issues'][number];
const where = (issue: Issue) => issue.path.length ? issue.path.join('.') : '(body)';

/** Checks a pasted request body against the board's validate route. Nothing is stored. */
export function ContractValidatorForm({ kind, example }: { kind: string; example: string }) {
  const id = `validate-${kind}`;
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [result, setResult] = useState<ReportValidation | null>(null);

  async function check(event: FormEvent) {
    event.preventDefault();
    setFieldError(''); setResult(null);
    let body: unknown;
    try { body = JSON.parse(text); } catch { setFieldError('Paste the JSON body a producer would post.'); return; }
    setPending(true);
    try {
      const response = await fetch(`/api/v1/reports/${kind}/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setFieldError(typeof payload.error === 'string' ? payload.error : 'The check could not be completed. Please try again.'); return; }
      setResult(payload as ReportValidation);
    } catch {
      setFieldError('The check could not be completed. Please try again.');
    } finally { setPending(false); }
  }

  const issues = result ? [...result.envelope.issues, ...(result.envelope.valid ? result.contract.issues : [])] : [];
  const title = !result ? '' : !result.accepted ? 'Publishing would refuse this report'
    : result.contract.valid ? `Matches ${result.contract.id}` : `Publishing would store it, but it drifts from ${result.contract.id}`;

  return (
    <form onSubmit={check} className="grid gap-3">
      <Field label="Request body" htmlFor={id} error={fieldError || undefined} help="The whole body a producer posts: the envelope with its payload. It is checked, not stored.">
        <Textarea className="font-mono text-xs" spellCheck={false} value={text} onChange={event => setText(event.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? 'Checking…' : 'Check'}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => { setText(example); setResult(null); setFieldError(''); }}>Use the example</Button>
      </div>
      {result ? (
        <Alert variant={!result.accepted ? 'destructive' : result.contract.valid ? 'success' : 'warning'} aria-live="polite">
          <AlertTitle>{title}</AlertTitle>
          {issues.length ? (
            <AlertDescription>
              <ul className="grid gap-1 font-mono text-xs">
                {issues.map((issue, index) => <li key={index}><span className="font-semibold">{where(issue)}</span>: {issue.message}</li>)}
              </ul>
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}
    </form>
  );
}
