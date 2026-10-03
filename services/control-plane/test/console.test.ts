import { beforeEach, describe, expect, it } from 'vitest';
import type { EngineAgentRef, EventEnvelope, TenantRuntimeState, VoiceEngine } from '@1145/shared';
import { handle } from '../src/console/routes.js';
import { REASON_CODES } from '../src/console/reasons.js';
import { DdbConsoleStore } from '../src/console/store.js';
import { auditKey, auditWriter } from '../src/console/audit-sink.js';
import { consoleEngineFor } from '../src/console/engines.js';
import { createHash } from 'node:crypto';
import type {
  AuditEntry, ConsoleDeps, ConsoleEvent, ConsoleStore, ConversationRecord, Page, TemplateVersion, TenantRecord, UsageRecord,
} from '../src/console/types.js';

const ACTOR = 'arn:aws:sts::111122223333:assumed-role/Ai1145Staff/maria';
const TID = 't_tenanta01';
const OTHER = 't_tenantb02';
const START = '2026-09-01T10:00:00.000Z';

// ───────────────────────── fakes ─────────────────────────
class FakeStore implements ConsoleStore {
  profiles = new Map<string, TenantRecord>();
  usage = new Map<string, UsageRecord[]>();
  templates: TemplateVersion[] = [{ template: 'frontdesk', version: '1.2.0', status: 'stable' }, { template: 'frontdesk', version: '1.3.0-rc1', status: 'canary' }, { template: 'frontdesk', version: '0.9.0', status: 'retired' }];
  convs = new Map<string, Map<string, string | undefined>>(); // tid -> `${start}#${id}` -> transcript key
  objects = new Map<string, string>();
  calls: string[] = [];
  deleted: string[] = [];
  failDelete = false;

  async listTenants(q: { limit: number }): Promise<Page<TenantRecord>> {
    this.calls.push('listTenants');
    return { items: [...this.profiles.values()].slice(0, q.limit) };
  }
  async getProfile(tid: string) { return this.profiles.get(tid); }
  async listUsage(tid: string) { return this.usage.get(tid) ?? []; }
  async listTemplateVersions(template: string) { return this.templates.filter((t) => t.template === template); }
  async writeState(tid: string, state: TenantRuntimeState, meta: { reasonCode: string; actor: string }) {
    this.calls.push(`writeState:${tid}:${state}:${meta.reasonCode}:${meta.actor}`);
    this.profiles.set(tid, { ...this.profiles.get(tid)!, state, stateReasonCode: meta.reasonCode, stateActor: meta.actor });
  }
  async setTemplatePin(tid: string, pin: { template: string; version: string } | null, meta: { reasonCode: string; actor: string }) {
    this.calls.push(`pin:${tid}:${pin ? `${pin.template}@${pin.version}` : 'none'}:${meta.reasonCode}:${meta.actor}`);
  }
  async listConversations(tid: string): Promise<Page<ConversationRecord>> {
    const m = this.convs.get(tid) ?? new Map();
    return { items: [...m.entries()].map(([k, key]) => ({ conversationId: k.split('#')[1]!, startedAt: k.split('#')[0]!, hasTranscript: !!key })) };
  }
  async getTranscriptKey(tid: string, start: string, id: string) {
    const m = this.convs.get(tid);
    if (!m || !m.has(`${start}#${id}`)) return undefined;
    return { key: m.get(`${start}#${id}`) };
  }
  async readObject(key: string) { this.calls.push(`readObject:${key}`); return this.objects.get(key); }
  async exportTenant(tid: string, exportId: string) {
    this.calls.push(`export:${tid}`);
    const key = `tenants/${tid}/exports/${exportId}.json`;
    this.objects.set(key, JSON.stringify({ tenantId: tid, items: [{ PK: `TENANT#${tid}`, SK: 'PROFILE' }] }));
    return { key, itemCount: 1 };
  }
  async deleteTenant(tid: string) {
    this.calls.push(`delete:${tid}`);
    if (this.failDelete) throw new Error('boom');
    this.deleted.push(tid);
    this.profiles.delete(tid);
    return { items: 12, objects: 3, routes: 2 };
  }
}

