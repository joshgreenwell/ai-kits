import schema from './routing-contract/event.schema.json';
import { validate } from './routing-contract/validate.mjs';
import { RequestError } from './contracts';

export const routingEventTypes = ['task.registered', 'route.decided', 'attempt.started', 'attempt.finished', 'outcome.recorded'] as const;
export type RoutingEventType = typeof routingEventTypes[number];
export type RoutingEvent = {
  schema_version: 1;
  event_id: string;
  task_id: string;
  attempt_id: string | null;
  sequence: number;
  event_type: RoutingEventType;
  occurred_at: string;
  payload: Record<string, unknown>;
};
export type RoutingEventBatch = { schema_version: 1; events: RoutingEvent[] };

const maximumFutureMs = 5 * 60_000;
const attemptEventTypes = new Set<RoutingEventType>(['attempt.started', 'attempt.finished']);

/**
 * Validates only the narrow, versioned wire envelope. This intentionally has no
 * free-text fields, preventing task prompts, transcripts, or account details
 * from entering the Observatory event ledger.
 */
export function parseRoutingEventBatch(input: unknown, now = Date.now()): RoutingEventBatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError('Invalid routing event batch');
  const record = input as Record<string, unknown>;
  if (record.schema_version !== 1 || !Array.isArray(record.events) || Object.keys(record).some(key => key !== 'schema_version' && key !== 'events')) {
    throw new RequestError('Invalid routing event batch');
  }
  if (record.events.length > 100) throw new RequestError('A routing event batch may contain at most 100 events', 413);
  try { record.events.forEach(event => validate(event, schema)); }
  catch { throw new RequestError('Routing event validation failed'); }
  const events = record.events as RoutingEvent[];
  for (const event of events) {
    if (Date.parse(event.occurred_at) > now + maximumFutureMs) throw new RequestError('Routing event time cannot be in the future');
    if (attemptEventTypes.has(event.event_type) && !event.attempt_id) throw new RequestError('Attempt events require attempt_id');
    if (event.event_type === 'task.registered' && event.attempt_id) throw new RequestError('Task registration cannot name an attempt');
    if (event.event_type === 'outcome.recorded' && ['test','ci','benchmark'].includes(event.payload.source as string) && !event.payload.evidence_hash) throw new RequestError('Automated outcomes require evidence');
    if (event.event_type === 'outcome.recorded' && event.payload.source === 'runtime' &&
      (event.payload.result !== 'unknown' || event.payload.first_attempt_success !== null || event.payload.human_rework_minutes !== null)) {
      throw new RequestError('Runtime cannot assert a quality outcome');
    }
  }
  return { schema_version: 1, events };
}

export function assertProviderMatchesSource(event: RoutingEvent, provider: 'codex' | 'claude') {
  if (!attemptEventTypes.has(event.event_type)) return;
  if (event.payload.provider !== provider) throw new RequestError('Attempt provider does not match this telemetry source', 403);
}
