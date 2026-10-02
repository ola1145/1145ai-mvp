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
