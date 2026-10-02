import { describe, expect, it } from 'vitest';
import { mintTenantToken, verifyTenantToken, TokenError } from '../src/tokens.js';
import { principalMayCall } from '../src/tenant-context.js';
import { keys } from '../src/keys.js';
import { maskPhone } from '../src/events.js';

const NOW = 1_800_000_000;

describe('tenant tokens', () => {
  it('round-trips claims', () => {
    const t = mintTenantToken({ tid: 't_abc12345', prn: 'customer-agent', cid: 'call-1' }, 's1', 60, NOW);
    const c = verifyTenantToken(t, ['s1'], NOW + 10);
    expect(c.tid).toBe('t_abc12345');
    expect(c.prn).toBe('customer-agent');
  });
  it('accepts a rotated secret', () => {
    const t = mintTenantToken({ tid: 't_abc12345', prn: 'admin-agent' }, 'old', 60, NOW);
    expect(verifyTenantToken(t, ['new', 'old'], NOW).prn).toBe('admin-agent');
  });
  it('rejects tampered payload (tenant swap)', () => {
    const t = mintTenantToken({ tid: 't_abc12345', prn: 'customer-agent' }, 's1', 60, NOW);
    const [h, , s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ tid: 't_other9999', prn: 'customer-agent', aud: 'tool-api', iat: NOW, exp: NOW + 60 })).toString('base64url');
    expect(() => verifyTenantToken(`${h}.${forged}.${s}`, ['s1'], NOW)).toThrow(TokenError);
  });
  it('rejects expired tokens', () => {
    const t = mintTenantToken({ tid: 't_abc12345', prn: 'customer-agent' }, 's1', 60, NOW);
    expect(() => verifyTenantToken(t, ['s1'], NOW + 61)).toThrow(/expired/);
  });
});

describe('tool permissions', () => {
  it('customer agent cannot call admin tools', () => {
    expect(principalMayCall('customer-agent', 'updateService')).toBe(false);
    expect(principalMayCall('customer-agent', 'createBooking')).toBe(true);
  });
  it('admin agent can propose but never apply a change', () => {
    expect(principalMayCall('admin-agent', 'proposeChange')).toBe(true);
    expect(principalMayCall('admin-agent', 'applyChange')).toBe(false);
    expect(principalMayCall('admin-agent', 'updateService')).toBe(false);
    expect(principalMayCall('admin-agent', 'lookupCaller')).toBe(false);
  });
});

describe('keys', () => {
  it('rejects # in segments (key injection)', () => {
    expect(() => keys.tenantPk('t_x#NUMBER')).toThrow();
  });
  it('masks phones', () => {
    expect(maskPhone('+12145550123')).toBe('+1••••••0123');
  });
});
