/**
 * Onboarding API: set agent name, complete the agentName task token.
 * Owner: issue D3 (tasks/D3.md). Contract: contracts/openapi/onboarding-internal.yaml
 *   POST /internal/onboarding/{onboardingId}/agent-name  (nameAgent)
 *
 * The name is saved on the onboarding record (always) and on TENANT#<tid>/PROFILE.agentName (when the profile exists),
 * which is where the render step reads it. Then the waiting AwaitAgentName step is completed with the stored task
 * token. Auth, id handling and the Step Functions call are the same as facts.ts, so they live there.
 *
 * The name is spoken to every caller and written into the receptionist's instructions, so it is held to what a name
 * looks like: a few words of letters, never markup, never something that reads like an instruction.
 */
import { detectInstructionLike } from '../lib/sanitize.js';
import {
  completeStep, fail, json, nowIso, readJson, serve, serveProd,
  type ApiEvent, type ApiResult, type OnboardingApiDeps,
} from './facts.js';

const MIN_LENGTH = 2;
const MAX_DIGITS = 3; // "Ola 2" is a name; a phone number read out loud is not
// A letter first, then letters, marks, digits, spaces and . ' ’ -, up to 40 characters in all.
const NAME_RE = /^\p{L}[\p{L}\p{M}\p{N} .'’-]{0,39}$/u;

export type NormalizedName = { ok: true; name: string } | { ok: false };

export function normalizeAgentName(raw: unknown): NormalizedName {
  if (typeof raw !== 'string') return { ok: false };
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name.length < MIN_LENGTH || !NAME_RE.test(name)) return { ok: false };
  if ((name.match(/\p{N}/gu) ?? []).length > MAX_DIGITS) return { ok: false };
  if (detectInstructionLike(name).length) return { ok: false };
  return { ok: true, name };
}

async function nameAgent(deps: OnboardingApiDeps, event: ApiEvent, onboardingId: string): Promise<ApiResult> {
  const body = readJson(event);
  if (!body.ok) return fail(400, 'invalid_json', 'The request body is not valid JSON.');
  const value = typeof body.value === 'object' && body.value !== null && !Array.isArray(body.value) ? (body.value as { name?: unknown }).name : undefined;
  const n = normalizeAgentName(value);
  if (!n.ok) {
    return fail(400, 'invalid_name', 'The name needs to be 2 to 40 characters, starting with a letter, with no markup.', {
      messageForOwner: "That one won't work as a name. Something short, like Ava or Mr. Fade, is perfect.",
    });
  }

  const rec = await deps.store.getOnboarding(onboardingId);
  if (!rec) return fail(404, 'onboarding_not_found', 'No onboarding with that id.');
  // Once the step has completed the setup moves on with this name, so a different one would only half apply.
  if (rec.agentNameLockedAt && rec.agentName !== n.name) {
    return fail(409, 'already_named', 'The receptionist was already named and setup has moved on.', {
      messageForOwner: `Your receptionist is already named ${rec.agentName}, so that can't change during setup.`,
    });
  }

  const { profileUpdated } = await deps.store.saveAgentName(onboardingId, rec.tenantId, n.name, nowIso(deps));
  // Read again after the write so a task token stored in the meantime is not missed (see decideFacts in facts.ts).
  const fresh = (await deps.store.getOnboarding(onboardingId)) ?? rec;
  const workflow = await completeStep(deps, fresh, 'agentName', { agentName: n.name });
  return json(200, { name: n.name, profileUpdated, workflow });
}

export function makeAgentNameHandler(deps: OnboardingApiDeps): (event: unknown) => Promise<ApiResult> {
  return (event) => serve(deps, event, async (c) => {
    if (!c.path.endsWith('/agent-name')) return fail(404, 'not_found', 'No such route.');
    if (c.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST to name the receptionist.');
    return nameAgent(deps, c.event, c.onboardingId);
  });
}

export const handler = (event: unknown): Promise<ApiResult> => serveProd(makeAgentNameHandler, event);
