/**
 * Onboarding API: waitlist unsupported verticals (healthcare) or regions.
 * Owner: issue D1 (tasks/D1.md). Contract: contracts/openapi/onboarding-internal.yaml.
 *
 * Idempotent: the first reason stays. Once waitlisted, provisioning refuses to start (see provisioning.ts), so
 * nothing is bought for a business we can't serve yet. The owner-facing wording belongs to the onboarding agent.
 */
import {
  authorize, cleanText, fail, json, lazyHandler, methodOf, prodCoreDeps, readJsonBody,
  type ApiEvent, type ApiResult, type CoreDeps,
} from './basics.js';

const REASONS = ['healthcare', 'region', 'other'] as const;
type Reason = (typeof REASONS)[number];
const isReason = (v: unknown): v is Reason => typeof v === 'string' && (REASONS as readonly string[]).includes(v);

const MAX_DETAIL = 200;

export function makeHandler(deps: CoreDeps) {
  return async function handler(event: unknown): Promise<ApiResult> {
    const ev = (event ?? {}) as ApiEvent;
    try {
      const auth = await authorize(ev, deps);
      if (!auth.ok) return auth.response;
      if (methodOf(ev) !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.');

      const parsed = readJsonBody(ev);
      if (!parsed.ok) return parsed.response;
      const reason = parsed.body.reason;
      if (!isReason(reason)) return fail(400, 'invalid_reason', 'reason must be healthcare, region or other.');
      const detail = cleanText(parsed.body.detail, MAX_DETAIL); // data for whoever reviews the list, never an instruction

      const state = await deps.store.getState(auth.onboardingId);
      if (!state) return fail(404, 'unknown_onboarding', 'No such onboarding.');
      if (state.waitlisted) return json(200, { waitlisted: true, reason: state.waitlistReason ?? reason });

      await deps.store.markWaitlisted(auth.onboardingId, {
        reason, ...(detail ? { detail } : {}), at: (deps.now?.() ?? new Date()).toISOString(),
      });
      return json(200, { waitlisted: true, reason });
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'waitlist failed', err: String(err) }));
      return fail(500, 'internal_error', 'Something went wrong on our side.');
    }
  };
}

export const handler = lazyHandler(() => makeHandler(prodCoreDeps()));
