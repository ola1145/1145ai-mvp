import { describe, expect, it, vi } from 'vitest';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  DEFAULT_CLICK_LIMITS,
  DEFAULT_START_URL,
  createClickLimiter,
  createProdDeps,
  createReferralStore,
  referralRedirect,
  resolveStartUrl,
  type ClickLimits,
  type ReferralDeps,
  type ReferralEvent,
} from '../src/referral-redirect.js';

// ───────────────────────── a DynamoDB fake that enforces what the code relies on ─────────────────────────

type Item = Record<string, unknown>;
const keyOf = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;
const awsError = (name: string) => Object.assign(new Error(name), { name });

interface FakeOpts { failUpdate?: boolean; failGet?: boolean; failPut?: boolean; failRate?: boolean }

function fakeDoc(opts: FakeOpts = {}) {
  const table = new Map<string, Item>();
  const calls: string[] = [];
  return {
    table,
    calls,
    opts,
    async send(cmd: unknown): Promise<unknown> {
      await Promise.resolve(); // let concurrent callers interleave
      if (cmd instanceof GetCommand) {
        calls.push('get');
        if (opts.failGet) throw awsError('ProvisionedThroughputExceededException');
        return { Item: table.get(keyOf(cmd.input.Key as never)) };
      }
      if (cmd instanceof PutCommand) {
        calls.push('put');
        if (opts.failPut) throw awsError('InternalServerError');
        const item = cmd.input.Item as Item;
        const existing = table.get(keyOf(item as never));
        const cond = cmd.input.ConditionExpression;
        if (cond && cond !== 'attribute_not_exists(PK)') throw new Error(`fake does not understand condition: ${cond}`);
        if (cond && existing) throw awsError('ConditionalCheckFailedException');
        table.set(keyOf(item as never), item);
        return {};
      }
      if (cmd instanceof UpdateCommand) {
        const expr = cmd.input.UpdateExpression ?? '';
        if (/ADD\s+#n\s+:one/.test(expr)) {
          // The per-code window counter (SEC-25): atomic add, returns the new count.
          calls.push('rate');
          if (opts.failRate) throw awsError('ProvisionedThroughputExceededException');
          const k = keyOf(cmd.input.Key as never);
          const v = cmd.input.ExpressionAttributeValues ?? {};
          const cur = table.get(k) ?? { ...(cmd.input.Key as Item) };
          const n = ((cur.n as number | undefined) ?? 0) + (v[':one'] as number);
          table.set(k, { ...cur, n, ttl: v[':ttl'] });
          return { Attributes: { n } };
        }
        calls.push('update');
        if (opts.failUpdate) throw awsError('ProvisionedThroughputExceededException');
        if (!/ADD\s+clicks\s+:one/.test(expr)) throw new Error(`fake does not understand update: ${expr}`);
        const v = cmd.input.ExpressionAttributeValues ?? {};
        const k = keyOf(cmd.input.Key as never);
        const cur = table.get(k) ?? { ...(cmd.input.Key as Item) };
        table.set(k, {
          ...cur,
          clicks: ((cur.clicks as number | undefined) ?? 0) + (v[':one'] as number),
          firstClickAt: cur.firstClickAt ?? v[':now'],
          lastClickAt: v[':now'],
        });
        return {};
      }
      if (cmd instanceof DeleteCommand) { calls.push('delete'); table.delete(keyOf(cmd.input.Key as never)); return {}; }
      throw new Error('unexpected command');
    },
  };
}

