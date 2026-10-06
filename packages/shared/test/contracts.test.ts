/**
 * Contract coherence (owner: C0). Keeps contracts/openapi, packages/shared and the infra route tables in step while
 * ~50 lanes build against them. Conventions are documented in contracts/README.md.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkReply } from '../../conversation-style/src/index.js';
import { ADMIN_AGENT_TOOLS, CUSTOMER_TOOLS, OWNER_TOOLS } from '../src/tenant-context.js';
import { collectRefs, validate } from './support/schema-lite.js';
import { deref, isObj, loadDoc, openapiFiles, operations, REPO_ROOT, resolveRef, type Obj, type Operation } from './support/contracts.js';

const ops = operations();
const label = (o: Operation) => `${o.operationId} (${o.method.toUpperCase()} ${o.path})`;
const normPath = (p: string) => p.replace(/\{[^}]+\}/g, '{}');

const INFRA_LIB = join(REPO_ROOT, 'infra', 'cdk', 'lib');
const stacks = readdirSync(INFRA_LIB).filter((f) => f.endsWith('.ts')).map((f) => ({ file: f, src: readFileSync(join(INFRA_LIB, f), 'utf8') }));
const quoted = (line: string) => [...line.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);

describe('openapi contracts parse', () => {
  it('there are contracts to check', () => {
    expect(openapiFiles().length).toBeGreaterThanOrEqual(3);
    expect(ops.length).toBeGreaterThan(20);
  });

  it.each(openapiFiles())('%s is an OpenAPI 3.1 document with paths', (file) => {
    const doc = loadDoc(file);
    expect(isObj(doc)).toBe(true);
    expect((doc as Obj).openapi).toBe('3.1.0');
    expect(isObj((doc as Obj).paths)).toBe(true);
  });

  it.each(openapiFiles())('every $ref in %s resolves', (file) => {
    const broken = collectRefs(loadDoc(file)).filter((ref) => resolveRef(ref, file).schema === undefined);
    expect(broken).toEqual([]);
  });

  it('every operation has a unique operationId', () => {
    expect(ops.filter((o) => !/^[a-z][A-Za-z0-9]+$/.test(o.operationId)).map(label)).toEqual([]);
    const seen = new Map<string, number>();
    for (const o of ops) seen.set(o.operationId, (seen.get(o.operationId) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([id]) => id)).toEqual([]);
  });
});

describe('every operationId maps to a handler file under services/ and a route in infra/cdk', () => {
  it.each(ops.map((o) => [label(o), o] as const))('%s has an x-handler that exists', (_l, o) => {
    const handler = o.op['x-handler'];
    expect(typeof handler, 'x-handler must be set').toBe('string');
    expect(handler).toMatch(/^services\/[a-z0-9-]+\/src\/[a-z0-9/-]+\.ts$/);
    expect(existsSync(join(REPO_ROOT, handler as string)), `${handler as string} is missing`).toBe(true);
  });

  it.each(ops.map((o) => [label(o), o] as const))('%s is routed to its handler in an infra stack', (_l, o) => {
    const handler = String(o.op['x-handler'] ?? '');
    const stem = basename(handler, '.ts');
    const dir = `${dirname(handler)}/`;
    const method = `HttpMethod.${o.method.toUpperCase()}`;
    const routedIn = stacks.filter(({ src }) =>
      src.includes(dir)
      && new RegExp(`['"\`/]${stem}(?:\\.ts)?['"\`]`).test(src)
      && src.split('\n').some((line) => line.includes(method) && quoted(line).some((q) => normPath(q) === normPath(o.path))));
    expect(routedIn.map((s) => s.file), `no stack routes ${o.method.toUpperCase()} ${o.path} to ${handler}`).not.toEqual([]);
  });
});

describe('x-principals agree with packages/shared tool permissions', () => {
  const allowed = (p: string) => ops
    .filter((o) => Array.isArray(o.op['x-principals']) && (o.op['x-principals'] as unknown[]).includes(p))
    .map((o) => o.operationId).sort();
  it('customer-agent', () => expect(allowed('customer-agent')).toEqual([...CUSTOMER_TOOLS].sort()));
  it('admin-agent', () => expect(allowed('admin-agent')).toEqual([...ADMIN_AGENT_TOOLS].sort()));
  it('owner', () => expect(allowed('owner')).toEqual([...OWNER_TOOLS].sort()));
});

const voiceOps = ops.filter((o) => o.op['x-voice-path'] === true);

/** Named examples of a media type object; `$ref: '#/components/examples/X'` entries are followed. */
function examplesOf(media: unknown, doc: string): Array<[string, unknown]> {
  if (!isObj(media)) return [];
  const ex = media.examples;
  if (!isObj(ex)) return [];
  return Object.entries(ex).map(([name, e]) => {
    const r = deref(e, doc).node;
    return [name, isObj(r) ? r.value : undefined];
  });
}

