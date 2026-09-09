/**
 * A small hand-written JSON Schema (2020-12 subset) validator for tests.
 *
 * Supports exactly the keywords `docs/snapshot.schema.json` uses: `type`
 * (string or list, with `integer`), `const`, `enum`, `pattern`, `minimum`,
 * `properties`, `required`, `additionalProperties` (boolean), `items`,
 * `$ref` to a local `#/$defs/...`. Anything else is ignored, so keep the
 * schema inside this subset. No dependency; never used at runtime.
 */

export type Schema = Record<string, unknown>;

export function validate(value: unknown, schema: Schema, root: Schema = schema, path = ""): string[] {
  const errors: string[] = [];
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    return validate(value, resolveRef(ref, root), root, path);
  }
  const type = schema["type"];
  if (type !== undefined) {
    const allowed = Array.isArray(type) ? (type as string[]) : [type as string];
    if (!allowed.some((name) => matchesType(value, name))) {
      errors.push(`${path || "/"}: expected type ${allowed.join("|")}, got ${describe(value)}`);
      return errors;
    }
  }
  if ("const" in schema && !sameJson(value, schema["const"])) {
    errors.push(`${path || "/"}: expected const ${JSON.stringify(schema["const"])}, got ${JSON.stringify(value)}`);
  }
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => sameJson(candidate, value))) {
    errors.push(`${path || "/"}: ${JSON.stringify(value)} is not one of ${JSON.stringify(enumValues)}`);
  }
  if (typeof value === "string" && typeof schema["pattern"] === "string" && !new RegExp(schema["pattern"]).test(value)) {
    errors.push(`${path || "/"}: ${JSON.stringify(value)} does not match ${schema["pattern"]}`);
  }
  if (typeof value === "number" && typeof schema["minimum"] === "number" && value < schema["minimum"]) {
    errors.push(`${path || "/"}: ${value} is below minimum ${schema["minimum"]}`);
  }
  if (Array.isArray(value) && isSchema(schema["items"])) {
    value.forEach((item, index) => errors.push(...validate(item, schema["items"] as Schema, root, `${path}/${index}`)));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
    for (const name of required) {
      if (!(name in value)) {
        errors.push(`${path || "/"}: missing required property ${name}`);
      }
    }
    for (const name of Object.keys(value)) {
      const propertySchema = properties[name];
      if (isSchema(propertySchema)) {
        errors.push(...validate(value[name], propertySchema, root, `${path}/${name}`));
      } else if (schema["additionalProperties"] === false) {
        errors.push(`${path || "/"}: unexpected property ${name}`);
      }
    }
  }
  return errors;
}

function resolveRef(ref: string, root: Schema): Schema {
  if (!ref.startsWith("#/")) {
    throw new Error(`unsupported $ref ${ref}`);
  }
  let current: unknown = root;
  for (const token of ref.slice(2).split("/")) {
    if (!isRecord(current)) {
      throw new Error(`unresolvable $ref ${ref}`);
    }
    current = current[token.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  if (!isSchema(current)) {
    throw new Error(`unresolvable $ref ${ref}`);
  }
  return current;
}

function matchesType(value: unknown, name: string): boolean {
  switch (name) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is Schema {
  return isRecord(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
