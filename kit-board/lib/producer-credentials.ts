import { digest, safeEqual } from './crypto';
import type { ProducerKind } from './kits';

/** Scopes come from the kit manifests: every report kind, plus the PR watch runner's `pr-watch`. */
export type { ProducerKind };

type ProducerCredential = {
  hash: string;
  kinds: string[];
};

function entries(serialized: string): [string, ProducerCredential][] {
  const parsed: unknown = JSON.parse(serialized);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  return Object.entries(parsed).filter((entry): entry is [string, ProducerCredential] => {
    const value = entry[1];
    return Boolean(
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && typeof (value as ProducerCredential).hash === 'string'
      && Array.isArray((value as ProducerCredential).kinds)
      && (value as ProducerCredential).kinds.every(kind => typeof kind === 'string'),
    );
  });
}

/**
 * Resolve a report producer from the primary credential set and, for usage only,
 * an additive credential set used during recovery or key rotation.
 */
export function producerForToken(
  token: string,
  kind: ProducerKind,
  primarySerialized = '{}',
  usageSerialized = '{}',
): string | undefined {
  const tokenHash = digest(token);
  const configurations = kind === 'usage'
    ? [primarySerialized, usageSerialized]
    : [primarySerialized];

  for (const serialized of configurations) {
    for (const [producer, value] of entries(serialized)) {
      if (value.kinds.includes(kind) && safeEqual(value.hash, tokenHash)) return producer;
    }
  }

  return undefined;
}
