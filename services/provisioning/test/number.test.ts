import { describe, expect, it } from 'vitest';
import { searchNumber } from '../src/steps/search-number.js';
import { bindEngine, ddbProfileBinder, ddbRouteStore, type ProfileBinder, type RouteStore } from '../src/steps/bind-engine.js';
import { loadTelnyxConfig, telnyxClient, TelnyxRejectedError, TelnyxTransientError } from '../src/lib/telnyx.js';

/**
 * Hand-written fixtures and fakes: nothing here was recorded from Telnyx and no request leaves the process.
 * Re-recording a real (free) search is an owner follow-up; until then the filter names are unverified.
 */
const HAND_WRITTEN_SEARCH_RESPONSE = {
  data: [
    { phone_number: '+12145550100', record_type: 'available_phone_number' },
    { phone_number: '+12145550101', record_type: 'available_phone_number' },
    { record_type: 'available_phone_number' },
  ],
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Telnyx client (fake fetch)', () => {
  it('search sends the area-code and state filters and parses numbers', async () => {
    const urls: string[] = [];
    const t = telnyxClient('KEY_PLACEHOLDER', (async (u: string) => { urls.push(String(u)); return json(200, HAND_WRITTEN_SEARCH_RESPONSE); }) as unknown as typeof fetch);
    const out = await t.searchLocal({ areaCode: '214', state: 'TX', limit: 3 });
    expect(out).toEqual(['+12145550100', '+12145550101']);
    const q = new URL(urls[0]!).searchParams;
    expect(q.get('filter[country_code]')).toBe('US');
    expect(q.get('filter[phone_number_type]')).toBe('local');
    expect(q.get('filter[national_destination_code]')).toBe('214');
    expect(q.get('filter[administrative_area]')).toBe('TX');
    expect(q.get('filter[limit]')).toBe('3');
  });

  it('classifies failures: 4xx rejected, 429/5xx/network transient; errors never carry the key', async () => {
    const mk = (f: () => Promise<Response>) => telnyxClient('SECRET_KEY_VALUE', f as unknown as typeof fetch);
    const e422 = await mk(async () => json(422, { errors: [] })).order('+12145550100', 'c', 'r').catch((e) => e);
    expect(e422).toBeInstanceOf(TelnyxRejectedError);
    expect(await mk(async () => json(429, {})).order('+1', 'c', 'r').catch((e) => e)).toBeInstanceOf(TelnyxTransientError);
    expect(await mk(async () => json(503, {})).order('+1', 'c', 'r').catch((e) => e)).toBeInstanceOf(TelnyxTransientError);
    const net = await mk(async () => { throw new Error('socket hang up SECRET_KEY_VALUE'); }).searchLocal({}).catch((e) => e);
    expect(net).toBeInstanceOf(TelnyxTransientError);
    expect(String(e422.message)).not.toContain('SECRET_KEY_VALUE');
  });

  it('order carries the connection and our customer_reference', async () => {
    let body: Record<string, unknown> = {};
    const t = telnyxClient('k', (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return json(201, { data: { id: 'ord1', status: 'pending' } }); }) as unknown as typeof fetch);
    expect(await t.order('+12145550100', 'conn_1', 'onb:o1')).toEqual({ orderId: 'ord1', status: 'pending' });
    expect(body).toEqual({ phone_numbers: [{ phone_number: '+12145550100' }], connection_id: 'conn_1', customer_reference: 'onb:o1' });
  });

  it('findOrderByReference ignores failed orders', async () => {
    const t = telnyxClient('k', (async () => json(200, { data: [{ id: 'a', status: 'failure' }, { id: 'b', status: 'success', phone_numbers: [{ phone_number: '+12145550100' }] }] })) as unknown as typeof fetch);
    expect(await t.findOrderByReference('onb:o1')).toEqual({ orderId: 'b', status: 'success', numbers: ['+12145550100'] });
    const none = telnyxClient('k', (async () => json(200, { data: [{ id: 'a', status: 'failure' }] })) as unknown as typeof fetch);
    expect(await none.findOrderByReference('onb:o1')).toBeUndefined();
  });

  it('assignToConnection patches the number, skips when already assigned, retries while the number is not there yet', async () => {
    const calls: Array<[string, string]> = [];
    let phoneNumbers: unknown[] = [{ id: 'pn1', connection_id: 'old' }];
    const f = (async (u: string, init: RequestInit) => { calls.push([init.method ?? 'GET', new URL(u).pathname]); return init.method === 'PATCH' ? json(200, { data: {} }) : json(200, { data: phoneNumbers }); }) as unknown as typeof fetch;
    const t = telnyxClient('k', f);
    await t.assignToConnection('+12145550100', 'conn_1');
    expect(calls).toEqual([['GET', '/v2/phone_numbers'], ['PATCH', '/v2/phone_numbers/pn1']]);
    calls.length = 0; phoneNumbers = [{ id: 'pn1', connection_id: 'conn_1' }];
    await t.assignToConnection('+12145550100', 'conn_1');
    expect(calls).toEqual([['GET', '/v2/phone_numbers']]);
    phoneNumbers = [];
    await expect(t.assignToConnection('+12145550100', 'conn_1')).rejects.toBeInstanceOf(TelnyxTransientError);
  });

  it('findOwnedNumber (SEC-18) answers from the account list, matches the exact number, and treats a failed lookup as transient, never as "not owned"', async () => {
    const urls: string[] = [];
    let rows: unknown[] = [{ id: 'pn9', phone_number: '+12145550100' }];
    const t = telnyxClient('k', (async (u: string) => { urls.push(String(u)); return json(200, { data: rows }); }) as unknown as typeof fetch);
    expect(await t.findOwnedNumber('+12145550100')).toEqual({ id: 'pn9' });
    expect(new URL(urls[0]!).pathname).toBe('/v2/phone_numbers');
    expect(new URL(urls[0]!).searchParams.get('filter[phone_number]')).toBe('+12145550100');
    rows = [{ id: 'pn8', phone_number: '+12145550199' }];            // a filter that matches loosely must not adopt another number
    expect(await t.findOwnedNumber('+12145550100')).toBeUndefined();
    rows = [];
    expect(await t.findOwnedNumber('+12145550100')).toBeUndefined();
    const down = telnyxClient('k', (async () => json(503, {})) as unknown as typeof fetch);
    await expect(down.findOwnedNumber('+12145550100')).rejects.toBeInstanceOf(TelnyxTransientError);
  });

  it('assignToConnection never points a different number at our connection', async () => {
    const calls: string[] = [];
    const f = (async (u: string, init: RequestInit) => { calls.push(init.method ?? 'GET'); return json(200, { data: [{ id: 'pn_other', phone_number: '+12145550199', connection_id: 'old' }] }); }) as unknown as typeof fetch;
    await expect(telnyxClient('k', f).assignToConnection('+12145550100', 'conn_1')).rejects.toBeInstanceOf(TelnyxTransientError);
    expect(calls).toEqual(['GET']);
  });
});

