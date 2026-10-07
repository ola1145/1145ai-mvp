/** Usage metering (Add-7). Pricing is tier + usage, so this ships in the MVP. */
export const BILLING_INCREMENT_SEC = 6;

export function billableSeconds(durationSec: number, incrementSec = BILLING_INCREMENT_SEC): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.ceil(durationSec / incrementSec) * incrementSec;
}

export type CapState = 'ok' | 'warn' | 'over';

/** warn at 80% so the admin agent can tell the owner before calls start going to "take a message". */
export function capState(usedSec: number, capSec: number): CapState {
  if (capSec <= 0) return 'over';
  if (usedSec >= capSec) return 'over';
  return usedSec >= capSec * 0.8 ? 'warn' : 'ok';
}

/**
 * The `CallMinutes` metric (contracts/CHANGE_REQUESTS/P7-2.md) as one CloudWatch Embedded Metric Format line: the
 * handler logs it, CloudWatch turns it into a metric, and no SDK call or extra IAM is needed. Namespace and names
 * match `METRICS` in infra/cdk/lib/observability-stack.ts. `TenantId` is a dimension for the ops dashboard only and
 * never feeds billing (billing uses billableSeconds). The call id rides along as a plain field so the saved
 * "trace one call" query finds the line.
 */
export function callMinutesMetric(tenantId: string, callId: string, durationSec: number, at: Date): Record<string, unknown> {
  const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  return {
    _aws: {
      Timestamp: at.getTime(),
      CloudWatchMetrics: [{ Namespace: 'Ai1145', Dimensions: [['TenantId']], Metrics: [{ Name: 'CallMinutes', Unit: 'None' }] }],
    },
    TenantId: tenantId,
    CallMinutes: seconds / 60,
    callId,
  };
}
