/**
 * Onboarding API: waitlist unsupported verticals (healthcare).
 * Owner: issue D1 (tasks/D1.md). Contract: contracts/openapi/onboarding-internal.yaml.
 */
export async function handler(_event: unknown): Promise<unknown> {
  throw new Error('waitlist not implemented (D1)');
}
