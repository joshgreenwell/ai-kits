// Small strict JSON Schema subset used by the versioned routing wire contracts.
// Vendored with the schema into consumers; no external code or references are loaded.
export function validate(value, schema, root = schema, path = '$') {
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/$defs/')) throw new Error('External schema references are forbidden');
    return validate(value, root.$defs[schema.$ref.slice(8)], root, path);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(option => { try { validate(value, option, root, path); return true; } catch { return false; } });
    if (matches.length !== 1) throw new Error(`${path}: expected exactly one supported variant`);
    return value;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const validType = types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) :
    type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) :
    type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type);
  if (!validType) throw new Error(`${path}: invalid type`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) throw new Error(`${path}: invalid constant`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: unsupported value`);
  if (value === null) return value;
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${path}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${path}: invalid format`);
    if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) throw new Error(`${path}: invalid timestamp`);
    if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${path}: invalid UUID`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path}: too many items`);
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) throw new Error(`${path}: duplicate items`);
    value.forEach((item, index) => validate(item, schema.items, root, `${path}[${index}]`));
  } else if (typeof value === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: required`);
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validate(value[key], schema.properties[key], root, `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}: unexpected property`);
      else if (typeof schema.additionalProperties === 'object') validate(value[key], schema.additionalProperties, root, `${path}.${key}`);
    }
  }
  return value;
}