describe('loadTelnyxConfig: the stage runtime secret', () => {
  it('needs a secret id (a name or an ARN) and says so plainly', async () => {
    await expect(loadTelnyxConfig({} as NodeJS.ProcessEnv)).rejects.toThrow(/TELNYX_SECRET_ID/);
  });
});

describe('searchNumber: area code then state fallback', () => {
  const fakeSearch = (byScope: Record<string, string[]>) => {
    const calls: Array<{ areaCode?: string; state?: string; locality?: string }> = [];
    return { calls, telnyx: { searchLocal: async (p: { areaCode?: string; state?: string; locality?: string }) => { calls.push(p); return byScope[p.areaCode ? `ac:${p.areaCode}` : `st:${p.state}`] ?? []; } } };
  };
  const base = { onboardingId: 'onb_1', tenantId: 't_abcdefgh1' };

  it('uses the area code when it has stock and never searches wider', async () => {
    const f = fakeSearch({ 'ac:214': ['+12145550100', '+12145550101'], 'st:TX': ['+18175550100'] });
    const r = await searchNumber({ ...base, area: { areaCode: '214', state: 'TX' } }, { telnyx: f.telnyx });
    expect(r).toEqual({ candidates: ['+12145550100', '+12145550101'], matchedOn: 'area_code' });
    expect(f.calls).toHaveLength(1);
  });

  it('falls back to the state when the area code has nothing', async () => {
    const f = fakeSearch({ 'st:TX': ['+18175550100'] });
    const r = await searchNumber({ ...base, area: { areaCode: '214', state: 'tx' } }, { telnyx: f.telnyx });
    expect(r).toEqual({ candidates: ['+18175550100'], matchedOn: 'state' });
    expect(f.calls.map((c) => [c.areaCode, c.state])).toEqual([['214', undefined], [undefined, 'TX']]);
  });

  it('goes straight to the state when there is no area code', async () => {
    const f = fakeSearch({ 'st:TX': ['+18175550100'] });
    expect((await searchNumber({ ...base, area: { state: 'TX' } }, { telnyx: f.telnyx })).matchedOn).toBe('state');
    expect(f.calls).toHaveLength(1);
  });

  it('treats owner-typed area text as data: junk is dropped, never sent to Telnyx', async () => {
    const f = fakeSearch({ 'st:TX': ['+18175550100'] });
    const r = await searchNumber({ ...base, area: { areaCode: "214'; DROP", state: 'TX' } }, { telnyx: f.telnyx });
    expect(f.calls.every((c) => c.areaCode === undefined)).toBe(true);
    expect(r.matchedOn).toBe('state');
  });

  it('keeps only well-formed US numbers, deduped', async () => {
    const f = fakeSearch({ 'ac:214': ['+12145550100', '+12145550100', '12145550101', '+442071234567', '+12145550102'] });
    const r = await searchNumber({ ...base, area: { areaCode: '214' } }, { telnyx: f.telnyx });
    expect(r.candidates).toEqual(['+12145550100', '+12145550102']);
  });

  it('nothing anywhere: NoNumberAvailable (not retried, the workflow handles it)', async () => {
    const f = fakeSearch({});
    const err = await searchNumber({ ...base, area: { areaCode: '214', state: 'TX' } }, { telnyx: f.telnyx }).catch((e: Error) => e);
    expect((err as Error).name).toBe('NoNumberAvailable');
  });

  it('no usable area at all: NoNumberAvailable without calling Telnyx', async () => {
    const f = fakeSearch({});
    const err = await searchNumber({ ...base, area: {} }, { telnyx: f.telnyx }).catch((e: Error) => e);
    expect((err as Error).name).toBe('NoNumberAvailable');
    expect(f.calls).toHaveLength(0);
  });
});