/** Request and response bodies (with examples) of an operation, $refs followed. */
function bodies(o: Operation) {
  const out: Array<{ where: string; schema: unknown; examples: Array<[string, unknown]>; required: boolean }> = [];
  if (o.op.requestBody !== undefined) {
    const rb = deref(o.op.requestBody, o.file);
    const media = isObj(rb.node) && isObj(rb.node.content) ? rb.node.content['application/json'] : undefined;
    out.push({ where: 'request', schema: isObj(media) ? media.schema : undefined, examples: examplesOf(media, rb.doc), required: true });
  }
  const responses = isObj(o.op.responses) ? o.op.responses : {};
  for (const [code, r] of Object.entries(responses)) {
    const res = deref(r, o.file);
    const media = isObj(res.node) && isObj(res.node.content) ? res.node.content['application/json'] : undefined;
    const success = /^2\d\d$/.test(code);
    if (!success && media === undefined) continue;
    out.push({ where: `response ${code}`, schema: isObj(media) ? media.schema : undefined, examples: examplesOf(media, res.doc), required: success });
  }
  return out;
}

const SPOKEN_KEYS = new Set(['sayToCaller', 'spoken', 'greeting', 'disclosureLine']);
function spokenStrings(v: unknown, acc: Array<[string, string]> = []): Array<[string, string]> {
  if (Array.isArray(v)) for (const x of v) spokenStrings(x, acc);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) {
    if (SPOKEN_KEYS.has(k) && typeof x === 'string') acc.push([k, x]); else spokenStrings(x, acc);
  }
  return acc;
}

describe('voice-path operations have request/response examples', () => {
  it('every customer-agent tool and every voice route in infra is marked x-voice-path', () => {
    const marked = new Set(voiceOps.map((o) => `${o.method} ${normPath(o.path)}`));
    const customer = ops.filter((o) => Array.isArray(o.op['x-principals']) && (o.op['x-principals'] as unknown[]).includes('customer-agent'));
    expect(customer.filter((o) => !marked.has(`${o.method} ${normPath(o.path)}`)).map(label)).toEqual([]);
    const infraVoice = stacks.flatMap(({ src }) => [...src.matchAll(/method:\s*apigw\.HttpMethod\.(\w+),\s*path:\s*'([^']+)'[^\n]*voice:\s*true/g)])
      .map((m) => `${m[1]!.toLowerCase()} ${normPath(m[2]!)}`);
    expect(infraVoice.filter((r) => !marked.has(r))).toEqual([]);
  });

  it.each(voiceOps.map((o) => [label(o), o] as const))('%s: every body has examples that match its schema', (_l, o) => {
    const problems: string[] = [];
    const bs = bodies(o);
    if (!bs.some((b) => b.where.startsWith('response 2'))) problems.push('no 2xx response');
    for (const b of bs) {
      if (b.required && b.schema === undefined) { problems.push(`${b.where}: no application/json schema`); continue; }
      if (b.required && b.examples.length === 0) problems.push(`${b.where}: no examples`);
      for (const [name, value] of b.examples) {
        if (value === undefined) { problems.push(`${b.where} example ${name}: missing value`); continue; }
        for (const e of validate(b.schema, value, resolveRef, o.file)) problems.push(`${b.where} example ${name}: ${e}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it.each(voiceOps.map((o) => [label(o), o] as const))('%s: example lines a caller hears pass conversation-style', (_l, o) => {
    const problems: string[] = [];
    for (const b of bodies(o)) for (const [, value] of b.examples) {
      for (const [key, text] of spokenStrings(value)) {
        const firstTurn = key === 'disclosureLine' || key === 'greeting';
        for (const i of checkReply(text, { channel: 'voice', isFirstTurn: firstTurn })) {
          if (i.severity === 'error') problems.push(`${key}: ${i.rule} ${i.detail} in "${text}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
