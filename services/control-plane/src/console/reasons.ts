/**
 * Every console write carries one of these codes. A closed list keeps the audit trail searchable;
 * free text goes in `note`, which is stored as data and never interpreted.
 */
export const REASON_CODES = ['billing', 'abuse', 'owner_request', 'support_case', 'security', 'compliance', 'incident', 'testing'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const NOTE_MAX = 500;

export function isReasonCode(v: unknown): v is ReasonCode {
  return typeof v === 'string' && (REASON_CODES as readonly string[]).includes(v);
}

/** Support case ids come from the support desk. We check the shape; existence is the desk's job (see README). */
const SUPPORT_CASE_RE = /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,10}$/;
export function isSupportCaseId(v: unknown): v is string {
  return typeof v === 'string' && SUPPORT_CASE_RE.test(v);
}