describe('bindEngine: routes and connection', () => {
  function fakes() {
    const log: string[] = [];
    const numberRoutes = new Map<string, { tid: string; engine: string; state: string }>();
    const agentRoutes = new Map<string, { tid: string }>();
    const routes: RouteStore = {
      putNumberRoute: async (number, r) => { log.push('number-route'); const cur = numberRoutes.get(number); if (cur && cur.tid !== r.tid) throw new Error('RouteConflict'); numberRoutes.set(number, r); },
      putEngineAgentRoute: async (engine, agentId, r) => { log.push('agent-route'); agentRoutes.set(`${engine}#${agentId}`, r); },
    };
    const telnyx = { assignToConnection: async (n: string, c: string) => { log.push(`assign:${n}:${c}`); } };
    return { log, numberRoutes, agentRoutes, routes, telnyx };
  }
  const input = { onboardingId: 'onb_1', tenantId: 't_abcdefgh1', number: '+12145550100', connectionId: 'conn_1' };

  it('assigns the number to the LiveKit connection, then writes NUMBER# and ENGINEAGENT# routes', async () => {
    const f = fakes();
    const out = await bindEngine(input, { telnyx: f.telnyx, routes: f.routes });
    expect(f.log).toEqual(['assign:+12145550100:conn_1', 'number-route', 'agent-route']);
    expect(f.numberRoutes.get('+12145550100')).toEqual({ tid: 't_abcdefgh1', engine: 'livekit-telnyx', state: 'active' });
    expect(f.agentRoutes.get('livekit-telnyx#frontdesk:t_abcdefgh1')).toEqual({ tid: 't_abcdefgh1' });
    expect(out).toEqual({ number: '+12145550100', engine: 'livekit-telnyx', agentId: 'frontdesk:t_abcdefgh1' });
  });

  it('is safe to run twice', async () => {
    const f = fakes();
    await bindEngine(input, { telnyx: f.telnyx, routes: f.routes });
    await expect(bindEngine(input, { telnyx: f.telnyx, routes: f.routes })).resolves.toMatchObject({ number: '+12145550100' });
    expect(f.numberRoutes.size).toBe(1);
  });

  it('never takes over a number routed to another tenant', async () => {
    const f = fakes();
    f.numberRoutes.set('+12145550100', { tid: 't_zzzzzzzz9', engine: 'livekit-telnyx', state: 'active' });
    await expect(bindEngine(input, { telnyx: f.telnyx, routes: f.routes })).rejects.toThrow('RouteConflict');
    expect(f.numberRoutes.get('+12145550100')!.tid).toBe('t_zzzzzzzz9');
  });

  it('rejects a malformed tenant id or number before any side effect', async () => {
    const f = fakes();
    await expect(bindEngine({ ...input, tenantId: 'not-a-tenant' }, { telnyx: f.telnyx, routes: f.routes })).rejects.toThrow();
    await expect(bindEngine({ ...input, number: '2145550100' }, { telnyx: f.telnyx, routes: f.routes })).rejects.toThrow();
    expect(f.log).toEqual([]);
  });

  it('records the engine reference on the tenant PROFILE, after the routes, so render and the console find the same agent', async () => {
    const f = fakes();
    const calls: unknown[] = [];
    const profile: ProfileBinder = { recordBinding: async (a) => { f.log.push('profile'); calls.push(a); } };
    const basics = { businessName: 'Kemi Cuts', businessType: 'barbershop' };
    await bindEngine({ ...input, basics }, { telnyx: f.telnyx, routes: f.routes, profile });
    expect(f.log).toEqual(['assign:+12145550100:conn_1', 'number-route', 'agent-route', 'profile']);
    expect(calls).toEqual([{ tenantId: 't_abcdefgh1', onboardingId: 'onb_1', number: '+12145550100', engine: 'livekit-telnyx', agentId: 'frontdesk:t_abcdefgh1', basics }]);
  });

  it('a profile write that fails fails the step, so the workflow retries instead of moving on without an engine reference', async () => {
    const f = fakes();
    const profile: ProfileBinder = { recordBinding: async () => { throw new Error('dynamodb down'); } };
    await expect(bindEngine(input, { telnyx: f.telnyx, routes: f.routes, profile })).rejects.toThrow('dynamodb down');
  });
});