const NOW = new Date('2026-10-06T12:00:00Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const THIRTY_DAYS = 30 * 24 * 3600;
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function setup(opts: FakeOpts = {}, over: Partial<ReferralDeps> = {}, limits?: Partial<ClickLimits>) {
  const doc = fakeDoc(opts);
  doc.table.set('REFERRAL#FRIEND1|OWNER', { PK: 'REFERRAL#FRIEND1', SK: 'OWNER', referrerTid: 't_referrer01' });
  doc.table.set('REFERRAL#OTHER99|OWNER', { PK: 'REFERRAL#OTHER99', SK: 'OWNER', tid: 't_referrer02' });
  let n = 0;
  const clock = { ms: NOW.getTime() };
  const store = createReferralStore({ doc, tableName: 't1145', now: () => NOW });
  const deps: ReferralDeps = {
    ...store,
    startUrl: DEFAULT_START_URL,
    newVisitorId: () => `visitor-id-number-${String(++n).padStart(4, '0')}`,
    clickLimiter: createClickLimiter({ doc, tableName: 't1145', now: () => clock.ms, ...(limits ? { limits } : {}) }),
    ...over,
  };
  return { doc, deps, clock };
}

const IP = '203.0.113.7';
const click = (code: string | undefined, extra: Partial<ReferralEvent> & { headers?: Record<string, string> } = {}): ReferralEvent => ({
  rawPath: `/r/${code ?? ''}`,
  pathParameters: code === undefined ? {} : { code },
  requestContext: { http: { method: 'GET', userAgent: BROWSER, sourceIp: IP } },
  headers: { 'user-agent': BROWSER },
  ...extra,
});
/** The same browser, from another address (what API Gateway reports as sourceIp). */
const from = (sourceIp: string): Pick<ReferralEvent, 'requestContext'> => ({ requestContext: { http: { method: 'GET', userAgent: BROWSER, sourceIp } } });

const clicks = (doc: ReturnType<typeof fakeDoc>, code = 'FRIEND1') => (doc.table.get(`REFCLICK#${code}|COUNT`)?.clicks as number | undefined) ?? 0;
const visitorCookie = (res: { cookies?: string[] }) => res.cookies?.find((c) => c.startsWith('ref_v='));
const cookieHeaderFrom = (res: { cookies?: string[] }) => visitorCookie(res)!.split(';')[0]!;

// ───────────────────────── tests ─────────────────────────

describe('referral redirect: valid and invalid codes', () => {
  it('valid code: counts the click in REFCLICK#<code> and redirects 302 to the app start URL with ref', async () => {
    const { doc, deps } = setup();
    const res = await referralRedirect(click('FRIEND1'), deps);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://app.1145.ai/start?ref=FRIEND1');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe('');
    expect(doc.table.get('REFCLICK#FRIEND1|COUNT')).toMatchObject({
      PK: 'REFCLICK#FRIEND1', SK: 'COUNT', clicks: 1,
      firstClickAt: NOW.toISOString(), lastClickAt: NOW.toISOString(),
    });
  });

  it('valid code: sets a first-party visitor cookie scoped to /r, and records that visitor with a 30 day TTL', async () => {
    const { doc, deps } = setup();
    const res = await referralRedirect(click('FRIEND1'), deps);

    const cookie = visitorCookie(res)!;
    expect(cookie).toBe(`ref_v=visitor-id-number-0001; Max-Age=${THIRTY_DAYS}; Path=/r; Secure; HttpOnly; SameSite=Lax`);
    expect(doc.table.get('REFCLICK#FRIEND1|V#visitor-id-number-0001')).toMatchObject({ at: NOW.toISOString(), ttl: NOW_SEC + THIRTY_DAYS });
  });

  it('valid code: a code stored under the older "tid" attribute is just as valid', async () => {
    const { doc, deps } = setup();
    const res = await referralRedirect(click('OTHER99'), deps);
    expect(res.headers.location).toBe('https://app.1145.ai/start?ref=OTHER99');
    expect(clicks(doc, 'OTHER99')).toBe(1);
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'A'.repeat(65)],
    ['path traversal', '../../etc'],
    ['space', 'FRIEND 1'],
    ['dot', 'FRIEND.1'],
    ['url-looking', 'https:%2F%2Fevil.example'],
    ['empty', ''],
  ])('invalid code (%s): redirects 302 to the start URL WITHOUT ref and writes nothing', async (_name, code) => {
    const { doc, deps } = setup();
    const before = new Map(doc.table);
    const res = await referralRedirect(click(code), deps);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://app.1145.ai/start');
    expect(res.cookies).toBeUndefined();
    expect(doc.calls).toEqual([]); // a bad code never costs a DynamoDB call
    expect(doc.table).toEqual(before);
  });

  it('missing path parameter: redirects without ref', async () => {
    const { doc, deps } = setup();
    const res = await referralRedirect(click(undefined), deps);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://app.1145.ai/start');
    expect(doc.calls).toEqual([]);
  });

  it('well-formed but unknown code: redirects without ref and does not create a REFCLICK item', async () => {
    const { doc, deps } = setup();
    const res = await referralRedirect(click('NOSUCH1'), deps);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://app.1145.ai/start');
    expect(res.cookies).toBeUndefined();
    expect([...doc.table.keys()].filter((k) => k.startsWith('REFCLICK#'))).toEqual([]);
  });

  it('a REFERRAL item with no referrer on it is treated as unknown', async () => {
    const { doc, deps } = setup();
    doc.table.set('REFERRAL#BROKEN1|OWNER', { PK: 'REFERRAL#BROKEN1', SK: 'OWNER' });
    const res = await referralRedirect(click('BROKEN1'), deps);
    expect(res.headers.location).toBe('https://app.1145.ai/start');
    expect(clicks(doc, 'BROKEN1')).toBe(0);
  });
});

