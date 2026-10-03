/**
 * "Every tool route" must stay true as the contract grows: every path in contracts/openapi/tenant-tools.yaml must
 * have a probe in ROUTES, and ROUTES must not invent routes that are not in the contract.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../src/routes.js';
import { leaks, tamperTokenTid, algNoneToken } from '../src/leak.js';

const spec = readFileSync(fileURLToPath(new URL('../../../../contracts/openapi/tenant-tools.yaml', import.meta.url)), 'utf8');

function contractOperations(): Array<{ method: string; path: string; operationId: string }> {
  const out: Array<{ method: string; path: string; operationId: string }> = [];
  let path = ''; let method = '';
  for (const line of spec.split('\n')) {
    const p = /^ {2}(\/\S+):\s*$/.exec(line);
    if (p) { path = p[1]!; continue; }
    const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (m && path) { method = m[1]!.toUpperCase(); continue; }
    const o = /^ {6}operationId:\s*(\w+)/.exec(line);
    if (o && path && method) out.push({ method, path, operationId: o[1]! });
    if (/^components:/.test(line)) break;
  }
  return out;
}

describe('route table vs contracts/openapi/tenant-tools.yaml', () => {
  const ops = contractOperations();

  it('parses a plausible number of operations from the contract', () => {
    expect(ops.length).toBeGreaterThanOrEqual(16);
  });

  it('has a probe for every contract operation', () => {
    const have = new Set(ROUTES.map((r) => `${r.method} ${r.template}`));
    const missing = ops.filter((o) => !have.has(`${o.method} ${o.path}`)).map((o) => `${o.operationId} (${o.method} ${o.path})`);
    expect(missing).toEqual([]);
  });

  it('has no probe for a route that is not in the contract', () => {
    const want = new Set(ops.map((o) => `${o.method} ${o.path}`));
    expect(ROUTES.filter((r) => !want.has(`${r.method} ${r.template}`)).map((r) => r.operationId)).toEqual([]);
  });

  it('uses the contract operationIds', () => {
    expect(ROUTES.map((r) => r.operationId).sort()).toEqual(ops.map((o) => o.operationId).sort());
  });
});

describe('leak helpers', () => {
  it('finds markers case-sensitively and ignores absent ones', () => {
    expect(leaks('{"name":"Zorblax"}', ['Zorblax', 'Nope'])).toEqual(['Zorblax']);
    expect(leaks('{"name":"zorblax"}', ['Zorblax'])).toEqual([]);
  });

  it('rewrites only the tid claim and keeps the original signature', () => {
    const head = Buffer.from('{"alg":"HS256"}').toString('base64url');
    const body = Buffer.from('{"tid":"t_a","prn":"owner"}').toString('base64url');
    const tampered = tamperTokenTid(`${head}.${body}.SIG`, 't_b');
    const [h, p, s] = tampered.split('.');
    expect(h).toBe(head);
    expect(s).toBe('SIG');
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({ tid: 't_b', prn: 'owner' });
  });

  it('builds an unsigned alg=none token for the target tenant', () => {
    const t = algNoneToken('t_b', 'owner');
    const [h, p, s] = t.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString()).alg).toBe('none');
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString()).tid).toBe('t_b');
    expect(s).toBe('');
  });
});
