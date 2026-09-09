/**
 * Deterministic JSON output: same input → byte-identical text.
 *
 * Object keys are sorted recursively; arrays keep their order (callers sort
 * collections by stable keys before serializing). `undefined` values are
 * dropped by `JSON.stringify` exactly as in plain JSON output.
 */

/** Return a copy of `value` with every object's keys sorted (code-unit order). */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      out[key] = canonicalize(record[key]);
    }
    return out;
  }
  return value;
}

/** Serialize with sorted keys, two-space indent and a trailing newline. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}
