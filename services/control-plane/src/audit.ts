/**
 * Audit writer: one JSON object per entry in the Object Lock bucket. Owner: issue H1 (tasks/H1.md).
 *
 * Rules, all deterministic:
 *  - Every entry names who did it (`actor`), why (`reasonCode`) and what (`action`) for one tenant.
 *  - The bucket has Object Lock, which refuses puts without an integrity header. Every put carries Content-MD5
 *    (what Object Lock asks for) and a SHA-256 checksum (so S3 verifies the bytes with a strong hash too).
 *  - A failed put throws. Callers write the entry BEFORE they change anything, so a change that could not be
 *    recorded does not happen (see set-tenant-state.ts).
 *  - The key is built from validated parts only, and every write gets its own key, so nothing is overwritten.
 *
 * Key layout (shared by every writer, see contracts/CHANGE_REQUESTS/H2-1.md):
 *   audit/<yyyy>/<mm>/<dd>/<tenantId>/<iso with : and . as ->-<uuid>.json
 */
import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { asTenantId } from '@1145/shared';

export interface AuditEntry {
  tenantId: string;
  /** What happened, for example `state:suspended` or `billing:invoice.paid`. */
  action: string;
  /** Why. Lower snake case, for example `billing` or `owner_request`. */
  reasonCode: string;
  /** Who. An IAM ARN for staff, `billing` for Stripe-driven changes, `system` for jobs. */
  actor: string;
  /** ISO 8601 UTC, `YYYY-MM-DDTHH:mm:ss(.sss)Z`. */
  at: string;
  requestId?: string;
  supportCaseId?: string;
  /** Free text from a human. Stored as data, never interpreted. */
  note?: string;
  detail?: Record<string, unknown>;
}

export class AuditEntryError extends Error {
  constructor(readonly field: string, message?: string) {
    super(`invalid audit entry: ${field}${message ? ` (${message})` : ''}`);
    this.name = 'AuditEntryError';
  }
}

/** Entries are small facts. Anything bigger belongs in the thing being audited, not in the audit trail. */
export const AUDIT_BODY_MAX_BYTES = 32 * 1024;

const ACTION_RE = /^[A-Za-z][A-Za-z0-9_.:-]{1,79}$/;
const REASON_RE = /^[a-z][a-z0-9_]{1,63}$/;
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PLAIN_TEXT_RE = /^[^\u0000-\u001f\u007f]*$/;

function assertText(field: string, v: unknown, max: number, min = 1): asserts v is string {
  if (typeof v !== 'string' || v.length < min || v.length > max || !PLAIN_TEXT_RE.test(v)) throw new AuditEntryError(field);
}

/** Checks everything that ends up in the key or that makes an entry useless as evidence. Throws AuditEntryError. */
export function validateAuditEntry(e: AuditEntry): void {
  try { asTenantId(e.tenantId); } catch { throw new AuditEntryError('tenantId'); }
  if (typeof e.action !== 'string' || !ACTION_RE.test(e.action)) throw new AuditEntryError('action');
  if (typeof e.reasonCode !== 'string' || !REASON_RE.test(e.reasonCode)) throw new AuditEntryError('reasonCode', 'lower snake case, required');
  assertText('actor', e.actor, 1024);
  if (typeof e.at !== 'string' || !AT_RE.test(e.at) || Number.isNaN(Date.parse(e.at))) throw new AuditEntryError('at', 'ISO 8601 UTC');
  if (e.requestId !== undefined) assertText('requestId', e.requestId, 128);
  if (e.supportCaseId !== undefined) assertText('supportCaseId', e.supportCaseId, 64);
  if (e.note !== undefined) assertText('note', e.note, 500, 0);
  if (e.detail !== undefined && (e.detail === null || typeof e.detail !== 'object' || Array.isArray(e.detail))) throw new AuditEntryError('detail');
}

export function auditKey(e: Pick<AuditEntry, 'tenantId' | 'at'>, id: string = randomUUID()): string {
  try { asTenantId(e.tenantId); } catch { throw new AuditEntryError('tenantId'); }
  if (typeof e.at !== 'string' || !AT_RE.test(e.at)) throw new AuditEntryError('at', 'ISO 8601 UTC');
  const [yyyy, mm, dd] = e.at.slice(0, 10).split('-');
  return `audit/${yyyy}/${mm}/${dd}/${e.tenantId}/${e.at.replace(/[:.]/g, '-')}-${id}.json`;
}

/** Only known fields are written, in a fixed shape, so a stray property on a caller's object never reaches the trail. */
function auditBody(e: AuditEntry, source: string | undefined): string {
  let body: string;
  try {
    body = JSON.stringify({
      schema: 1,
      ...(source ? { source } : {}),
      tenantId: e.tenantId,
      action: e.action,
      reasonCode: e.reasonCode,
      actor: e.actor,
      at: e.at,
      ...(e.requestId !== undefined ? { requestId: e.requestId } : {}),
      ...(e.supportCaseId !== undefined ? { supportCaseId: e.supportCaseId } : {}),
      ...(e.note !== undefined ? { note: e.note } : {}),
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
    });
  } catch {
    throw new AuditEntryError('detail', 'not serialisable');
  }
  if (Buffer.byteLength(body, 'utf8') > AUDIT_BODY_MAX_BYTES) throw new AuditEntryError('entry', 'too large');
  return body;
}

export interface AuditWriterOptions {
  /** Which service wrote the entry; stored in the object so a reader can tell writers apart. */
  source?: string;
  newId?: () => string;
}

export function auditWriter(
  s3: Pick<S3Client, 'send'>,
  bucket: string,
  opts: AuditWriterOptions = {},
): (e: AuditEntry) => Promise<void> {
  const newId = opts.newId ?? randomUUID;
  return async (entry) => {
    validateAuditEntry(entry);
    const body = auditBody(entry, opts.source);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: auditKey(entry, newId()),
      Body: body,
      ContentType: 'application/json',
      ContentMD5: createHash('md5').update(body).digest('base64'),
      ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
    }));
  };
}
