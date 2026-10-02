import { describe, expect, it } from 'vitest';
import { consumeSignupToken, maskEmail, newSignupToken } from '../src/lib/signup-token.js';

describe('signup tokens', () => {
  it('stores only the hash and consumes once', async () => {
    const { token, hash } = newSignupToken();
    const used = new Set<string>();
    const store = { consume: async (h: string) => (h === hash && !used.has(h) ? (used.add(h), { onboardingId: 'o1', channel: 'whatsapp' as const, channelUserId: 'u', exp: 0 }) : undefined) };
    expect(await consumeSignupToken(token, store)).toMatchObject({ onboardingId: 'o1' });
    expect(await consumeSignupToken(token, store)).toBeUndefined();
  });
  it('masks emails in the reverse confirmation', () => expect(maskEmail('jane.doe@gmail.com')).toBe('j***@gmail.com'));
});
