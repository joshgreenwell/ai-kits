import type { Endpoint } from './types';

/** APIs the board keeps for itself: sign-in, report HTML, and agent routing, which has no kit. */
export const boardEndpoints = [
  { method: 'POST', path: '/api/auth/login', auth: 'public', summary: 'Signs in with the site password.' },
  { method: 'POST', path: '/api/auth/logout', auth: 'public', summary: 'Ends the session.' },
  { method: 'GET', path: '/api/artifacts/:id', auth: 'session', summary: "A report's HTML, sandboxed under its own policy." },
  { method: 'GET', path: '/api/artifacts/:id/files/:key', auth: 'session', summary: 'One evidence file linked from a report.' },
  { method: 'POST', path: '/api/v1/agent-events', auth: 'telemetry', summary: 'Agent routing event batches; the contract is copied into lib/routing-contract/.' },
  { method: 'GET', path: '/api/v1/agent-events', auth: 'telemetry', summary: "One task's routing events." },
  { method: 'GET', path: '/api/v1/quota-state', auth: 'telemetry', summary: 'Current allowance state for the routing agent.' },
] as const satisfies readonly Endpoint[];
