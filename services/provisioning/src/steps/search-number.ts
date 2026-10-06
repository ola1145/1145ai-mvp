import { loadTelnyxConfig, telnyxClient, type TelnyxClient } from '../lib/telnyx.js';
import { NoNumberAvailableError } from './order-number.js';

/**
 * Step: search-number (free; nothing is bought here).
 * Looks for local US numbers near the business: the owner's area code first, then the whole state.
 * The area values come from owner chat, so they are validated as data and dropped if malformed.
 */
export interface SearchNumberInput {
  onboardingId?: string; tenantId?: string;
  area?: { areaCode?: unknown; state?: unknown; locality?: unknown };
}
export interface SearchNumberResult { candidates: string[]; matchedOn: 'area_code' | 'state' }

const AREA_CODE_RE = /^[2-9]\d{2}$/;
const STATE_RE = /^[A-Z]{2}$/;
const US_E164_RE = /^\+1[2-9]\d{9}$/;
const CANDIDATES = 10;

const cleanAreaCode = (v: unknown): string | undefined => (typeof v === 'string' && AREA_CODE_RE.test(v.trim()) ? v.trim() : undefined);
const cleanState = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return STATE_RE.test(s) ? s : undefined;
};
const usable = (numbers: string[]): string[] => [...new Set(numbers.filter((n) => US_E164_RE.test(n)))];

export async function searchNumber(input: SearchNumberInput, deps: { telnyx: Pick<TelnyxClient, 'searchLocal'> }): Promise<SearchNumberResult> {
  const areaCode = cleanAreaCode(input.area?.areaCode);
  const state = cleanState(input.area?.state);

  if (areaCode) {
    const found = usable(await deps.telnyx.searchLocal({ areaCode, limit: CANDIDATES }));
    if (found.length) return { candidates: found, matchedOn: 'area_code' };
  }
  if (state) {
    const found = usable(await deps.telnyx.searchLocal({ state, limit: CANDIDATES }));
    if (found.length) return { candidates: found, matchedOn: 'state' };
  }
  throw new NoNumberAvailableError();
}

/** Step Functions entry: the whole workflow state arrives as the event; `area` is written by the basics step. */
export async function handler(event: SearchNumberInput): Promise<SearchNumberResult> {
  const cfg = await loadTelnyxConfig();
  return searchNumber(event, { telnyx: telnyxClient(cfg.apiKey) });
}
