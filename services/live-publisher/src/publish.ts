/**
 * EventBridge -> AppSync Events (/tenants/<tid>/live), phones masked, internal fields dropped.
 * Owner: issue P6 (tasks/P6.md). Contract: contracts/realtime/channels.md.
 */
export async function handler(_event: unknown): Promise<unknown> {
  throw new Error('publish not implemented (P6)');
}