function makeDeps(over: Partial<ConsoleDeps> = {}) {
  const store = new FakeStore();
  store.profiles.set(TID, { tenantId: TID, name: 'Kemi Cuts', type: 'barber', timezone: 'Europe/London', state: 'active', engine: 'livekit-telnyx', engineRef: `frontdesk:${TID}`, templateVersion: '1.2.0', numbers: ['+442071234567'], channels: { telegram: { botToken: 'SECRET' } } });
  store.profiles.set(OTHER, { tenantId: OTHER, name: 'Other Co', state: 'active', engine: 'livekit-telnyx', engineRef: `frontdesk:${OTHER}` });
  const audits: AuditEntry[] = [];
  const events: EventEnvelope[] = [];
  const engineCalls: string[] = [];
  const engine = { id: 'livekit-telnyx', setTenantState: async (ref: EngineAgentRef, s: TenantRuntimeState) => { engineCalls.push(`${ref.tenantId}:${s}`); } } as unknown as VoiceEngine;
  let n = 0;
  const deps: ConsoleDeps = {
    store,
    audit: async (e) => { audits.push(e); },
    emit: async (e) => { events.push(e); },
    engineFor: () => engine,
    now: () => new Date('2026-10-03T12:00:00.000Z'),
    newId: () => `id${++n}`,
    ...over,
  };
  return { deps, store, audits, events, engineCalls };
}

function req(method: string, path: string, opts: { body?: unknown; query?: Record<string, string>; actor?: string | null } = {}): ConsoleEvent {
  const actor = opts.actor === undefined ? ACTOR : opts.actor;
  return {
    rawPath: path,
    queryStringParameters: opts.query,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    requestContext: { requestId: 'req-1', http: { method }, authorizer: actor ? { iam: { userArn: actor } } : undefined },
  };
}
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>;

// ───────────────────────── tests ─────────────────────────
describe('console auth and actor', () => {
  it('rejects a request with no IAM identity', async () => {
    const { deps } = makeDeps();
    const r = await handle(req('GET', '/console/tenants', { actor: null }), deps);
    expect(r.statusCode).toBe(401);
  });

  it('takes the actor from the IAM caller, never from the body', async () => {
    const { deps, audits } = makeDeps();
    const r = await handle(req('POST', `/console/tenants/${TID}/suspend`, { body: { reasonCode: 'billing', actor: 'arn:evil', tenantId: OTHER } }), deps);
    expect(r.statusCode).toBe(200);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe(ACTOR);
    expect(audits[0]!.tenantId).toBe(TID);
  });

  it('answers unknown routes with 404 and wrong verbs with 405', async () => {
    const { deps } = makeDeps();
    expect((await handle(req('GET', '/console/nope'), deps)).statusCode).toBe(404);
    expect((await handle(req('DELETE', `/console/tenants/${TID}`), deps)).statusCode).toBe(405);
  });

  it('rejects malformed tenant ids before touching the store', async () => {
    const { deps, store } = makeDeps();
    const r = await handle(req('GET', '/console/tenants/TENANT%23x'), deps);
    expect(r.statusCode).toBe(400);
    expect(store.calls).toEqual([]);
  });
});

describe('reads', () => {
  it('lists tenants without secrets or raw phone numbers', async () => {
    const { deps } = makeDeps();
    const r = await handle(req('GET', '/console/tenants', { query: { limit: '10' } }), deps);
    expect(r.statusCode).toBe(200);
    const body = json(r);
    expect(body.items.map((t: any) => t.tenantId).sort()).toEqual([TID, OTHER]);
    expect(r.body).not.toContain('SECRET');
    expect(r.body).not.toContain('+442071234567');
  });

  it('returns one tenant with usage and 404 for a missing one', async () => {
    const { deps, store } = makeDeps();
    store.usage.set(TID, [{ month: '2026-10', billableSeconds: 1200 }, { month: '2026-09', billableSeconds: 5400 }]);
    const r = await handle(req('GET', `/console/tenants/${TID}`), deps);
    expect(json(r).tenant).toMatchObject({ tenantId: TID, name: 'Kemi Cuts', state: 'active', templateVersion: '1.2.0' });
    expect(json(r).usage).toHaveLength(2);
    expect((await handle(req('GET', '/console/tenants/t_missing001'), deps)).statusCode).toBe(404);
  });

  it('lists conversations as metadata only', async () => {
    const { deps, store } = makeDeps();
    store.convs.set(TID, new Map([[`${START}#c1`, `tenants/${TID}/transcripts/c1.json`]]));
    const r = await handle(req('GET', `/console/tenants/${TID}/conversations`), deps);
    expect(json(r).items).toEqual([{ conversationId: 'c1', startedAt: START, hasTranscript: true }]);
  });
});

