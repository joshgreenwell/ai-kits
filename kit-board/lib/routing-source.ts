import { RequestError } from './contracts';

export type RoutingSource = { id: string; account_id: string; mode: 'local' | 'browser'; provider: 'codex' | 'claude' };

export function requireLocalRoutingSource(source: RoutingSource) {
  if (source.mode !== 'local') throw new RequestError('Browser telemetry sources cannot use routing endpoints', 403);
  return source;
}
