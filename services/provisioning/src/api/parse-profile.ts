/**
 * Onboarding API: hours/services free text -> validated structures + natural read-back text.
 * Owner: issue D2 (tasks/D2.md). Contract: contracts/openapi/onboarding-internal.yaml
 * (POST /internal/onboarding/{onboardingId}/hours and .../services).
 *
 * The onboarding id comes from the path (bound by the router), never from the body or the model.
 * Persisting the confirmed structures and completing the AwaitProfileComplete task token happen once the owner
 * says the read-back is right; that step belongs to the onboarding state owner, so this handler only parses.
 */
import { bedrockLlm, parseHours, parseServices, type LlmClient } from '../lib/profile-parser.js';

export interface ParseProfileDeps {
  llm: LlmClient;
  now?: () => Date;
}

interface ApiEvent {
  rawPath?: string;
  path?: string;
  pathParameters?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

interface ApiResult { statusCode: number; headers: Record<string, string>; body: string }

const json = (statusCode: number, body: unknown): ApiResult => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export function makeHandler(deps: ParseProfileDeps) {
  return async function handler(event: unknown): Promise<ApiResult> {
    const ev = (event ?? {}) as ApiEvent;
    const path = (ev.rawPath ?? ev.path ?? '').replace(/\/+$/, '');
    const kind = path.endsWith('/hours') ? 'hours' : path.endsWith('/services') ? 'services' : undefined;
    if (!kind) return json(404, { error: 'not_found' });

    const onboardingId = ev.pathParameters?.onboardingId;
    if (!onboardingId) return json(400, { error: 'missing_onboarding_id' });

    let body: unknown;
    try {
      const raw = ev.body ? (ev.isBase64Encoded ? Buffer.from(ev.body, 'base64').toString('utf8') : ev.body) : '{}';
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: 'invalid_json' });
    }
    const b = (typeof body === 'object' && body !== null ? body : {}) as { text?: unknown; timezone?: unknown };
    if (typeof b.text !== 'string' || !b.text.trim()) return json(400, { error: 'text_required' });

    try {
      if (kind === 'hours') {
        const timezone = typeof b.timezone === 'string' ? b.timezone : undefined;
        const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
        return json(200, await parseHours(b.text, { llm: deps.llm, timezone, today }));
      }
      return json(200, await parseServices(b.text, { llm: deps.llm }));
    } catch {
      // The model call itself failed (throttle, outage). The agent retries or tells the owner we hit a snag.
      return json(502, { error: 'model_unavailable' });
    }
  };
}

export const handler = makeHandler({ llm: bedrockLlm() });