describe('every write needs a reason code and an actor', () => {
  const writes: Array<[string, string, unknown]> = [
    ['POST', `/console/tenants/${TID}/suspend`, {}],
    ['POST', `/console/tenants/${TID}/resume`, {}],
    ['PUT', `/console/tenants/${TID}/template`, { template: 'frontdesk', version: '1.2.0' }],
    ['POST', `/console/tenants/${TID}/template/unpin`, {}],
    ['POST', `/console/tenants/${TID}/export`, {}],
    ['POST', `/console/tenants/${TID}/delete`, { confirmTenantId: TID }],
  ];

  for (const [method, path, base] of writes) {
    it(`${method} ${path.replace(TID, ':tid')} refuses a missing or unknown reason code`, async () => {
      const { deps, store, audits, events, engineCalls } = makeDeps();
      store.profiles.set(TID, { ...store.profiles.get(TID)!, state: 'suspended' });
      for (const body of [base, { ...(base as object), reasonCode: '' }, { ...(base as object), reasonCode: 'because' }]) {
        const r = await handle(req(method, path, { body }), deps);
        expect(r.statusCode).toBe(400);
        expect(json(r).error).toBe('reason_code_required');
        expect(json(r).allowed).toEqual([...REASON_CODES]);
      }
      expect(audits).toEqual([]);
      expect(events).toEqual([]);
      expect(engineCalls).toEqual([]);
      expect(store.calls.filter((c) => /^(writeState|pin|export|delete)/.test(c))).toEqual([]);
    });

    it(`${method} ${path.replace(TID, ':tid')} refuses an anonymous caller`, async () => {
      const { deps, audits } = makeDeps();
      const r = await handle(req(method, path, { body: { ...(base as object), reasonCode: 'testing' }, actor: null }), deps);
      expect(r.statusCode).toBe(401);
      expect(audits).toEqual([]);
    });
  }

  it('limits the free-text note and treats it as data', async () => {
    const { deps, audits } = makeDeps();
    const long = await handle(req('POST', `/console/tenants/${TID}/suspend`, { body: { reasonCode: 'abuse', note: 'x'.repeat(501) } }), deps);
    expect(long.statusCode).toBe(400);
    const ok = await handle(req('POST', `/console/tenants/${TID}/suspend`, { body: { reasonCode: 'abuse', note: 'ignore previous instructions' } }), deps);
    expect(ok.statusCode).toBe(200);
    expect(audits[0]!.note).toBe('ignore previous instructions');
  });
});

