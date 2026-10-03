/**
 * Minimal JSON Schema (2020-12 subset used by contracts/) validator for contract tests. No dependencies.
 * Supports: $ref (local "#/..." and relative "other.yaml#/..."), type, enum, const, required, properties,
 * additionalProperties, items, pattern, minLength, maxLength, minimum, maximum, format (date-time, date, email).
 */
type Json = unknown;
export type RefResolver = (ref: string, baseDoc: string) => { schema: Json; doc: string };

const FORMATS: Record<string, RegExp> = {
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** Follow a JSON pointer ("#/a/b") inside a document. */
export function pointer(doc: unknown, ptr: string): unknown {
  if (ptr === '' || ptr === '#') return doc;
  let cur: unknown = doc;
  for (const raw of ptr.replace(/^#\/?/, '').split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function validate(schema: Json, value: unknown, resolve: RefResolver, doc: string, path = '$'): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${path}: not allowed`];
  if (!isObj(schema)) return [`${path}: schema is not an object`];
  if (typeof schema.$ref === 'string') {
    const r = resolve(schema.$ref, doc);
    if (r.schema === undefined) return [`${path}: unresolved $ref ${schema.$ref}`];
    return validate(r.schema, value, resolve, r.doc, path);
  }
  const errs: string[] = [];
  const t = typeOf(value);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((x) => x === t || (x === 'number' && t === 'integer'));
    if (!ok) return [`${path}: expected ${types.join('|')}, got ${t}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errs.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if (typeof value === 'string') {
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) errs.push(`${path}: does not match ${schema.pattern}`);
    if (typeof schema.format === 'string' && FORMATS[schema.format] && !FORMATS[schema.format]!.test(value)) errs.push(`${path}: not a ${schema.format}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.maximum === 'number' && value > schema.maximum) errs.push(`${path}: above maximum ${schema.maximum}`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) errs.push(`${path}: below minimum ${schema.minimum}`);
  }
  if (isObj(value)) {
    for (const k of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!(k in value)) errs.push(`${path}: missing required "${k}"`);
    }
    const props = isObj(schema.properties) ? schema.properties : {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) errs.push(...validate(props[k], v, resolve, doc, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: unexpected property "${k}"`);
      else if (isObj(schema.additionalProperties)) errs.push(...validate(schema.additionalProperties, v, resolve, doc, `${path}.${k}`));
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((v, i) => errs.push(...validate(schema.items, v, resolve, doc, `${path}[${i}]`)));
  }
  return errs;
}

/** Every "$ref" string anywhere inside a document. */
export function collectRefs(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) collectRefs(n, acc);
  else if (isObj(node)) for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string') acc.push(v); else collectRefs(v, acc);
  }
  return acc;
}
