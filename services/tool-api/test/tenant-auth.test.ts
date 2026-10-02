import { describe, expect, it } from 'vitest';
import { requireTenantContext } from '../src/lib/tenant-auth.js';
import { makeDeps, voiceEvent } from './fakes.js';

describe('requireTenantContext', () => {
  const { deps } = makeDeps({});

  it('derives tenant from the token', async () => {
    const ctx = await requireTenantContext(voiceEvent({}), 'createBooking', deps);
    expect(ctx.tenantId).toBe('t_tenanta01');
  });
  it('blocks the customer agent from admin tools', async () => {
    await expect(requireTenantContext(voiceEvent({}), 'updateService', deps)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects missing credentials', async () => {
    await expect(requireTenantContext({ headers: {}, requestContext: { requestId: 'r' } }, 'createBooking', deps)).rejects.toMatchObject({ status: 401 });
  });
  it('maps ElevenAgents engine secret + system agent id to a tenant', async () => {
    const ctx = await requireTenantContext({
      headers: { 'x-1145-engine-secret': 'engine-secret', 'x-1145-engine-agent-id': 'agent_A' }, requestContext: { requestId: 'r' },
    }, 'checkAvailability', deps);
    expect(ctx.tenantId).toBe('t_tenanta01');
    expect(ctx.principal).toBe('customer-agent');
  });
  it('rejects a wrong engine secret', async () => {
    await expect(requireTenantContext({
      headers: { 'x-1145-engine-secret': 'nope', 'x-1145-engine-agent-id': 'agent_A' }, requestContext: { requestId: 'r' },
    }, 'checkAvailability', deps)).rejects.toMatchObject({ status: 401 });
  });
  it('takes tenant from Cognito claims for the dashboard', async () => {
    const ctx = await requireTenantContext({
      headers: {}, requestContext: { requestId: 'r', authorizer: { jwt: { claims: { 'custom:tenant_id': 't_tenantb02' } } } },
    }, 'updateHours', deps);
    expect(ctx).toMatchObject({ tenantId: 't_tenantb02', principal: 'owner' });
  });
});
