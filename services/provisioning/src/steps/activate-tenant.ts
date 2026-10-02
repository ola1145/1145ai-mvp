/**
 * Step: activate-tenant
 * Set PROFILE.state=active, flip IDENTITY route to the tenant, emit tenant.provisioned. Submit async unlocks (10DLC brand, WABA) as separate executions.
 * TODO(W1-13): implement with injected deps; write the test first (see tasks/wave-1/W1-13-provisioning.md).
 */
export async function activateTenant(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  throw new Error('activate-tenant not implemented (W1-13)');
}