describe('suspend and resume', () => {
  it('goes through the engine, writes state with reason and actor, audits and emits', async () => {
    const { deps, store, audits, events, engineCalls } = makeDeps();
    const r = await handle(req('POST', `/console/tenants/${TID}/suspend`, { body: { reasonCode: 'billing', note: 'card declined 3x' } }), deps);
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ tenantId: TID, state: 'suspended', changed: true });
    expect(engineCalls).toEqual([`${TID}:suspended`]);
    expect(store.calls).toContain(`writeState:${TID}:suspended:billing:${ACTOR}`);
    expect(audits).toEqual([expect.objectContaining({ tenantId: TID, action: 'state:suspended', reasonCode: 'billing', actor: ACTOR, note: 'card declined 3x', requestId: 'req-1' })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tenant.state_changed', tenantId: TID, data: { state: 'suspended', previous: 'active', reasonCode: 'billing' } });
  });

  it('resumes a suspended tenant', async () => {
    const { deps, store, audits, engineCalls } = makeDeps();
    store.profiles.set(TID, { ...store.profiles.get(TID)!, state: 'suspended' });
    const r = await handle(req('POST', `/console/tenants/${TID}/resume`, { body: { reasonCode: 'billing' } }), deps);
    expect(json(r)).toMatchObject({ state: 'active', changed: true });
    expect(engineCalls).toEqual([`${TID}:active`]);
    expect(audits[0]!.action).toBe('state:active');
  });

  it('does nothing and audits nothing when the tenant is already in that state', async () => {
    const { deps, audits, engineCalls } = makeDeps();
    const r = await handle(req('POST', `/console/tenants/${TID}/resume`, { body: { reasonCode: 'billing' } }), deps);
    expect(json(r)).toMatchObject({ state: 'active', changed: false });
    expect(audits).toEqual([]);
    expect(engineCalls).toEqual([]);
  });

  it('404s for an unknown tenant and 502s when the engine fails (no state written)', async () => {
    const { deps, store } = makeDeps({ engineFor: () => ({ setTenantState: async () => { throw new Error('engine down'); } }) as unknown as VoiceEngine });
    expect((await handle(req('POST', '/console/tenants/t_missing001/suspend', { body: { reasonCode: 'abuse' } }), deps)).statusCode).toBe(404);
    const r = await handle(req('POST', `/console/tenants/${TID}/suspend`, { body: { reasonCode: 'abuse' } }), deps);
    expect(r.statusCode).toBe(502);
    expect(store.calls.some((c) => c.startsWith('writeState'))).toBe(false);
  });
});

describe('template pinning', () => {
  it('pins an existing, non-retired version', async () => {
    const { deps, store, audits } = makeDeps();
    const r = await handle(req('PUT', `/console/tenants/${TID}/template`, { body: { template: 'frontdesk', version: '1.3.0-rc1', reasonCode: 'support_case' } }), deps);
    expect(r.statusCode).toBe(200);
    expect(store.calls).toContain(`pin:${TID}:frontdesk@1.3.0-rc1:support_case:${ACTOR}`);
    expect(audits[0]).toMatchObject({ action: 'template:pin', actor: ACTOR, detail: { template: 'frontdesk', version: '1.3.0-rc1' } });
  });

  it('rejects unknown, retired and malformed versions', async () => {
    const { deps, store, audits } = makeDeps();
    for (const version of ['9.9.9', '0.9.0', 'latest']) {
      const r = await handle(req('PUT', `/console/tenants/${TID}/template`, { body: { template: 'frontdesk', version, reasonCode: 'testing' } }), deps);
      expect([400, 404, 409]).toContain(r.statusCode);
    }
    expect(store.calls.some((c) => c.startsWith('pin'))).toBe(false);
    expect(audits).toEqual([]);
  });

  it('unpins and audits', async () => {
    const { deps, store, audits } = makeDeps();
    const r = await handle(req('POST', `/console/tenants/${TID}/template/unpin`, { body: { reasonCode: 'testing' } }), deps);
    expect(r.statusCode).toBe(200);
    expect(store.calls).toContain(`pin:${TID}:none:testing:${ACTOR}`);
    expect(audits[0]!.action).toBe('template:unpin');
  });

  it('does not pin when the audit write fails', async () => {
    const { deps, store } = makeDeps({ audit: async () => { throw new Error('audit down'); } });
    const r = await handle(req('PUT', `/console/tenants/${TID}/template`, { body: { template: 'frontdesk', version: '1.2.0', reasonCode: 'testing' } }), deps);
    expect(r.statusCode).toBe(500);
    expect(store.calls.some((c) => c.startsWith('pin'))).toBe(false);
  });

  it('lists the versions a tenant could be pinned to', async () => {
    const { deps } = makeDeps();
    const r = await handle(req('GET', '/console/templates/frontdesk'), deps);
    expect(json(r).versions.map((v: any) => v.version)).toEqual(['1.2.0', '1.3.0-rc1', '0.9.0']);
  });
});

