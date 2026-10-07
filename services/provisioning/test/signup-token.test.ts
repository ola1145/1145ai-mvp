import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkReply } from '../../../packages/conversation-style/src/index.js';
import {
  SIGNUP_TTL_SECONDS,
  answerPendingBinding,
  bindingReplies,
  buildSignupUrl,
  consumeSignupToken,
  isWellFormedToken,
  maskEmail,
  newPkcePair,
  newSignupToken,
  parseBindingReply,
  reverseConfirmationMessage,
  signupLinkMessage,
  type Binding,
  type BindingStore,
} from '../src/lib/signup-token.js';

describe('signup tokens', () => {
  it('stores only the hash and consumes once', async () => {
    const { token, hash } = newSignupToken();
    const used = new Set<string>();
    const store = { consume: async (h: string) => (h === hash && !used.has(h) ? (used.add(h), { onboardingId: 'o1', channel: 'whatsapp' as const, channelUserId: 'u', exp: 0 }) : undefined) };
    expect(await consumeSignupToken(token, store)).toMatchObject({ onboardingId: 'o1' });
    expect(await consumeSignupToken(token, store)).toBeUndefined();
  });
  it('masks emails in the reverse confirmation', () => expect(maskEmail('jane.doe@gmail.com')).toBe('j***@gmail.com'));

  it('mints 32 random bytes and keeps the hash a plain sha-256 of the token', () => {
    const a = newSignupToken();
    const b = newSignupToken();
    expect(a.token).not.toBe(b.token);
    expect(isWellFormedToken(a.token)).toBe(true);
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.hash).toBe(createHash('sha256').update(a.token).digest('hex'));
    expect(a.hash).not.toContain(a.token);
  });

  it('never touches the store for a token that is the wrong shape', async () => {
    let calls = 0;
    const store = { consume: async () => { calls++; return undefined; } };
    for (const bad of ['', 'short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}!`, `${'a'.repeat(42)}/`, undefined as unknown as string]) {
      expect(await consumeSignupToken(bad, store)).toBeUndefined();
    }
    expect(calls).toBe(0);
  });

  it('is good for fifteen minutes', () => expect(SIGNUP_TTL_SECONDS).toBe(900));
});

