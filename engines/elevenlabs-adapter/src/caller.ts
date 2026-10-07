/**
 * The caller's number from an ElevenLabs call record (CR G2-3): the carrier's caller ID as ElevenLabs recorded it
 * for an INBOUND call, in E.164. Never anything said in the conversation. On an outbound call the external party is
 * the person we dialled (the owner, on a smoke call), so no caller is reported.
 *
 * Payload path: `data.metadata.phone_call.{direction, external_number}` as in the ElevenLabs API definition. Nothing
 * recorded from a live inbound call confirms it yet (W0-03 spike); until then a missing or odd value just means no
 * caller number, which post-call handles.
 */
const E164 = /^\+[1-9]\d{6,14}$/;
// Placeholders carriers send when the caller hides their ID (the digits spell anonymous, unavailable, restricted).
const WITHHELD = new Set(['+266696687', '+86282452253', '+7378742833']);

export function callerE164FromPhoneCall(phoneCall: unknown): string | undefined {
  if (typeof phoneCall !== 'object' || phoneCall === null) return undefined;
  const { direction, external_number: raw } = phoneCall as { direction?: unknown; external_number?: unknown };
  if (direction !== 'inbound' || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('+')) return undefined;
  const candidate = `+${trimmed.replace(/\D/g, '')}`;
  return E164.test(candidate) && !WITHHELD.has(candidate) ? candidate : undefined;
}
