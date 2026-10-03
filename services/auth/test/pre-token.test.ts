import { describe, expect, it, vi } from 'vitest';
import { createHandler, type AuthTable, type PreTokenEvent } from '../src/pre-token.js';

const TID = 't_acmeplumb01';
const SUB = '11111111-2222-3333-4444-555555555555';

function event(sub = SUB, extra: Record<string, string> = {}): PreTokenEvent {
  return {
    version: '1', triggerSource: 'TokenGeneration_HostedAuth', region: 'us-east-1', userPoolId: 'us-east-1_x', userName: `Google_${sub}`,
    callerContext: { awsSdkVersion: 'x', clientId: 'c' },
    request: { userAttributes: { sub, email: 'owner@example.com', ...extra }, groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [], preferredRole: null } },
    response: { claimsOverrideDetails: {} },
  };
}

function fakeTable(opts: { members?: { PK: string; SK: string; role?: string }[]; profile?: { state?: string } | null }): AuthTable & { findMembers: ReturnType<typeof vi.fn>; getProfile: ReturnType<typeof vi.fn> } {
  return {
    findMembers: vi.fn(async () => opts.members ?? []),
    getProfile: vi.fn(async () => (opts.profile === undefined ? { state: 'active' } : opts.profile)),
  };
}

const add = (e: PreTokenEvent) => e.response.claimsOverrideDetails?.claimsToAddOrOverride;
const suppressed = (e: PreTokenEvent) => e.response.claimsOverrideDetails?.claimsToSuppress;
const member = (role: string, tid = TID) => ({ PK: `TENANT#${tid}`, SK: `MEMBER#${SUB}`, role });

describe('pre-token handler', () => {
  it('sets custom:tenant_id, custom:role and state from the MEMBER# item', async () => {
    const t = fakeTable({ members: [member('owner')] });
    const out = await createHandler(t)(event());
    expect(add(out)).toEqual({ 'custom:tenant_id': TID, 'custom:role': 'owner', 'custom:state': 'active' });
    expect(t.findMembers).toHaveBeenCalledWith(SUB);
    expect(t.getProfile).toHaveBeenCalledWith(TID);
  });

  it('keeps staff as staff', async () => {
    const t = fakeTable({ members: [member('staff')] });
    expect(add(await createHandler(t)(event()))?.['custom:role']).toBe('staff');
  });

  it('gives an unknown user no tenant claim and strips anything already on the user', async () => {
    const t = fakeTable({ members: [] });
    const out = await createHandler(t)(event(SUB, { 'custom:tenant_id': 't_someoneelse1', 'custom:role': 'owner' }));
    expect(add(out)).toBeUndefined();
    expect(suppressed(out)).toEqual(expect.arrayContaining(['custom:tenant_id', 'custom:role', 'custom:state']));
    expect(t.getProfile).not.toHaveBeenCalled();
  });

  it('lets a suspended tenant sign in with state=suspended', async () => {
    const t = fakeTable({ members: [member('owner')], profile: { state: 'suspended' } });
    const out = await createHandler(t)(event());
    expect(add(out)).toEqual({ 'custom:tenant_id': TID, 'custom:role': 'owner', 'custom:state': 'suspended' });
  });

  it('never trusts a client-supplied tenant attribute when the user is a member of a tenant', async () => {
    const t = fakeTable({ members: [member('owner')] });
    const out = await createHandler(t)(event(SUB, { 'custom:tenant_id': 't_attacker0001' }));
    expect(add(out)?.['custom:tenant_id']).toBe(TID);
  });

  it('looks up by the verified sub, not the username or email', async () => {
    const t = fakeTable({ members: [] });
    await createHandler(t)(event(SUB));
    expect(t.findMembers).toHaveBeenCalledWith(SUB);
  });

  it('fails closed on ambiguous membership, bad role, bad tenant id, missing profile or unknown state', async () => {
    const cases = [
      fakeTable({ members: [member('owner', 't_aaaaaaaa01'), member('owner', 't_bbbbbbbb02')] }),
      fakeTable({ members: [member('admin')] }),
      fakeTable({ members: [{ PK: 'TENANT#bad id', SK: `MEMBER#${SUB}`, role: 'owner' }] }),
      fakeTable({ members: [member('owner')], profile: null }),
      fakeTable({ members: [member('owner')], profile: { state: 'deleted' } }),
    ];
    for (const t of cases) {
      const out = await createHandler(t)(event());
      expect(add(out)).toBeUndefined();
      expect(suppressed(out)).toContain('custom:tenant_id');
    }
  });

  it('rejects the sign-in when the table cannot be read, rather than issuing a token without a verdict', async () => {
    const t = fakeTable({});
    t.findMembers.mockRejectedValueOnce(new Error('throttled'));
    await expect(createHandler(t)(event())).rejects.toThrow();
  });

  it('refuses an event with no sub', async () => {
    const e = event();
    delete (e.request.userAttributes as Record<string, string>).sub;
    await expect(createHandler(fakeTable({}))(e)).rejects.toThrow();
  });
});
