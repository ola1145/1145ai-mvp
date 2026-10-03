/** Loads contracts/ for tests: OpenAPI documents (YAML), the events schema (JSON), and a $ref resolver across them. */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml-lite.js';
import { pointer, type RefResolver } from './schema-lite.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const CONTRACTS = join(REPO_ROOT, 'contracts');
export const OPENAPI_DIR = join(CONTRACTS, 'openapi');

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export type HttpMethodName = (typeof HTTP_METHODS)[number];

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Operation {
  /** File name relative to contracts/openapi, e.g. "tenant-tools.yaml". */
  file: string;
  path: string;
  method: HttpMethodName;
  operationId: string;
  op: Obj;
}

export function openapiFiles(): string[] {
  return readdirSync(OPENAPI_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
}

const cache = new Map<string, unknown>();
/** Parsed document by name relative to contracts/openapi ("tenant-tools.yaml"). */
export function loadDoc(file: string): unknown {
  if (!cache.has(file)) cache.set(file, parseYaml(readFileSync(join(OPENAPI_DIR, file), 'utf8')));
  return cache.get(file);
}

export function operations(): Operation[] {
  const out: Operation[] = [];
  for (const file of openapiFiles()) {
    const doc = loadDoc(file);
    const paths = isObj(doc) && isObj(doc.paths) ? doc.paths : {};
    for (const [path, item] of Object.entries(paths)) {
      if (!isObj(item)) continue;
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!isObj(op)) continue;
        out.push({ file, path, method, operationId: String(op.operationId ?? ''), op });
      }
    }
  }
  return out;
}

/** "#/components/x" stays in `doc`; "other.yaml#/components/x" switches document. */
export const resolveRef: RefResolver = (ref, doc) => {
  const [filePart, frag = ''] = ref.split('#');
  const target = filePart ? posix.normalize(filePart).replace(/^\.\//, '') : doc;
  return { schema: pointer(loadDoc(target), `#${frag}`), doc: target };
};

/** Follow $ref chains (for parameters, responses, requestBodies) and return the target object. */
export function deref(node: unknown, doc: string): { node: unknown; doc: string } {
  let cur = node; let d = doc;
  for (let i = 0; i < 10 && isObj(cur) && typeof cur.$ref === 'string'; i++) {
    const r = resolveRef(cur.$ref, d); cur = r.schema; d = r.doc;
  }
  return { node: cur, doc: d };
}

export function eventsSchema(): Obj {
  return JSON.parse(readFileSync(join(CONTRACTS, 'events', 'events.schema.json'), 'utf8')) as Obj;
}