describe('transcripts need a support case', () => {
  const tpath = `/console/tenants/${TID}/conversations/${encodeURIComponent(START)}/c1/transcript`;
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    ctx = makeDeps();
    ctx.store.convs.set(TID, new Map([[`${START}#c1`, `tenants/${TID}/transcripts/c1.json`]]));
    ctx.store.objects.set(`tenants/${TID}/transcripts/c1.json`, JSON.stringify([{ role: 'caller', text: 'Hi, can I book Friday?' }]));
  });

  it('refuses without a support case id and never reads the object', async () => {
    const r = await handle(req('GET', tpath), ctx.deps);
    expect(r.statusCode).toBe(403);
    expect(json(r).error).toBe('support_case_required');
    expect(ctx.store.calls.some((c) => c.startsWith('readObject'))).toBe(false);
    expect(ctx.audits[0]).toMatchObject({ action: 'transcript:read_denied', actor: ACTOR, tenantId: TID });
  });

  it('refuses a malformed support case id', async () => {
    for (const id of ['', ' ', 'x', 'drop table', 'a'.repeat(100)]) {
      const r = await handle(req('GET', tpath, { query: { supportCaseId: id } }), ctx.deps);
      expect(r.statusCode).toBe(403);
    }
    expect(ctx.store.calls.some((c) => c.startsWith('readObject'))).toBe(false);
  });

  it('returns the transcript as data and audits the read with case and actor', async () => {
    const r = await handle(req('GET', tpath, { query: { supportCaseId: 'SUP-1042' } }), ctx.deps);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(json(r).transcript).toEqual([{ role: 'caller', text: 'Hi, can I book Friday?' }]);
    expect(ctx.audits).toEqual([expect.objectContaining({ action: 'transcript:read', reasonCode: 'support_case', supportCaseId: 'SUP-1042', actor: ACTOR, tenantId: TID })]);
  });

  it('does not read when the audit write fails', async () => {
    const d = makeDeps({ audit: async () => { throw new Error('audit down'); } });
    d.store.convs.set(TID, new Map([[`${START}#c1`, `tenants/${TID}/transcripts/c1.json`]]));
    const r = await handle(req('GET', tpath, { query: { supportCaseId: 'SUP-1042' } }), d.deps);
    expect(r.statusCode).toBe(500);
    expect(d.store.calls.some((c) => c.startsWith('readObject'))).toBe(false);
  });

  it("will not serve another tenant's conversation or an object outside this tenant's prefix", async () => {
    ctx.store.convs.set(OTHER, new Map([[`${START}#c9`, `tenants/${OTHER}/transcripts/c9.json`]]));
    const cross = await handle(req('GET', `/console/tenants/${TID}/conversations/${encodeURIComponent(START)}/c9/transcript`, { query: { supportCaseId: 'SUP-1' + '042' } }), ctx.deps);
    expect(cross.statusCode).toBe(404);
    ctx.store.convs.set(TID, new Map([[`${START}#c2`, `tenants/${OTHER}/transcripts/c9.json`]]));
    const escape = await handle(req('GET', `/console/tenants/${TID}/conversations/${encodeURIComponent(START)}/c2/transcript`, { query: { supportCaseId: 'SUP-1042' } }), ctx.deps);
    expect(escape.statusCode).toBe(403);
    expect(ctx.store.calls.some((c) => c === `readObject:tenants/${OTHER}/transcripts/c9.json`)).toBe(false);
  });

  it('404s when the conversation has no transcript', async () => {
    ctx.store.convs.set(TID, new Map([[`${START}#c3`, undefined]]));
    const r = await handle(req('GET', `/console/tenants/${TID}/conversations/${encodeURIComponent(START)}/c3/transcript`, { query: { supportCaseId: 'SUP-1042' } }), ctx.deps);
    expect(r.statusCode).toBe(404);
  });
});

