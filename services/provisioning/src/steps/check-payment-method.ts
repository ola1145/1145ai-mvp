/**
 * Step: CheckPaymentMethod. The gate in front of every purchase: no card on file, no number (abuse control).
 * Owner: issue D9 (tasks/D9.md).
 *
 * Runs first in the provisioning state machine, before SearchNumber/OrderNumber. Until a usable card is attached to the
 * onboarding's Stripe customer it fails with `NeedsPaymentMethod`, and the state machine retries it on a slow schedule
 * (see CR D9-2). The first time through it tells the owner, in chat, where to add the card (a Stripe-hosted page; our code
 * never sees card details). Later polls stay quiet so the owner is not nagged, with one gentle reminder and a fresh
 * link if the quiet stretch gets long. When the card lands it says thanks and lets the workflow move on.
 *
 * Output (`$.payment`): { customerId, paymentMethodId, cardFingerprint?, funding? }. The fingerprint is what trial caps
 * and referral rewards (H3) can dedupe on so one card does not farm several trials.
 *
 * tenantId and onboardingId come from the workflow input, which the start endpoint set server-side; nothing here reads
 * them from model output or a request body.
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { asTenantId, makeEvent } from '@1145/shared';
import {
  ensureCustomer, firstUsableCard, isValidOnboardingId, ownerCopy, productionPayments,
  type PaymentGateway, type PaymentStore,
} from '../api/payment-setup.js';

/** The workflow's Retry matches this by name. It means "waiting on the owner", not "something broke". */
export class NeedsPaymentMethodError extends Error {
  constructor() { super('no usable card on file yet'); this.name = 'NeedsPaymentMethod'; }
}

/** `onboarding.status` data plus the ids it travels under (contracts/events/events.schema.json). */
export interface OnboardingStatus {
  tenantId: string;
  onboardingId: string;
  step: 'number';
  state: 'started' | 'waiting_owner' | 'done' | 'failed';
  messageForOwner: string;
}
export type StatusEmitter = (status: OnboardingStatus) => Promise<void>;

export interface CheckPaymentInput { onboardingId?: unknown; tenantId?: unknown }
export interface CheckPaymentDeps {
  gateway: PaymentGateway;
  store: PaymentStore;
  emit: StatusEmitter;
  now?: () => Date;
  /** How long to stay quiet before reminding the owner with a fresh link. Default 6 hours. */
  nudgeAfterMs?: number;
}
export interface PaymentCheckResult { customerId: string; paymentMethodId: string; cardFingerprint?: string; funding?: string }

const DEFAULT_NUDGE_AFTER_MS = 6 * 3600_000;

export async function checkPaymentMethod(input: CheckPaymentInput, deps: CheckPaymentDeps): Promise<PaymentCheckResult> {
  if (!isValidOnboardingId(input.onboardingId)) throw new Error('check-payment-method needs a valid onboardingId');
  if (typeof input.tenantId !== 'string') throw new Error('check-payment-method needs a tenantId');
  const onboardingId = input.onboardingId;
  const tenantId = asTenantId(input.tenantId);
  const now = (deps.now ?? (() => new Date()))();
  const status = (state: OnboardingStatus['state'], copy: { messageForOwner: string }): OnboardingStatus => ({ tenantId, onboardingId, step: 'number', state, ...copy });

  const record = await deps.store.get(onboardingId);
  const card = record ? firstUsableCard(await deps.gateway.listCards(record.customerId), now) : undefined;

  if (record && card) {
    if (record.promptedAt) await deps.emit(status('started', ownerCopy.cardReceived())); // they were asked, so answer them
    return {
      customerId: record.customerId,
      paymentMethodId: card.paymentMethodId,
      ...(card.fingerprint ? { cardFingerprint: card.fingerprint } : {}),
      ...(card.funding ? { funding: card.funding } : {}),
    };
  }

  const askedAt = record?.promptedAt ? Date.parse(record.promptedAt) : undefined;
  const nudgeAfter = deps.nudgeAfterMs ?? DEFAULT_NUDGE_AFTER_MS;
  const due = askedAt === undefined || (Number.isFinite(askedAt) && now.getTime() - askedAt >= nudgeAfter);
  if (due) {
    const customer = record ?? await ensureCustomer(onboardingId, deps);
    const session = await deps.gateway.createSetupSession({ customerId: customer.customerId, onboardingId });
    // Send first, then note it: if sending fails the step is retried and the owner is asked again, never skipped.
    await deps.emit(status('waiting_owner', askedAt === undefined ? ownerCopy.askForCard(session.url) : ownerCopy.remindAboutCard(session.url)));
    await deps.store.markPrompted(onboardingId, now);
  }
  throw new NeedsPaymentMethodError();
}

/** onboarding.status on the 1145 bus, keyed to the tenant, with the onboarding id as correlation id. */
export function ebStatusEmitter(eb: { send(cmd: any): Promise<any> }, busName: string, now: () => Date = () => new Date()): StatusEmitter {
  return async (s) => {
    const event = makeEvent('onboarding.status', { tenantId: asTenantId(s.tenantId), correlationId: s.onboardingId }, {
      step: s.step, state: s.state, messageForOwner: s.messageForOwner,
    }, now());
    const out = await eb.send(new PutEventsCommand({ Entries: [{ EventBusName: busName, Source: '1145.provisioning', DetailType: event.type, Detail: JSON.stringify(event) }] }));
    if (out?.FailedEntryCount) throw new Error('EventBridge rejected the onboarding.status event'); // PutEvents can fail without throwing
  };
}

/** Step Functions entry: the whole workflow state arrives as the event (onboardingId and tenantId are set server-side). */
export async function handler(event: CheckPaymentInput): Promise<PaymentCheckResult> {
  const busName = process.env.EVENT_BUS_NAME;
  if (!busName) throw new Error('EVENT_BUS_NAME is not set');
  const { gateway, store } = await productionPayments();
  return checkPaymentMethod(event, { gateway, store, emit: ebStatusEmitter(new EventBridgeClient({}), busName) });
}
