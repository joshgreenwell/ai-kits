/*
 * Flattens a contract's JSON Schema into the rows /kits shows: one per field, with its path, type,
 * whether it is required, and its constraints in words. It reads the subset `npm run contracts` emits.
 */

type Schema = {
  type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: Schema | boolean;
  items?: Schema; anyOf?: Schema[]; oneOf?: Schema[]; enum?: unknown[]; const?: unknown; pattern?: string; format?: string;
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number;
  default?: unknown; description?: string;
};

export type ContractField = { path: string; depth: number; type: string; required: boolean; rules: string[]; description?: string };

const typeOf = (schema: Schema): string => {
  const options = schema.anyOf ?? schema.oneOf;
  if (options) return [...new Set(options.map(typeOf))].join(' or ');
  if (schema.type === 'array') return schema.items ? `${typeOf(schema.items)} list` : 'list';
  return [schema.type ?? 'any'].flat().join(' or ');
};

const range = (low: number | undefined, high: number | undefined, unit: string) => {
  const units = (count: number) => unit && count !== 1 ? `${unit}s` : unit;
  return low !== undefined && high !== undefined ? `${low}–${high} ${units(high)}` : low !== undefined ? `at least ${low} ${units(low)}` : high !== undefined ? `at most ${high} ${units(high)}` : null;
};

function rulesOf(schema: Schema): string[] {
  const rules: (string | null)[] = [];
  if (Object.hasOwn(schema, 'const')) rules.push(`always ${JSON.stringify(schema.const)}`);
  if (schema.enum) rules.push(`one of ${schema.enum.map(value => JSON.stringify(value)).join(', ')}`);
  if (schema.format === 'date-time') rules.push('ISO 8601 time with a UTC offset');
  else if (schema.pattern === '\\S') rules.push('not blank');
  else if (schema.pattern) rules.push(schema.pattern.length <= 40 ? `matches ${schema.pattern}` : 'format checked');
  rules.push(range(schema.minLength, schema.maxLength, 'character'), range(schema.minimum, schema.maximum, ''), range(schema.minItems, schema.maxItems, 'item'));
  if (schema.default !== undefined) rules.push(`defaults to ${JSON.stringify(schema.default)}`);
  if (schema.additionalProperties === false) rules.push('no other keys');
  return rules.filter((rule): rule is string => Boolean(rule)).map(rule => rule.trim());
}

/** A value that may also be null reads as its one other shape: `anyOf: [X, { type: 'null' }]`. */
const unwrap = (schema: Schema): Schema => {
  const options = (schema.anyOf ?? schema.oneOf)?.filter(option => option.type !== 'null');
  return options?.length === 1 ? { ...options[0], description: schema.description ?? options[0].description } : schema;
};

/** The property whose constant tells one object shape from another, as `event` does in a discriminated union. */
const discriminator = (option: Schema) => Object.entries(option.properties ?? {}).find(([, child]) => Object.hasOwn(child, 'const'));

/** Every field in a contract, parents before their children, in the schema's own order. */
export function contractFields(root: Schema): ContractField[] {
  const rows: ContractField[] = [];
  const walk = (schema: Schema, prefix: string, depth: number) => {
    const target = schema.type === 'array' && schema.items ? schema.items : schema;
    const base = schema.type === 'array' ? `${prefix}[]` : prefix;
    for (const [name, raw] of Object.entries(target.properties ?? {})) {
      const path = base ? `${base}.${name}` : name;
      const child = unwrap(raw);
      rows.push({ path, depth, type: typeOf(raw), required: target.required?.includes(name) ?? false, rules: rulesOf(child), description: child.description });
      walk(child, path, depth + 1);
      // One row per shape an object can take, named by its discriminator, with that shape's fields under it.
      const variants = (child.anyOf ?? child.oneOf ?? []).filter(option => option.type === 'object');
      for (const variant of variants) {
        const [key, tag] = discriminator(variant) ?? [];
        const label = key ? `${key} ${JSON.stringify(tag?.const)}` : `shape ${variants.indexOf(variant) + 1}`;
        rows.push({ path: `${path} (${label})`, depth: depth + 1, type: 'object', required: false, rules: rulesOf(variant), description: variant.description });
        walk(variant, path, depth + 2);
      }
    }
    const extra = target.additionalProperties;
    // `{}` only says the object is open; a schema here describes every key the object does not name.
    if (extra && typeof extra === 'object' && (extra.type || extra.properties)) {
      const path = `${base}.*`;
      rows.push({ path, depth, type: typeOf(extra), required: false, rules: rulesOf(extra), description: extra.description ?? 'Any other key' });
      walk(extra, path, depth + 1);
    }
  };
  walk(root, '', 0);
  return rows;
}