describe('referral redirect: repeat clicks and different people', () => {
  it('the same visitor clicking again counts once, and keeps the same cookie', async () => {
    const { doc, deps } = setup();
    const first = await referralRedirect(click('FRIEND1'), deps);
    const again = await referralRedirect(click('FRIEND1', { cookies: [cookieHeaderFrom(first)] }), deps);
    const third = await referralRedirect(click('FRIEND1', { cookies: [cookieHeaderFrom(first)] }), deps);

    expect(clicks(doc)).toBe(1);
    for (const r of [again, third]) {
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe('https://app.1145.ai/start?ref=FRIEND1');
      expect(r.cookies).toBeUndefined(); // not re-issued, so the 30 day window is not stretched
    }
  });

  it('a repeat click is recognised from the Cookie header too (non-v2 payloads)', async () => {
    const { doc, deps } = setup();
    const first = await referralRedirect(click('FRIEND1'), deps);
    await referralRedirect(click('FRIEND1', { headers: { 'user-agent': BROWSER, cookie: `theme=dark; ${cookieHeaderFrom(first)}; other=1` } }), deps);
    expect(clicks(doc)).toBe(1);
  });

  it('two clicks from the same visitor at the same moment count once', async () => {
    const { doc, deps } = setup();
    const first = await referralRedirect(click('FRIEND1'), deps);
    const cookies = [cookieHeaderFrom(first)];
    await Promise.all(Array.from({ length: 5 }, () => referralRedirect(click('FRIEND1', { cookies }), deps)));
    expect(clicks(doc)).toBe(1);
  });

  it('different visitors each count once', async () => {
    const { doc, deps } = setup();
    await referralRedirect(click('FRIEND1'), deps);
    await referralRedirect(click('FRIEND1'), deps);
    await referralRedirect(click('FRIEND1'), deps);
    expect(clicks(doc)).toBe(3);
    expect(doc.table.get('REFCLICK#FRIEND1|COUNT')).toMatchObject({ clicks: 3 });
  });

  it('the same visitor is counted once per code, not once overall', async () => {
    const { doc, deps } = setup();
    const first = await referralRedirect(click('FRIEND1'), deps);
    await referralRedirect(click('OTHER99', { cookies: [cookieHeaderFrom(first)] }), deps);
    await referralRedirect(click('OTHER99', { cookies: [cookieHeaderFrom(first)] }), deps);
    expect(clicks(doc, 'FRIEND1')).toBe(1);
    expect(clicks(doc, 'OTHER99')).toBe(1);
  });

  it('a mangled visitor cookie is ignored and the visitor gets a fresh one', async () => {
    const { doc, deps } = setup();
    for (const bad of ['ref_v=short', 'ref_v=../../../../etc/passwd', 'ref_v=' + 'x'.repeat(200), 'ref_v=']) {
      const res = await referralRedirect(click('FRIEND1', { cookies: [bad] }), deps);
      expect(visitorCookie(res)).toMatch(/^ref_v=visitor-id-number-\d{4};/);
    }
    expect([...doc.table.keys()].filter((k) => k.includes('|V#') && k.includes('etc'))).toEqual([]);
    expect(clicks(doc)).toBe(4);
  });
});