describe('export', () => {
  it('writes an export, audits first, and returns the key (not the data)', async () => {
    const { deps, audits } = makeDeps();
    const r = await handle(req('POST', `/console/tenants/${TID}/export`, { body: { reasonCode: 'owner_request' } }), deps);
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ tenantId: TID, exportId: 'id1', key: `tenants/${TID}/exports/id1.json`, itemCount: 1 });
    expect(audits[0]).toMatchObject({ action: 'tenant:export', reasonCode: 'owner_request', actor: ACTOR });
  });

  it('downloads an export only with a support case id', async () => {
    const { deps, store } = makeDeps();
    await handle(req('POST', `/console/tenants/${TID}/export`, { body: { reasonCode: 'owner_request' } }), deps);
    const no = await handle(req('GET', `/console/tenants/${TID}/exports/id1`), deps);
    expect(no.statusCode).toBe(403);
    const yes = await handle(req('GET', `/console/tenants/${TID}/exports/id1`, { query: { supportCaseId: 'SUP-77' } }), deps);
    expect(yes.statusCode).toBe(200);
    expect(json(yes).export.tenantId).toBe(TID);
    expect(store.calls.filter((c) => c.startsWith('readObject'))).toEqual([`readObject:tenants/${TID}/exports/id1.json`]);
  });

  it('rejects export ids that try to climb out of the exports folder', async () => {
    const { deps } = makeDeps();
    const r = await handle(req('GET', `/console/tenants/${TID}/exports/..%2F..%2Ftranscripts%2Fc1`, { query: { supportCaseId: 'SUP-77' } }), deps);
    expect(r.statusCode).toBe(400);
  });
});

describe('delete', () => {
  it('needs the tenant id typed back and a suspended tenant', async () => {
    const { deps, store } = makeDeps();
    const wrong = await handle(req('POST', `/console/tenants/${TID}/delete`, { body: { reasonCode: 'owner_request', confirmTenantId: OTHER } }), deps);
    expect(wrong.statusCode).toBe(400);
    const active = await handle(req('POST', `/console/tenants/${TID}/delete`, { body: { reasonCode: 'owner_request', confirmTenantId: TID } }), deps);
    expect(active.statusCode).toBe(409);
    expect(json(active).error).toBe('suspend_first');
    expect(store.deleted).toEqual([]);
  });

  it('records intent before deleting and the result after', async () => {
    const { deps, store, audits } = makeDeps();
    store.profiles.set(TID, { ...store.profiles.get(TID)!, state: 'suspended' });
    const order: string[] = [];
    const audit = deps.audit;
    deps.audit = async (e) => { order.push(`audit:${e.action}`); await audit(e); };
    const del = store.deleteTenant.bind(store);
    store.deleteTenant = async (...a) => { order.push('delete'); return del(...a); };
    const r = await handle(req('POST', `/console/tenants/${TID}/delete`, { body: { reasonCode: 'owner_request', confirmTenantId: TID } }), deps);
    expect(r.statusCode).toBe(200);
    expect(order).toEqual(['audit:tenant:delete_requested', 'delete', 'audit:tenant:deleted']);
    expect(json(r)).toMatchObject({ tenantId: TID, deleted: { items: 12, objects: 3, routes: 2 } });
    expect(json(r).numbersToRelease).toHaveLength(1);
    expect(r.body).not.toContain('+442071234567');
    expect(audits.every((a) => a.actor === ACTOR && a.reasonCode === 'owner_request')).toBe(true);
  });

  it('deletes nothing when the intent cannot be audited', async () => {
    const { deps, store } = makeDeps({ audit: async () => { throw new Error('audit down'); } });
    store.profiles.set(TID, { ...store.profiles.get(TID)!, state: 'suspended' });
    const r = await handle(req('POST', `/console/tenants/${TID}/delete`, { body: { reasonCode: 'owner_request', confirmTenantId: TID } }), deps);
    expect(r.statusCode).toBe(500);
    expect(store.deleted).toEqual([]);
  });

  it('reports a partial failure so the call can be repeated', async () => {
    const { deps, store } = makeDeps();
    store.profiles.set(TID, { ...store.profiles.get(TID)!, state: 'suspended' });
    store.failDelete = true;
    const r = await handle(req('POST', `/console/tenants/${TID}/delete`, { body: { reasonCode: 'owner_request', confirmTenantId: TID } }), deps);
    expect(r.statusCode).toBe(500);
  });
});

