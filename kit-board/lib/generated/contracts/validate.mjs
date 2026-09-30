#!/usr/bin/env node
// Validates a report against a board contract with no dependencies. `npm run contracts` copies this file to
// lib/generated/contracts/validate.mjs, and each kit keeps a byte-identical copy beside its schemas.
// It covers the JSON Schema subset the board's generator emits and throws on any other keyword, so a
// schema it cannot fully check never passes silently.
//
//   node validate.mjs <contract>.schema.json <report>.json
//
// prints {"valid":true} or the issues, and exits 1 when the report does not match.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const annotations = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples', 'format', 'deprecated', 'readOnly', 'writeOnly']);
const assertions = new Set(['type', 'properties', 'required', 'additionalProperties', 'propertyNames', 'items', 'enum', 'const', 'pattern',
  'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'anyOf', 'oneOf', 'allOf', '$ref', '$defs']);

/** Throws when the schema uses a keyword this validator does not check. */
export function assertSupported(schema, where = '#') {
  if (typeof schema === 'boolean') return;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`${where}: a schema must be an object or a boolean`);
  for (const [keyword, value] of Object.entries(schema)) {
    if (!annotations.has(keyword) && !assertions.has(keyword)) throw new Error(`${where}: unsupported keyword ${keyword}`);
    if (keyword === '$ref' && !String(value).startsWith('#/$defs/')) throw new Error(`${where}: only local #/$defs references are supported`);
    if (keyword === 'properties' || keyword === '$defs') for (const [name, child] of Object.entries(value)) assertSupported(child, `${where}/${keyword}/${name}`);
    if (keyword === 'additionalProperties' || keyword === 'propertyNames' || keyword === 'items') assertSupported(value, `${where}/${keyword}`);
    if (keyword === 'anyOf' || keyword === 'oneOf' || keyword === 'allOf') value.forEach((child, index) => assertSupported(child, `${where}/${keyword}/${index}`));
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const typeMatches = (type, value) =>
  type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value)
      : type === 'object' ? isObject(value)
        : type === 'integer' ? Number.isInteger(value)
          : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === type;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function check(value, schema, root, path, issues) {
  if (schema === true) return;
  if (schema === false) { issues.push({ path, message: 'No value is allowed here' }); return; }
  if (schema.$ref) check(value, root.$defs?.[schema.$ref.slice('#/$defs/'.length)] ?? false, root, path, issues);
  if (schema.allOf) for (const option of schema.allOf) check(value, option, root, path, issues);
  if (schema.anyOf || schema.oneOf) {
    const options = schema.anyOf ?? schema.oneOf;
    const matches = options.filter(option => { const found = []; check(value, option, root, path, found); return !found.length; }).length;
    if (schema.anyOf && !matches) issues.push({ path, message: 'Does not match any allowed shape' });
    if (schema.oneOf && matches !== 1) issues.push({ path, message: 'Must match exactly one allowed shape' });
  }
  if (schema.type !== undefined) {
    const types = [schema.type].flat();
    if (!types.some(type => typeMatches(type, value))) { issues.push({ path, message: `Expected ${types.join(' or ')}` }); return; }
  }
  if (Object.hasOwn(schema, 'const') && !equal(value, schema.const)) issues.push({ path, message: `Expected ${JSON.stringify(schema.const)}` });
  if (schema.enum && !schema.enum.some(option => equal(value, option))) issues.push({ path, message: `Expected one of ${schema.enum.map(option => JSON.stringify(option)).join(', ')}` });
  if (typeof value === 'string') {
    // UTF-16 length, as the board's zod source counts it.
    const length = value.length;
    if (schema.minLength !== undefined && length < schema.minLength) issues.push({ path, message: schema.minLength === 1 ? 'Must not be empty' : `Must be at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && length > schema.maxLength) issues.push({ path, message: `Must be at most ${schema.maxLength} characters` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) issues.push({ path, message: schema.pattern === '\\S' ? 'Must not be blank' : 'Does not match the required format' });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `Must be at least ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `Must be at most ${schema.maximum}` });
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) issues.push({ path, message: `Must be greater than ${schema.exclusiveMinimum}` });
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) issues.push({ path, message: `Must be less than ${schema.exclusiveMaximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: `Must have at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, message: `Must have at most ${schema.maxItems} items` });
    if (schema.items !== undefined) value.forEach((item, index) => check(item, schema.items, root, [...path, index], issues));
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) issues.push({ path: [...path, key], message: 'Required' });
    for (const [key, child] of Object.entries(value)) {
      if (schema.propertyNames !== undefined) check(key, schema.propertyNames, root, [...path, key], issues);
      if (schema.properties && Object.hasOwn(schema.properties, key)) check(child, schema.properties[key], root, [...path, key], issues);
      else if (schema.additionalProperties === false) issues.push({ path: [...path, key], message: 'Unrecognized key' });
      else if (schema.additionalProperties !== undefined) check(child, schema.additionalProperties, root, [...path, key], issues);
    }
  }
}

/** Returns { valid, issues }, each issue a { path, message } with the path as a list of keys and indexes. */
export function validate(value, schema) {
  assertSupported(schema);
  const issues = [];
  check(value, schema, schema, [], issues);
  return { valid: issues.length === 0, issues };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [schemaPath, reportPath] = process.argv.slice(2);
  if (!schemaPath || !reportPath) {
    console.error('Usage: node validate.mjs <contract>.schema.json <report>.json');
    process.exit(2);
  }
  const result = validate(JSON.parse(readFileSync(reportPath, 'utf8')), JSON.parse(readFileSync(schemaPath, 'utf8')));
  console.log(JSON.stringify(result.valid ? { valid: true } : result, null, 2));
  process.exit(result.valid ? 0 : 1);
}
