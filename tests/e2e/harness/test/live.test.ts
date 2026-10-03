import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLivePorts, LIVE_NOT_WIRED, loadLiveConfig, NotWiredError } from '../live.ts';
import { runLive } from '../run-live.ts';
import { renderSummary } from '../report.ts';
import { runGate } from '../gate.ts';
import { createFakePlatform } from '../fakes/fake-platform.ts';

const ENV = { E2E_STAGE: 'dev', E2E_API_BASE: 'https://api.dev.1145.ai/', E2E_OWNER_TOKEN: 'a.b.c' };

test('config: needs the dev API base and owner token', () => {
  const r = loadLiveConfig({});
  assert.equal(r.ok, false);
  assert.deepEqual(!r.ok && r.missing, ['E2E_API_BASE', 'E2E_OWNER_TOKEN']);
});
test('config: refuses non-dev stages, http and prod-looking hosts', () => {
  for (const env of [{ ...ENV, E2E_STAGE: 'prod' }, { ...ENV, E2E_API_BASE: 'http://api.dev.1145.ai' }, { ...ENV, E2E_API_BASE: 'https://api.prod.1145.ai' }, { ...ENV, E2E_API_BASE: 'https://prod-api.1145.ai' }]) {
    const r = loadLiveConfig(env);
    assert.equal(r.ok, false, JSON.stringify(env));
  }
});
test('config: accepts dev and trims the trailing slash', () => {
  const r = loadLiveConfig(ENV);
  assert.equal(r.ok && r.config.apiBase, 'https://api.dev.1145.ai');
});

function recordingFetch(respond: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return respond(String(url), init); }) as typeof fetch;
  return { f, calls };
}
const cfg = () => { const r = loadLiveConfig(ENV); if (!r.ok) throw new Error('bad test config'); return r.config; };

test('referral adapter does not follow the redirect and reads Location', async () => {
  const { f, calls } = recordingFetch(() => new Response(null, { status: 302, headers: { location: 'https://app.1145.ai/start?ref=abcd' } }));
  const r = await createLivePorts(cfg(), f).referral.follow('abcd');
  assert.deepEqual(r, { status: 302, location: 'https://app.1145.ai/start?ref=abcd' });
  assert.equal(calls[0]!.url, 'https://api.dev.1145.ai/r/abcd');
  assert.equal(calls[0]!.init?.redirect, 'manual');
});

test('web chat token request carries only the widget key, never a tenant id', async () => {
  const { f, calls } = recordingFetch(() => Response.json({ agentName: 'Ava', greeting: 'Hi' }));
  const r = await createLivePorts(cfg(), f).customerChat.open('wk_abcdefghijklmnop');
  assert.equal(r.agentName, 'Ava');
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { widgetKey: 'wk_abcdefghijklmnop' });
  assert.equal(calls[0]!.init?.headers && 'authorization' in (calls[0]!.init.headers as object), false, 'public endpoint, no bearer');
});

test('owner chat posts the contract body with the bearer token and no tenant id', async () => {
  const { f, calls } = recordingFetch(() => new Response(null, { status: 202 }));
  await assert.rejects(createLivePorts(cfg(), f).owner.send('hi', { referralCode: 'abcd1234' }), (e: unknown) => e instanceof NotWiredError);
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.deepEqual(Object.keys(body).sort(), ['clientMessageId', 'referralCode', 'text']);
  assert.equal((calls[0]!.init?.headers as Record<string, string>).authorization, 'Bearer a.b.c');
  assert.doesNotMatch(JSON.stringify(body), /tenant/i);
});

test('every port that throws NotWiredError is listed in LIVE_NOT_WIRED, and nothing else is', async () => {
  const { f } = recordingFetch(() => new Response(null, { status: 202 }));
  const p = createLivePorts(cfg(), f);
  const probes: Array<() => Promise<unknown>> = [
    () => p.owner.addTestCard(), () => p.owner.send('x'), () => p.customerChat.send('x'), () => p.telegram.waitForMessage(/x/, 1),
    () => p.phone.call({ to: '+12145550142', callerLabel: 'x', script: [] }), () => p.live.waitForEvent('x', 1),
    () => p.platform.getTenant('x'), () => p.platform.listBookings('x'), () => p.platform.getCall('x'),
  ];
  const seen: string[] = [];
  for (const probe of probes) { try { await probe(); } catch (e) { if (e instanceof NotWiredError) seen.push(e.port); } }
  assert.deepEqual(seen.sort(), [...LIVE_NOT_WIRED].sort());
});

test('runLive: not configured is a loud skip, and a failure only when E2E_REQUIRE_LIVE is set', async () => {
  const out: string[] = [];
  assert.equal(await runLive({}, (s) => out.push(s)), 0);
  assert.match(out.join('\n'), /NOT RUN/);
  assert.equal(await runLive({ E2E_REQUIRE_LIVE: '1' }, () => {}), 1);
});

test('runLive: configured but adapters unwired lists what is missing and honors E2E_REQUIRE_LIVE', async () => {
  const out: string[] = [];
  assert.equal(await runLive(ENV, (s) => out.push(s)), 0);
  assert.match(out.join('\n'), /phone/);
  assert.equal(await runLive({ ...ENV, E2E_REQUIRE_LIVE: 'true' }, () => {}), 1);
});

test('renderSummary shows each step and the style result', async () => {
  const now = new Date('2026-10-03T15:00:00Z');
  const fake = createFakePlatform({ now, fault: 'no-telegram' });
  const md = renderSummary(await runGate(fake.ports, { now, timeouts: { eventMs: 5, telegramMs: 5, provisionMs: 20, pollMs: 2 } }));
  assert.match(md, /Gate e2e: FAIL/);
  assert.match(md, /\| owner-telegram-notified \| FAIL \|/);
  assert.match(md, /\| call-recorded \| skip \|/);
  assert.match(md, /Conversation style: \d+ agent turns checked/);
});