describe('ddbProfileBinder: PROFILE.engine and PROFILE.engineRef (the shape RenderAgent and the console both read)', () => {
  function recorder() {
    const sent: Array<{ constructor: { name: string }; input: Record<string, any> }> = [];
    return { sent, client: { send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => { sent.push(cmd); return {}; } } };
  }
  const args = { tenantId: 't_abcdefgh1', onboardingId: 'onb_1', number: '+12145550100', engine: 'livekit-telnyx' as const, agentId: 'frontdesk:t_abcdefgh1' };

  it('upserts TENANT#<tid>/PROFILE in one UpdateItem: engine fields always, identity fields only when they are new', async () => {
    const r = recorder();
    await ddbProfileBinder(r.client, 'tbl', () => new Date('2026-10-06T12:00:00.000Z')).recordBinding({ ...args, basics: { businessName: 'Kemi Cuts', businessType: 'barbershop' } });
    expect(r.sent).toHaveLength(1);
    const i = r.sent[0]!.input;
    expect(r.sent[0]!.constructor.name).toBe('UpdateCommand');
    expect(i.Key).toEqual({ PK: 'TENANT#t_abcdefgh1', SK: 'PROFILE' });
    const names = i.ExpressionAttributeNames as Record<string, string>;
    const values = i.ExpressionAttributeValues as Record<string, unknown>;
    const expr = String(i.UpdateExpression);
    // engineRef is the full reference object: RenderAgent needs engine + tenantId + agentId, the console reads agentId.
    expect(Object.values(values)).toContainEqual({ engine: 'livekit-telnyx', tenantId: 't_abcdefgh1', agentId: 'frontdesk:t_abcdefgh1' });
    expect(Object.values(values)).toContain('livekit-telnyx');
    expect(expr).toMatch(/engineRef = :ref/);
    // The state of an existing tenant (active, suspended, over_cap) is never reset by a re-run.
    expect(expr).toMatch(/#state = if_not_exists\(#state, :provisioning\)/);
    expect(names['#state']).toBe('state');
    expect(values[':provisioning']).toBe('provisioning');
    // Names the resolver, notifications and the console read: `name` and `businessName`.
    expect(Object.values(values)).toContain('Kemi Cuts');
    expect(expr).toMatch(/if_not_exists\(#name, :name\)/);
    expect(expr).toMatch(/businessName = if_not_exists\(businessName, :name\)/);
    expect(expr).toMatch(/#numbers = if_not_exists\(#numbers, :nums\)/);
    expect(values[':nums']).toEqual(['+12145550100']);
  });

  it('without basics it still writes the engine reference and leaves names alone', async () => {
    const r = recorder();
    await ddbProfileBinder(r.client, 'tbl').recordBinding(args);
    const expr = String(r.sent[0]!.input.UpdateExpression);
    expect(expr).toMatch(/engineRef = :ref/);
    expect(expr).not.toMatch(/businessName/);
  });

  it('refuses a malformed tenant id before any write', async () => {
    const r = recorder();
    await expect(ddbProfileBinder(r.client, 'tbl').recordBinding({ ...args, tenantId: 'TENANT#x' })).rejects.toThrow();
    expect(r.sent).toEqual([]);
  });
});

describe('ddbRouteStore: conditional writes keyed per contracts/dynamodb/keys.md', () => {
  it('NUMBER# and ENGINEAGENT# items use the ROUTE sort key and refuse to overwrite another tenant', async () => {
    const sent: Array<{ input: Record<string, unknown> }> = [];
    const client = { send: async (cmd: { input: Record<string, unknown> }) => { sent.push(cmd); return {}; } };
    const store = ddbRouteStore(client, 'tbl');
    await store.putNumberRoute('+12145550100', { tid: 't_abcdefgh1', engine: 'livekit-telnyx', state: 'active' });
    await store.putEngineAgentRoute('livekit-telnyx', 'frontdesk:t_abcdefgh1', { tid: 't_abcdefgh1' });
    expect(sent[0]!.input).toMatchObject({ TableName: 'tbl', Item: { PK: 'NUMBER#+12145550100', SK: 'ROUTE', tid: 't_abcdefgh1', engine: 'livekit-telnyx', state: 'active' } });
    expect(String(sent[0]!.input.ConditionExpression)).toMatch(/attribute_not_exists\(PK\) OR tid = :tid/);
    expect(sent[1]!.input).toMatchObject({ Item: { PK: 'ENGINEAGENT#livekit-telnyx#frontdesk:t_abcdefgh1', SK: 'ROUTE', tid: 't_abcdefgh1' } });
    expect(String(sent[1]!.input.ConditionExpression)).toMatch(/attribute_not_exists\(PK\) OR tid = :tid/);
  });

  it('maps a failed condition to RouteConflict', async () => {
    const client = { send: async () => { throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }); } };
    const err = await ddbRouteStore(client, 'tbl').putNumberRoute('+12145550100', { tid: 't_abcdefgh1', engine: 'livekit-telnyx', state: 'active' }).catch((e: Error) => e);
    expect((err as Error).name).toBe('RouteConflict');
  });
});

/**
 * CR E6-1: the LiveKit adapter's RouteStore port, backed by DynamoDB. The two writes above already had this shape; the
 * four below are the reads and the conditional state flip the adapter also needs (kill switch, smoke call, unbind).
 */
describe('ddbRouteStore: the rest of the adapter\'s RouteStore port (CR E6-1)', () => {
  const notFound = () => Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });

  it('getNumberRoute reads NUMBER#<e164>/ROUTE consistently and returns tid, state and engine', async () => {
    const sent: Array<{ constructor: { name: string }; input: Record<string, any> }> = [];
    const client = { send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => { sent.push(cmd); return { Item: { PK: 'NUMBER#+12145550100', SK: 'ROUTE', tid: 't_abcdefgh1', state: 'over_cap', engine: 'livekit-telnyx' } }; } };
    expect(await ddbRouteStore(client, 'tbl').getNumberRoute('+12145550100')).toEqual({ tid: 't_abcdefgh1', state: 'over_cap', engine: 'livekit-telnyx' });
    expect(sent[0]!.input).toMatchObject({ Key: { PK: 'NUMBER#+12145550100', SK: 'ROUTE' }, ConsistentRead: true });
    const none = { send: async () => ({}) };
    expect(await ddbRouteStore(none, 'tbl').getNumberRoute('+12145550100')).toBeUndefined();
    const odd = { send: async () => ({ Item: { tid: 't_abcdefgh1', state: 'weird' } }) };
    expect((await ddbRouteStore(odd, 'tbl').getNumberRoute('+12145550100'))?.state).toBe('suspended'); // unknown state is read as the stricter one
  });

  it('numbersFor lists PROFILE.numbers of that tenant only, dropping anything that is not E.164', async () => {
    const sent: Array<{ input: Record<string, any> }> = [];
    const client = { send: async (cmd: { input: Record<string, any> }) => { sent.push(cmd); return { Item: { numbers: ['+12145550100', 'not-a-number', 5] } }; } };
    expect(await ddbRouteStore(client, 'tbl').numbersFor('t_abcdefgh1' as never)).toEqual(['+12145550100']);
    expect(sent[0]!.input.Key).toEqual({ PK: 'TENANT#t_abcdefgh1', SK: 'PROFILE' });
  });

  it('setNumberState flips only this tenant\'s route, and says false instead of throwing when the route is gone or someone else\'s', async () => {
    const sent: Array<{ input: Record<string, any> }> = [];
    const ok = { send: async (cmd: { input: Record<string, any> }) => { sent.push(cmd); return {}; } };
    expect(await ddbRouteStore(ok, 'tbl').setNumberState('+12145550100', 't_abcdefgh1' as never, 'suspended')).toBe(true);
    expect(sent[0]!.input).toMatchObject({
      Key: { PK: 'NUMBER#+12145550100', SK: 'ROUTE' }, ConditionExpression: 'tid = :tid',
      ExpressionAttributeValues: { ':s': 'suspended', ':tid': 't_abcdefgh1' },
    });
    const gone = { send: async () => { throw notFound(); } };
    expect(await ddbRouteStore(gone, 'tbl').setNumberState('+12145550100', 't_abcdefgh1' as never, 'active')).toBe(false);
    const down = { send: async () => { throw new Error('throttled'); } };
    await expect(ddbRouteStore(down, 'tbl').setNumberState('+12145550100', 't_abcdefgh1' as never, 'active')).rejects.toThrow('throttled');
  });

  it('deleteNumberRoute removes NUMBER#<e164>/ROUTE', async () => {
    const sent: Array<{ constructor: { name: string }; input: Record<string, any> }> = [];
    const client = { send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => { sent.push(cmd); return {}; } };
    await ddbRouteStore(client, 'tbl').deleteNumberRoute('+12145550100');
    expect(sent[0]!.constructor.name).toBe('DeleteCommand');
    expect(sent[0]!.input.Key).toEqual({ PK: 'NUMBER#+12145550100', SK: 'ROUTE' });
  });
});