describe('sign-in link', () => {
  const cfg = { domain: 'ai1145-dev.auth.us-east-1.amazoncognito.com', clientId: 'client123', redirectUri: 'https://api.example.invalid/signup/callback' };

  it('sends the token as OAuth state, with PKCE, Google only, and basic scopes only', () => {
    const { token } = newSignupToken();
    const { challenge } = newPkcePair();
    const url = new URL(buildSignupUrl(cfg, token, challenge));
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe(cfg.domain);
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('state')).toBe(token);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client123');
    expect(url.searchParams.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(url.searchParams.get('identity_provider')).toBe('Google');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('refuses a hostile or malformed domain instead of building a link to it', () => {
    const { token } = newSignupToken();
    for (const domain of ['evil.example/phish?', 'a b', '', 'ai1145.auth.example.com/@evil.test']) {
      expect(() => buildSignupUrl({ ...cfg, domain }, token, 'x')).toThrow();
    }
  });

  it('builds a PKCE pair whose challenge is the S256 of the verifier', () => {
    const { verifier, challenge } = newPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('YES / NO from the owner', () => {
  it('reads plain yes and no, and nothing that merely contains one', () => {
    for (const t of ['YES', 'yes', ' Yes! ', 'y', 'Yep', 'yeah', 'yes.']) expect(parseBindingReply(t), t).toBe('yes');
    for (const t of ['NO', 'no', 'No!', 'n', 'nope', 'nah']) expect(parseBindingReply(t), t).toBe('no');
    for (const t of ['', 'yes but wait', 'no idea', 'maybe', 'confirm 1234', 'not me', 'yes yes', 'yesterday']) expect(parseBindingReply(t), t).toBeUndefined();
  });
});

describe('answerPendingBinding', () => {
  const NOW = 1_800_000_000;
  const owner = { onboardingId: 'onb_1', channel: 'telegram', channelUserId: '777' };
  const pending: Binding = {
    onboardingId: 'onb_1', status: 'pending', channel: 'telegram', channelUserId: '777',
    googleSub: 'sub-a', email: 'a@gmail.com', pendingUntil: NOW + 600,
  };

  function fakeBindings(initial?: Binding) {
    let b = initial ? { ...initial } : undefined;
    const settled: string[] = [];
    const store: BindingStore = {
      get: async () => (b ? { ...b } : undefined),
      settle: async (_id, to, who, now) => {
        if (!b || b.status !== 'pending' || b.channel !== who.channel || b.channelUserId !== who.channelUserId || (b.pendingUntil ?? 0) <= now) return false;
        b = { ...b, status: to };
        settled.push(to);
        return true;
      },
    };
    return { store, settled, current: () => b };
  }

  it('YES from the bound Telegram identity confirms, and says so in a natural way', async () => {
    const f = fakeBindings(pending);
    const r = await answerPendingBinding({ ...owner, text: 'YES' }, f.store, NOW);
    expect(r).toMatchObject({ handled: true, outcome: 'confirmed', reply: bindingReplies.confirmed });
    expect(f.current()?.status).toBe('confirmed');
  });

  it('NO cancels the pending binding', async () => {
    const f = fakeBindings(pending);
    const r = await answerPendingBinding({ ...owner, text: 'no' }, f.store, NOW);
    expect(r).toMatchObject({ handled: true, outcome: 'cancelled', reply: bindingReplies.cancelled });
    expect(f.current()?.status).toBe('cancelled');
  });

  it('is not handled when there is nothing pending, so the agent keeps the conversation', async () => {
    expect(await answerPendingBinding({ ...owner, text: 'yes' }, fakeBindings().store, NOW)).toEqual({ handled: false });
    expect(await answerPendingBinding({ ...owner, text: 'yes' }, fakeBindings({ ...pending, status: 'confirmed' }).store, NOW)).toEqual({ handled: false });
    expect(await answerPendingBinding({ ...owner, text: 'yes' }, fakeBindings({ ...pending, status: 'cancelled' }).store, NOW)).toEqual({ handled: false });
  });

  it('is not handled for text that is not a plain yes or no', async () => {
    const f = fakeBindings(pending);
    expect(await answerPendingBinding({ ...owner, text: 'yes, and my hours are 9 to 5' }, f.store, NOW)).toEqual({ handled: false });
    expect(f.current()?.status).toBe('pending');
  });

  it('ignores a YES from any other chat identity', async () => {
    const f = fakeBindings(pending);
    expect(await answerPendingBinding({ ...owner, channelUserId: '999', text: 'YES' }, f.store, NOW)).toEqual({ handled: false });
    expect(await answerPendingBinding({ ...owner, channel: 'webchat', text: 'YES' }, f.store, NOW)).toEqual({ handled: false });
    expect(f.current()?.status).toBe('pending');
    expect(f.settled).toEqual([]);
  });

  it('a YES that arrives after the window confirms nothing and says what to do', async () => {
    const f = fakeBindings(pending);
    const r = await answerPendingBinding({ ...owner, text: 'yes' }, f.store, NOW + 601);
    expect(r).toMatchObject({ handled: true, outcome: 'expired', reply: bindingReplies.expired });
    expect(f.current()?.status).toBe('pending');
    expect(f.settled).toEqual([]);
  });

  it('a lost race (another answer got there first) confirms nothing', async () => {
    const f = fakeBindings(pending);
    f.store.settle = async () => false;
    const r = await answerPendingBinding({ ...owner, text: 'yes' }, f.store, NOW);
    expect(r).toMatchObject({ handled: true, outcome: 'expired' });
  });
});

describe('what the owner reads sounds like a person', () => {
  const lines: Record<string, string> = {
    link: signupLinkMessage('https://ai1145-dev.auth.us-east-1.amazoncognito.com/oauth2/authorize?state=abc'),
    reverseConfirmation: reverseConfirmationMessage('jane.doe@gmail.com'),
    confirmed: bindingReplies.confirmed,
    cancelled: bindingReplies.cancelled,
    expired: bindingReplies.expired,
  };
  for (const [name, text] of Object.entries(lines)) {
    it(`${name} passes the conversation-style checker with no errors or warnings`, () => {
      expect(checkReply(text, { channel: 'chat' })).toEqual([]);
    });
  }

  it('the reverse confirmation masks the address and says how to answer', () => {
    const m = reverseConfirmationMessage('jane.doe@gmail.com');
    expect(m).toContain('j***@gmail.com');
    expect(m).not.toContain('jane.doe');
    expect(m).toMatch(/\bYES\b/);
    expect(m).toMatch(/\bNO\b/);
  });

  it('the link message says it is private and short-lived, and carries the link', () => {
    const m = signupLinkMessage('https://x.example.invalid/l');
    expect(m).toContain('https://x.example.invalid/l');
    expect(m).toMatch(/15 minutes/);
    expect(m).toMatch(/forward/i);
  });
});