// ───────────────────────── DynamoDB store ─────────────────────────
describe('DdbConsoleStore keeps every call inside one tenant', () => {
  type Cmd = { constructor: { name: string }; input: any };
  function fakeClients(items: Array<Record<string, any>>) {
    const sent: Cmd[] = [];
    const ddb = {
      send: async (cmd: Cmd) => {
        sent.push(cmd);
        const name = cmd.constructor.name;
        if (name === 'QueryCommand') {
          const pk = cmd.input.ExpressionAttributeValues[':pk'];
          return { Items: items.filter((i) => i.PK === pk), LastEvaluatedKey: undefined };
        }
        if (name === 'GetCommand') return { Item: items.find((i) => i.PK === cmd.input.Key.PK && i.SK === cmd.input.Key.SK) };
        if (name === 'ScanCommand') return { Items: items.filter((i) => i.SK === 'PROFILE') };
        return {};
      },
    };
    const s3calls: Cmd[] = [];
    const s3 = {
      send: async (cmd: Cmd) => {
        s3calls.push(cmd);
        if (cmd.constructor.name === 'ListObjectsV2Command') return { Contents: [{ Key: `tenants/${TID}/kb/a.txt` }], IsTruncated: false };
        return {};
      },
    };
    return { ddb, s3, sent, s3calls };
  }
  const data = [
    { PK: `TENANT#${TID}`, SK: 'PROFILE', name: 'Kemi Cuts', numbers: ['+442071234567'], engine: 'livekit-telnyx', engineRef: `frontdesk:${TID}` },
    { PK: `TENANT#${TID}`, SK: 'IDEMP#abc', response: 'x' },
    { PK: `TENANT#${TID}`, SK: `CONV#${START}#c1`, channel: 'voice', transcriptKey: `tenants/${TID}/transcripts/c1.json` },
    { PK: `TENANT#${OTHER}`, SK: 'PROFILE', name: 'Other' },
    { PK: 'NUMBER#+442071234567', SK: 'ROUTE', tid: TID },
    { PK: `ENGINEAGENT#livekit-telnyx#frontdesk:${TID}`, SK: 'ROUTE', tid: TID },
  ];

  it('leaves a route alone when it now belongs to another tenant', async () => {
    const moved = data.map((d) => (d.PK === 'NUMBER#+442071234567' ? { ...d, tid: OTHER } : d));
    const { ddb, s3, sent } = fakeClients(moved);
    const store = new DdbConsoleStore({ ddb: ddb as any, s3: s3 as any, table: 't', tenantBucket: 'b' });
    const res = await store.deleteTenant(TID, data[0]!);
    const keysDeleted = sent.filter((c) => c.constructor.name === 'BatchWriteCommand').flatMap((c) => c.input.RequestItems.t.map((r: any) => r.DeleteRequest.Key.PK));
    expect(keysDeleted).not.toContain('NUMBER#+442071234567');
    expect(res.routes).toBe(1);
  });

  it('queries only the tenant partition and refuses a cursor from another partition', async () => {
    const { ddb, s3, sent } = fakeClients(data);
    const store = new DdbConsoleStore({ ddb: ddb as any, s3: s3 as any, table: 't', tenantBucket: 'b' });
    await store.listConversations(TID, { limit: 10 });
    expect(sent[0]!.input.ExpressionAttributeValues[':pk']).toBe(`TENANT#${TID}`);
    const evil = Buffer.from(JSON.stringify({ PK: `TENANT#${OTHER}`, SK: 'CONV#x' })).toString('base64url');
    await expect(store.listConversations(TID, { limit: 10, cursor: evil })).rejects.toThrow(/cursor/);
  });

  it('exports without idempotency items and writes under the tenant exports prefix', async () => {
    const { ddb, s3, s3calls } = fakeClients(data);
    const store = new DdbConsoleStore({ ddb: ddb as any, s3: s3 as any, table: 't', tenantBucket: 'b' });
    const out = await store.exportTenant(TID, 'e1');
    expect(out).toEqual({ key: `tenants/${TID}/exports/e1.json`, itemCount: 2 });
    const put = s3calls.find((c) => c.constructor.name === 'PutObjectCommand')!;
    expect(put.input.Key).toBe(`tenants/${TID}/exports/e1.json`);
    expect(String(put.input.Body)).not.toContain('IDEMP#');
    expect(String(put.input.Body)).not.toContain(OTHER);
  });

  it('deletes only this tenant and removes the profile last', async () => {
    const { ddb, s3, sent, s3calls } = fakeClients(data);
    const store = new DdbConsoleStore({ ddb: ddb as any, s3: s3 as any, table: 't', tenantBucket: 'b' });
    const res = await store.deleteTenant(TID, data[0]!);
    const writes = sent.filter((c) => c.constructor.name === 'BatchWriteCommand').flatMap((c) => c.input.RequestItems.t.map((r: any) => r.DeleteRequest.Key));
    expect(writes.length).toBeGreaterThan(0);
    for (const k of writes) expect([`TENANT#${TID}`, `NUMBER#+442071234567`, `ENGINEAGENT#livekit-telnyx#frontdesk:${TID}`]).toContain(k.PK);
    const tenantKeys = writes.filter((k: any) => k.PK === `TENANT#${TID}`);
    expect(tenantKeys[tenantKeys.length - 1]!.SK).toBe('PROFILE');
    expect(res.routes).toBe(2);
    const list = s3calls.find((c) => c.constructor.name === 'ListObjectsV2Command')!;
    expect(list.input.Prefix).toBe(`tenants/${TID}/`);
  });
});