describe('referral redirect: self-referral does not count', () => {
  const inProduct = { 'sec-fetch-site': 'same-site' };

  it('the referrer opening their own link from inside the product (same-site navigation) is not a click', async () => {
    const { doc, deps } = setup();
    const res = await referralRedirect(click('FRIEND1', { headers: { 'user-agent': BROWSER, ...inProduct } }), deps);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://app.1145.ai/start?ref=FRIEND1'); // still works as a link
    expect(clicks(doc)).toBe(0);
  });

  it.each([
    ['same-origin fetch metadata', { 'sec-fetch-site': 'same-origin' }],
    ['Referer from the app', { referer: 'https://app.1145.ai/referrals' }],
    ['Referer from the apex site', { referer: 'https://1145.ai/' }],
  ])('in-product click (%s) does not count', async (_name, headers) => {
    const { doc, deps } = setup();
    await referralRedirect(click('FRIEND1', { headers: { 'user-agent': BROWSER, ...headers } }), deps);
    expect(clicks(doc)).toBe(0);
  });

  it.each([
    ['cross-site (a chat app or email)', { 'sec-fetch-site': 'cross-site' }],
    ['typed or opened from another app', { 'sec-fetch-site': 'none' }],
    ['a lookalike Referer host', { referer: 'https://app.1145.ai.evil.example/x' }],
    ['a lookalike apex', { referer: 'https://evil1145.ai/x' }],
    ['a garbage Referer', { referer: 'not a url' }],
  ])('a real friend click (%s) counts', async (_name, headers) => {
    const { doc, deps } = setup();
    await referralRedirect(click('FRIEND1', { headers: { 'user-agent': BROWSER, ...headers } }), deps);
    expect(clicks(doc)).toBe(1);
  });

  it('after an in-product click, the referrer pasting the link in the same browser is still not counted', async () => {
    const { doc, deps } = setup();
    const own = await referralRedirect(click('FRIEND1', { headers: { 'user-agent': BROWSER, ...inProduct } }), deps);
    expect(visitorCookie(own)).toBeDefined(); // their browser is remembered

    const pasted = await referralRedirect(click('FRIEND1', { headers: { 'user-agent': BROWSER, 'sec-fetch-site': 'none' }, cookies: [cookieHeaderFrom(own)] }), deps);
    expect(pasted.headers.location).toBe('https://app.1145.ai/start?ref=FRIEND1');
    expect(clicks(doc)).toBe(0);
  });

  it('a visitor already counted does not count again when they later click from inside the product', async () => {
    const { doc, deps } = setup();
    const first = await referralRedirect(click('FRIEND1'), deps);
    await referralRedirect(click('FRIEND1', { headers: { 'user-agent': BROWSER, ...inProduct }, cookies: [cookieHeaderFrom(first)] }), deps);
    expect(clicks(doc)).toBe(1);
  });

  it('request-supplied tenant ids change nothing: only the path code and the stored REFERRAL item matter', async () => {
    const { doc, deps } = setup();
    const res = await referralRedirect(click('FRIEND1', {
      rawPath: '/r/FRIEND1?tid=t_evil00001&next=https://evil.example',
      headers: { 'user-agent': BROWSER, 'x-tenant-id': 't_evil00001', host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    }), deps);
    expect(res.headers.location).toBe('https://app.1145.ai/start?ref=FRIEND1');
    expect(JSON.stringify([...doc.table.values()])).not.toContain('t_evil00001');
  });
});

describe('referral redirect: link previews and bots do not inflate the count', () => {
  it.each([
    ['Telegram preview', 'TelegramBot (like TwitterBot)'],
    ['iMessage / Facebook preview', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
    ['WhatsApp preview', 'WhatsApp/2.23.20.0 A'],
    ['Slack', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
    ['Google', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['curl', 'curl/8.7.1'],
    ['a script', 'python-requests/2.32.0'],
    ['headless Chrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36'],
  ])('%s still gets the redirect but is not counted and gets no cookie', async (_name, ua) => {
    const { doc, deps } = setup();
    const res = await referralRedirect(click('FRIEND1', { requestContext: { http: { method: 'GET', userAgent: ua } }, headers: { 'user-agent': ua } }), deps);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://app.1145.ai/start?ref=FRIEND1');
    expect(res.cookies).toBeUndefined();
    expect(clicks(doc)).toBe(0);
  });

  it('a request with no user agent is not counted', async () => {
    const { doc, deps } = setup();
    await referralRedirect({ pathParameters: { code: 'FRIEND1' }, headers: {}, requestContext: { http: { method: 'GET' } } }, deps);
    expect(clicks(doc)).toBe(0);
  });

  it.each([
    ['Sec-Purpose', { 'sec-purpose': 'prefetch;prerender' }],
    ['Purpose', { purpose: 'prefetch' }],
  ])('browser speculative loads (%s) are not counted', async (_name, headers) => {
    const { doc, deps } = setup();
    await referralRedirect(click('FRIEND1', { headers: { 'user-agent': BROWSER, ...headers } }), deps);
    expect(clicks(doc)).toBe(0);
  });
});

describe('referral redirect: the target is fixed and a hiccup never strands the visitor', () => {
  it('never takes the destination from the request', async () => {
    const { deps } = setup();
    const res = await referralRedirect(click('FRIEND1', {
      rawPath: '/r/FRIEND1?redirect=https://evil.example&url=//evil.example',
      headers: { 'user-agent': BROWSER, host: 'evil.example', 'x-forwarded-host': 'evil.example', origin: 'https://evil.example' },
    }), deps);
    expect(new URL(res.headers.location).origin).toBe('https://app.1145.ai');
  });

  it('uses the configured start URL, and appends ref to it', async () => {
    const { deps } = setup({}, { startUrl: 'https://app.dev.1145.ai/start' });
    const res = await referralRedirect(click('FRIEND1'), deps);
    expect(res.headers.location).toBe('https://app.dev.1145.ai/start?ref=FRIEND1');
  });

  it('when the click cannot be saved, the visitor is still redirected with ref, and the failure is logged without PII', async () => {
    const { doc, deps } = setup({ failUpdate: true });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await referralRedirect(click('FRIEND1'), deps);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://app.1145.ai/start?ref=FRIEND1');
    expect(clicks(doc)).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).not.toContain(BROWSER);
    log.mockRestore();
  });

  it('when the code lookup fails, a well-formed code is still passed on (onboarding re-checks it), but nothing is counted', async () => {
    const { doc, deps } = setup({ failGet: true });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await referralRedirect(click('FRIEND1'), deps);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://app.1145.ai/start?ref=FRIEND1');
    expect(clicks(doc)).toBe(0);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

// SEC-25 / threat model F10 (click-log flooding): a client that sends a fresh ref_v cookie with every request would otherwise add
// one marker and one click per request. The redirect itself is never limited; only what gets written is.
describe('referral redirect: click-log limits (SEC-25)', () => {
  const visitors = (doc: ReturnType<typeof fakeDoc>, code = 'FRIEND1') => [...doc.table.keys()].filter((k) => k.startsWith(`REFCLICK#${code}|V#`)).length;

  it('defaults to limits a real visitor never meets', () => {
    expect(DEFAULT_CLICK_LIMITS.perIp.limit).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_CLICK_LIMITS.perIp.windowSec).toBeGreaterThanOrEqual(5 * 60);
    expect(DEFAULT_CLICK_LIMITS.perCode.limit).toBeGreaterThan(DEFAULT_CLICK_LIMITS.perIp.limit);
  });

  it('one address with a fresh cookie every time adds at most the per-address limit, and every request still gets its redirect', async () => {
    const { doc, deps } = setup();
    const results = [];
    for (let i = 0; i < 40; i++) results.push(await referralRedirect(click('FRIEND1'), deps));
    expect(results.every((r) => r.statusCode === 302 && r.headers.location === 'https://app.1145.ai/start?ref=FRIEND1')).toBe(true);
    expect(clicks(doc)).toBe(DEFAULT_CLICK_LIMITS.perIp.limit);
    expect(visitors(doc)).toBe(DEFAULT_CLICK_LIMITS.perIp.limit);   // and no markers past it either
  });

  it('the per-address limit spans codes, so rotating codes does not get around it, and other addresses are untouched', async () => {
    const { doc, deps } = setup({}, {}, { perIp: { limit: 3, windowSec: 600 } });
    for (let i = 0; i < 3; i++) await referralRedirect(click('FRIEND1'), deps);
    await referralRedirect(click('OTHER99'), deps);
    expect(clicks(doc, 'FRIEND1') + clicks(doc, 'OTHER99')).toBe(3);
    await referralRedirect(click('OTHER99', from('198.51.100.20')), deps);
    expect(clicks(doc, 'OTHER99')).toBe(1);
  });

  it('counts the address API Gateway saw, never a header the client can write', async () => {
    const { doc, deps } = setup({}, {}, { perIp: { limit: 2, windowSec: 600 } });
    for (let i = 0; i < 5; i++) {
      await referralRedirect(click('FRIEND1', { headers: { 'user-agent': BROWSER, 'x-forwarded-for': `10.0.0.${i}`, 'x-real-ip': `10.1.0.${i}` } }), deps);
    }
    expect(clicks(doc)).toBe(2);
  });

  it('many addresses on one code add at most the per-code limit in a window, then count again in the next', async () => {
    const { doc, deps, clock } = setup({}, {}, { perCode: { limit: 4, windowSec: 3600 } });
    clock.ms = Math.floor(clock.ms / 3_600_000) * 3_600_000;
    for (let i = 0; i < 9; i++) await referralRedirect(click('FRIEND1', from(`192.0.2.${i + 1}`)), deps);
    expect(clicks(doc)).toBe(4);
    expect(clicks(doc, 'OTHER99')).toBe(0);
    await referralRedirect(click('OTHER99', from('192.0.2.50')), deps);
    expect(clicks(doc, 'OTHER99')).toBe(1);                         // one code's flood leaves the others alone
    clock.ms += 3_600_000;
    await referralRedirect(click('FRIEND1', from('192.0.2.99')), deps);
    expect(clicks(doc)).toBe(5);
  });

  it('keeps the per-code window under REFCLICK#<code> with a ttl, and stores no address in any form', async () => {
    const { doc, deps, clock } = setup();
    await referralRedirect(click('FRIEND1'), deps);
    const windowStart = Math.floor(clock.ms / 1000 / 3600) * 3600;
    expect(doc.table.get(`REFCLICK#FRIEND1|RATE#${windowStart}`)).toMatchObject({ n: 1, ttl: windowStart + 3600 + 3600 });
    const stored = JSON.stringify([...doc.table.entries()]);
    expect(stored).not.toContain(IP);
    expect([...doc.table.keys()].filter((k) => !/^REF(ERRAL|CLICK)#(FRIEND1|OTHER99)\|/.test(k))).toEqual([]);
  });

  it('bots, unknown codes and bad codes never reach the limiter, so they cannot use up a real visitor\'s allowance', async () => {
    const { doc, deps } = setup({}, {}, { perIp: { limit: 1, windowSec: 600 } });
    await referralRedirect(click('NOSUCH1'), deps);
    await referralRedirect(click('../x'), deps);
    await referralRedirect(click('FRIEND1', { requestContext: { http: { method: 'GET', userAgent: 'curl/8.7.1', sourceIp: IP } }, headers: { 'user-agent': 'curl/8.7.1' } }), deps);
    expect(doc.calls.filter((c) => c === 'rate')).toEqual([]);
    await referralRedirect(click('FRIEND1'), deps);
    expect(clicks(doc)).toBe(1);
  });

  it('a limited request gets the redirect with ref but no cookie and no write', async () => {
    const { doc, deps } = setup({}, {}, { perIp: { limit: 1, windowSec: 600 } });
    await referralRedirect(click('FRIEND1'), deps);
    const before = doc.calls.length;
    const limited = await referralRedirect(click('FRIEND1'), deps);
    expect(limited.headers.location).toBe('https://app.1145.ai/start?ref=FRIEND1');
    expect(limited.cookies).toBeUndefined();
    expect(doc.calls.slice(before).filter((c) => c === 'put' || c === 'update' || c === 'rate')).toEqual([]);
  });

  it('if the shared counter is down, the visitor is redirected with ref, nothing is counted, and it is logged', async () => {
    const { doc, deps } = setup({ failRate: true });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await referralRedirect(click('FRIEND1'), deps);
    expect(res.headers.location).toBe('https://app.1145.ai/start?ref=FRIEND1');
    expect(clicks(doc)).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).not.toContain(IP);
    log.mockRestore();
  });

  it('the in-memory per-address table cannot grow without bound', async () => {
    const lim = createClickLimiter({ now: () => NOW.getTime() });
    for (let i = 0; i < 25_000; i++) await lim.allow('FRIEND1', `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    expect(lim.trackedAddresses()).toBeLessThanOrEqual(10_000);
  });
});

describe('referral store', () => {
  it('rolls the visitor marker back if the counter update fails, so the next click can count', async () => {
    const doc = fakeDoc({ failUpdate: true });
    doc.table.set('REFERRAL#FRIEND1|OWNER', { PK: 'REFERRAL#FRIEND1', SK: 'OWNER', referrerTid: 't_referrer01' });
    const store = createReferralStore({ doc, tableName: 't1145', now: () => NOW });

    await expect(store.recordClick('FRIEND1', 'visitor-id-number-0001', 'visit')).rejects.toThrow();
    expect(doc.table.has('REFCLICK#FRIEND1|V#visitor-id-number-0001')).toBe(false);

    doc.opts.failUpdate = false;
    await expect(store.recordClick('FRIEND1', 'visitor-id-number-0001', 'visit')).resolves.toBe(true);
    expect(clicks(doc)).toBe(1);
  });

  it('reports whether this call was the one that counted', async () => {
    const doc = fakeDoc();
    const store = createReferralStore({ doc, tableName: 't1145', now: () => NOW });
    expect(await store.recordClick('FRIEND1', 'visitor-id-number-0001', 'visit')).toBe(true);
    expect(await store.recordClick('FRIEND1', 'visitor-id-number-0001', 'visit')).toBe(false);
    expect(await store.recordClick('FRIEND1', 'visitor-id-number-0001', 'own')).toBe(false);
    expect(await store.recordClick('FRIEND1', 'visitor-id-number-0002', 'own')).toBe(false);
    expect(await store.recordClick('FRIEND1', 'visitor-id-number-0002', 'visit')).toBe(false); // already known as the referrer's own browser
    expect(clicks(doc)).toBe(1);
  });

  it('does not swallow errors that are not "already counted"', async () => {
    const doc = fakeDoc({ failPut: true });
    const store = createReferralStore({ doc, tableName: 't1145', now: () => NOW });
    await expect(store.recordClick('FRIEND1', 'visitor-id-number-0001', 'visit')).rejects.toThrow('InternalServerError');
    await expect(store.recordClick('FRIEND1', 'visitor-id-number-0001', 'own')).rejects.toThrow('InternalServerError');
  });

  it('writes only under REFCLICK#<code> and reads only REFERRAL#<code>', async () => {
    const doc = fakeDoc();
    doc.table.set('REFERRAL#FRIEND1|OWNER', { PK: 'REFERRAL#FRIEND1', SK: 'OWNER', referrerTid: 't_referrer01' });
    const before = new Set(doc.table.keys());
    const store = createReferralStore({ doc, tableName: 't1145', now: () => NOW });
    expect(await store.referralExists('FRIEND1')).toBe(true);
    expect(await store.referralExists('NOSUCH1')).toBe(false);
    await store.recordClick('FRIEND1', 'visitor-id-number-0001', 'visit');
    const added = [...doc.table.keys()].filter((k) => !before.has(k));
    expect(added.sort()).toEqual(['REFCLICK#FRIEND1|COUNT', 'REFCLICK#FRIEND1|V#visitor-id-number-0001']);
  });
});

describe('start URL configuration', () => {
  it('defaults to the production app start page', () => {
    expect(resolveStartUrl(undefined)).toBe('https://app.1145.ai/start');
    expect(DEFAULT_START_URL).toBe('https://app.1145.ai/start');
  });

  it('accepts https URLs on 1145.ai and drops any query or fragment from them', () => {
    expect(resolveStartUrl('https://app.dev.1145.ai/start')).toBe('https://app.dev.1145.ai/start');
    expect(resolveStartUrl('https://app.1145.ai/start?ref=x#frag')).toBe('https://app.1145.ai/start');
  });

  it.each([
    'http://app.1145.ai/start',
    'https://evil.example/start',
    'https://app.1145.ai.evil.example/start',
    'https://evil1145.ai/start',
    'https://user:pw@app.1145.ai/start',
    'https://app.1145.ai:8443/start',
    'javascript:alert(1)',
    'not a url',
  ])('falls back to the default for %s, so a bad setting can never become an open redirect', (bad) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveStartUrl(bad)).toBe(DEFAULT_START_URL);
    log.mockRestore();
  });

  it('production deps need the table name, and use the validated start URL', () => {
    expect(() => createProdDeps({})).toThrow('missing env TABLE_NAME');
    const deps = createProdDeps({ TABLE_NAME: 't1145', APP_START_URL: 'https://app.dev.1145.ai/start' });
    expect(deps.startUrl).toBe('https://app.dev.1145.ai/start');
    expect(deps.newVisitorId()).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(deps.newVisitorId()).not.toBe(deps.newVisitorId());
  });
});