describe('audit writer and engine wiring', () => {
  it('puts a checksummed object under the tenant and day', async () => {
    const puts: any[] = [];
    const entry: AuditEntry = { tenantId: TID, action: 'state:suspended', reasonCode: 'billing', actor: ACTOR, at: '2026-10-03T12:00:00.000Z' };
    await auditWriter({ send: async (c: any) => { puts.push(c.input); } } as any, 'audit-bucket')(entry);
    expect(puts[0].Bucket).toBe('audit-bucket');
    expect(puts[0].Key).toMatch(new RegExp(`^audit/2026/10/03/${TID}/`));
    expect(puts[0].ContentMD5).toBe(createHash('md5').update(puts[0].Body).digest('base64'));
    expect(JSON.parse(puts[0].Body)).toMatchObject({ actor: ACTOR, reasonCode: 'billing' });
    expect(auditKey(entry, 'x')).toMatch(/-x\.json$/);
  });

  it('propagates an audit put failure', async () => {
    await expect(auditWriter({ send: async () => { throw new Error('denied'); } } as any, 'b')({ tenantId: TID, action: 'a', reasonCode: 'testing', actor: ACTOR, at: '2026-10-03T12:00:00.000Z' })).rejects.toThrow('denied');
  });

  it('flips only routes the tenant owns and refuses engines that are not wired', async () => {
    const sent: any[] = [];
    const ddb = { send: async (c: any) => { sent.push(c.input); if (c.input.Key.PK === 'NUMBER#+442070000002') { const e = new Error('x'); e.name = 'ConditionalCheckFailedException'; throw e; } return {}; } };
    const store = { getProfile: async () => ({ numbers: ['+442071234567', '+442070000002'] }) } as unknown as ConsoleStore;
    const engineFor = consoleEngineFor({ ddb: ddb as any, table: 't', store });
    await engineFor({ engine: 'livekit-telnyx', tenantId: TID as any, agentId: 'a' }).setTenantState({ engine: 'livekit-telnyx', tenantId: TID as any, agentId: 'a' }, 'suspended');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ Key: { PK: 'NUMBER#+442071234567', SK: 'ROUTE' }, ExpressionAttributeValues: { ':s': 'suspended', ':tid': TID }, ConditionExpression: 'tid = :tid' });
    expect(() => engineFor({ engine: 'elevenlabs', tenantId: TID as any, agentId: 'a' })).toThrow(/not wired/);
  });
});
