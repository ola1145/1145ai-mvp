import { randomInt } from 'node:crypto';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hmacSha256, safeEqual, type Channel, type Principal } from '@1145/shared';
import { HttpError } from './http.js';
import type { AuthDeps } from './tenant-auth.js';
import type { Service, TenantRepo, ToolDeps } from './repo.js';

/**
 * Propose/confirm for owner-facing changes (ADR: the admin agent can only propose).
 * A change lives for 30 minutes under a 4-digit code that is unique among the tenant's OPEN changes.
 * The owner applies it by replying "CONFIRM <code>" in a bound channel (router mints an owner token) or in the dashboard.
 * Price changes also need a dashboard step-up token.
 */
export const CHANGE_TTL_MS = 30 * 60_000;
export const CHANGE_KINDS = ['hours', 'service', 'closed_date', 'handoff_number'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface ChangeRecord {
  changeId: string;
  code: string;
  kind: ChangeKind;
  /** Normalised and whitelisted: never the raw model output. */
  payload: Record<string, unknown>;
  summary: string;
  requiresStepUp: boolean;
  status: 'pending' | 'applied';
  createdAt: string;
  expiresAt: string;
  proposedBy: Principal;
  appliedAt?: string;
}

export interface AuditEntry {
  changeId: string;
  kind: ChangeKind;
  summary: string;
  principal: Principal;
  channel: Channel;
  stepUp: boolean;
  at: string;
  correlationId: string;
}

/**
 * Persistence for changes. Expected to hang off TenantRepo as `repo.changes` (change request T2-1), so it is
 * implicitly scoped to one tenant like every other repo method.
 */
export interface ChangeStore {
  /** Atomically claim `rec.code`. False when the code is held by another OPEN (pending, unexpired) change. */
  createChange(rec: ChangeRecord, nowIso: string): Promise<boolean>;
  getByCode(code: string): Promise<ChangeRecord | undefined>;
  /** Atomically: flip pending -> applied, write the payload, write the audit entry. False if it is no longer pending. */
  commitApplied(rec: ChangeRecord, audit: AuditEntry): Promise<boolean>;
}

export type ChangeDeps = ToolDeps & AuthDeps & {
  /** Step-up signing secrets (STEP_UP_SECRET, current + previous). Falls back to process.env.STEP_UP_SECRET. */
  stepUpSecrets?: () => Promise<readonly string[]>;
  /** Test seam for code generation. */
  randomInt?: (maxExclusive: number) => number;
};

export function changeStoreOf(repo: TenantRepo): ChangeStore {
  const store = (repo as TenantRepo & { changes?: ChangeStore }).changes;
  if (!store) throw new HttpError(501, 'not_implemented', 'repo has no change store yet', "I can't save changes just yet.");
  return store;
}

// ---- errors with natural lines ---------------------------------------------------------------------------------

const badChange = (message: string) =>
  new HttpError(400, 'invalid', message, "I couldn't quite follow that change. Can you tell me what to update again?");
export const notFound = () =>
  new HttpError(404, 'change_not_found', 'no open change with that code',
    "I don't see an open change with that code. It may already be done or have timed out.");
export const stepUpRequired = () =>
  new HttpError(428, 'step_up_required', 'price changes need a dashboard step-up token',
    "That's a price change, so I need you to confirm it in the app first.");

// ---- step-up tokens --------------------------------------------------------------------------------------------

/** Compact HS256 token the dashboard mints after the owner re-confirms. Signed with STEP_UP_SECRET, never the tenant-token secret. */
export interface StepUpClaims { tid: string; sub?: string; aud: 'step-up'; iat: number; exp: number }
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function mintStepUpToken(
  claims: { tid: string; sub?: string }, secret: string, ttlSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const head = b64({ alg: 'HS256', typ: 'step-up' });
  const body = b64({ ...claims, aud: 'step-up', iat: nowSeconds, exp: nowSeconds + ttlSeconds });
  return `${head}.${body}.${hmacSha256(secret, `${head}.${body}`).toString('base64url')}`;
}

export function verifyStepUpToken(
  token: string | undefined, secrets: readonly string[], tenantId: string, nowSeconds: number,
): boolean {
  if (!token || secrets.length === 0) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [h, p, s] = parts as [string, string, string];
  try {
    if ((JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string }).alg !== 'HS256') return false;
    if (!secrets.some((sec) => safeEqual(hmacSha256(sec, `${h}.${p}`).toString('base64url'), s))) return false;
    const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Partial<StepUpClaims>;
    return c.aud === 'step-up' && c.tid === tenantId && typeof c.exp === 'number' && c.exp > nowSeconds;
  } catch {
    return false;
  }
}

export async function stepUpSecretsOf(deps: ChangeDeps): Promise<readonly string[]> {
  if (deps.stepUpSecrets) return deps.stepUpSecrets();
  return process.env.STEP_UP_SECRET ? [process.env.STEP_UP_SECRET] : [];
}

// ---- payload validation + summaries ---------------------------------------------------------------------------

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Owner and model free text is data. Strip control characters and angle brackets, collapse spaces, cap length. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

const asObject = (v: unknown, name: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw badChange(`${name} must be an object`);
  return v as Record<string, unknown>;
};

function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

function money(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function humanDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

interface Normalised { payload: Record<string, unknown>; summary: string; requiresStepUp: boolean }

function normaliseHours(raw: Record<string, unknown>): Normalised {
  const timezone = cleanText(raw.timezone, 60);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { throw badChange('timezone must be an IANA zone'); }
  if (!Array.isArray(raw.weekly) || raw.weekly.length === 0 || raw.weekly.length > 28) throw badChange('weekly needs 1 to 28 windows');
  const weekly = raw.weekly.map((w) => {
    const o = asObject(w, 'weekly[]');
    const day = o.day; const open = o.open; const close = o.close;
    if (!Number.isInteger(day) || (day as number) < 0 || (day as number) > 6) throw badChange('day must be 0 to 6');
    if (typeof open !== 'string' || typeof close !== 'string' || !HHMM.test(open) || !HHMM.test(close) || open >= close) {
      throw badChange('open and close must be HH:MM with open before close');
    }
    return { day: day as number, open, close };
  });
  const perDay = new Map<number, string[]>();
  for (const w of [...weekly].sort((a, b) => a.open.localeCompare(b.open))) {
    perDay.set(w.day, [...(perDay.get(w.day) ?? []), `${clock(w.open)} to ${clock(w.close)}`]);
  }
  const segments: Array<{ days: number[]; windows: string }> = [];
  for (const day of DAY_ORDER) {
    const windows = perDay.get(day)?.join(' and ');
    if (!windows) continue;
    const last = segments[segments.length - 1];
    const prev = last?.days[last.days.length - 1];
    const adjacent = prev !== undefined && DAY_ORDER.indexOf(prev) + 1 === DAY_ORDER.indexOf(day);
    if (last && last.windows === windows && adjacent) last.days.push(day);
    else segments.push({ days: [day], windows });
  }
  const label = (days: number[]) => (days.length === 1 ? DAY_NAMES[days[0]!]! : `${DAY_NAMES[days[0]!]} to ${DAY_NAMES[days[days.length - 1]!]}`);
  const summary = `Open ${joinAnd(segments.map((s) => `${label(s.days)} ${s.windows}`))}.`;
  return { payload: { timezone, weekly }, summary, requiresStepUp: false };
}

async function normaliseService(raw: Record<string, unknown>, repo: TenantRepo): Promise<Normalised> {
  const serviceId = cleanText(raw.serviceId, 80);
  if (!serviceId || serviceId.includes('#')) throw badChange('serviceId is required');
  const patch: Record<string, unknown> = { serviceId };
  if (raw.name !== undefined) {
    const name = cleanText(raw.name, 80);
    if (!name) throw badChange('name cannot be empty');
    patch.name = name;
  }
  if (raw.durationMin !== undefined) {
    if (!Number.isInteger(raw.durationMin) || (raw.durationMin as number) < 5 || (raw.durationMin as number) > 480) throw badChange('durationMin must be 5 to 480');
    patch.durationMin = raw.durationMin;
  }
  if (raw.priceCents !== undefined) {
    if (!Number.isInteger(raw.priceCents) || (raw.priceCents as number) < 0 || (raw.priceCents as number) > 10_000_000) throw badChange('priceCents must be a whole number of cents');
    patch.priceCents = raw.priceCents;
  }
  if (raw.active !== undefined) {
    if (typeof raw.active !== 'boolean') throw badChange('active must be true or false');
    patch.active = raw.active;
  }
  if (Object.keys(patch).length === 1) throw badChange('nothing to change on that service');

  const service: Service | undefined = await repo.getService(serviceId);
  if (!service) throw new HttpError(404, 'unknown_service', 'service not found', "I couldn't find that service. Which one do you mean?");
  const label = cleanText(service.name, 60).toLowerCase() || 'service';

  const sentences: string[] = [];
  if (patch.priceCents !== undefined) sentences.push(`Change the ${label} price to ${money(patch.priceCents as number)}.`);
  if (patch.durationMin !== undefined) sentences.push(`Make the ${label} ${patch.durationMin} minutes.`);
  if (patch.active === false) sentences.push(`Stop offering the ${label}.`);
  if (patch.active === true) sentences.push(`Offer the ${label} again.`);
  if (patch.name !== undefined) sentences.push(`Rename the ${label} to ${patch.name as string}.`);
  return { payload: patch, summary: sentences.join(' '), requiresStepUp: patch.priceCents !== undefined };
}

function normaliseClosedDate(raw: Record<string, unknown>, now: Date): Normalised {
  const date = typeof raw.date === 'string' ? raw.date : '';
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : undefined;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw badChange('date must be YYYY-MM-DD');
  if (parsed.getTime() < now.getTime() - 2 * 86_400_000) throw badChange('date is in the past');
  const reason = cleanText(raw.reason, 60).replace(/^for\s+/i, '').replace(/[.!,;:\s]+$/, '');
  const payload: Record<string, unknown> = reason ? { date, reason } : { date };
  return { payload, summary: reason ? `Close ${humanDate(date)} for ${reason}.` : `Close ${humanDate(date)}.`, requiresStepUp: false };
}

function normaliseHandoff(raw: Record<string, unknown>): Normalised {
  const e164 = typeof raw.e164 === 'string' ? raw.e164 : '';
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) throw badChange('e164 must be a phone number like +12145550123');
  return { payload: { e164 }, summary: `Send transfers to the number ending in ${e164.slice(-4)}.`, requiresStepUp: false };
}

export async function normaliseChange(kind: unknown, payload: unknown, repo: TenantRepo, now: Date): Promise<Normalised & { kind: ChangeKind }> {
  if (typeof kind !== 'string' || !(CHANGE_KINDS as readonly string[]).includes(kind)) throw badChange('unknown change kind');
  const raw = asObject(payload, 'payload');
  const k = kind as ChangeKind;
  switch (k) {
    case 'hours': return { kind: k, ...normaliseHours(raw) };
    case 'service': return { kind: k, ...(await normaliseService(raw, repo)) };
    case 'closed_date': return { kind: k, ...normaliseClosedDate(raw, now) };
    case 'handoff_number': return { kind: k, ...normaliseHandoff(raw) };
  }
}

// ---- code allocation -------------------------------------------------------------------------------------------

const CODE_ATTEMPTS = 8;

/** Draw codes until the store accepts one. Uniqueness among open changes is enforced by the store, not by a read-then-write. */
export async function allocateChange(
  store: ChangeStore, base: Omit<ChangeRecord, 'code'>, draw: (max: number) => number, nowIso: string,
): Promise<ChangeRecord> {
  for (let i = 0; i < CODE_ATTEMPTS; i++) {
    const rec: ChangeRecord = { ...base, code: String(draw(10_000)).padStart(4, '0') };
    if (await store.createChange(rec, nowIso)) return rec;
  }
  throw new HttpError(503, 'no_free_code', 'could not find a free confirmation code',
    "I'm having trouble setting that up right now. Try again in a minute.");
}

export const defaultDraw = (max: number): number => randomInt(max);

// ---- DynamoDB implementation (to be wired into ddbRepoFor via change request T2-1) -----------------------------

const CODE_SK = (code: string) => `CHANGECODE#${code}`;
const errName = (e: unknown) => (e as { name?: string }).name;

type Doc = Pick<DynamoDBDocumentClient, 'send'>;

/**
 * Items (all under PK TENANT#<tid>, so the tenant role's LeadingKeys condition covers them):
 *   CHANGECODE#<code>          the change itself; the code IS the sort key, so a conditional put makes it unique among open changes
 *   AUDIT#<iso>#<changeId>     one per applied change
 * `ttl` removes old change items a day after they expire; the audit items have no ttl.
 */
export function ddbChangeStore(doc: Doc, table: string, tenantId: string): ChangeStore {
  const PK = `TENANT#${tenantId}`;
  return {
    async createChange(rec, nowIso) {
      try {
        await doc.send(new PutCommand({
          TableName: table,
          Item: { PK, SK: CODE_SK(rec.code), ...rec, ttl: Math.floor(new Date(rec.expiresAt).getTime() / 1000) + 86_400 },
          ConditionExpression: 'attribute_not_exists(PK) OR #s <> :pending OR expiresAt <= :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':pending': 'pending', ':now': nowIso },
        }));
        return true;
      } catch (err) {
        if (errName(err) === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },

    async getByCode(code) {
      const r = await doc.send(new GetCommand({ TableName: table, Key: { PK, SK: CODE_SK(code) }, ConsistentRead: true }));
      if (!r.Item) return undefined;
      const { PK: _pk, SK: _sk, ttl: _ttl, ...rec } = r.Item;
      return rec as ChangeRecord;
    },

    async commitApplied(rec, audit) {
      const cond = {
        ConditionExpression: '#s = :pending AND changeId = :cid AND expiresAt > :at',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':pending': 'pending', ':cid': rec.changeId, ':at': audit.at, ':applied': 'applied' },
      };
      try {
        await doc.send(new TransactWriteCommand({
          TransactItems: [
            { Update: { TableName: table, Key: { PK, SK: CODE_SK(rec.code) }, UpdateExpression: 'SET #s = :applied, appliedAt = :at', ...cond } },
            { Put: { TableName: table, Item: { PK, SK: `AUDIT#${audit.at}#${audit.changeId}`, ...audit } } },
            payloadWrite(table, PK, rec),
          ],
        }));
        return true;
      } catch (err) {
        if (errName(err) === 'TransactionCanceledException') return false;
        throw err;
      }
    },
  };
}

/** The write that makes the change real. Only whitelisted, validated fields reach here (see normaliseChange). */
function payloadWrite(table: string, PK: string, rec: ChangeRecord) {
  const p = rec.payload;
  switch (rec.kind) {
    case 'hours':
      return { Update: { TableName: table, Key: { PK, SK: 'HOURS' }, UpdateExpression: 'SET #tz = :tz, weekly = :w',
        ExpressionAttributeNames: { '#tz': 'timezone' }, ExpressionAttributeValues: { ':tz': p.timezone, ':w': p.weekly } } };
    case 'closed_date':
      return { Update: { TableName: table, Key: { PK, SK: 'HOURS' }, UpdateExpression: 'SET closedDates = list_append(if_not_exists(closedDates, :none), :d)',
        ExpressionAttributeValues: { ':none': [], ':d': [p.date] } } };
    case 'handoff_number':
      return { Update: { TableName: table, Key: { PK, SK: 'PROFILE' }, UpdateExpression: 'SET handoffNumber = :n',
        ExpressionAttributeValues: { ':n': p.e164 } } };
    case 'service': {
      const sets: string[] = []; const names: Record<string, string> = {}; const values: Record<string, unknown> = {};
      for (const f of ['name', 'durationMin', 'priceCents', 'active'] as const) {
        if (p[f] === undefined) continue;
        sets.push(`#${f} = :${f}`); names[`#${f}`] = f; values[`:${f}`] = p[f];
      }
      return { Update: { TableName: table, Key: { PK, SK: `SERVICE#${String(p.serviceId)}` }, UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(PK)', ExpressionAttributeNames: names, ExpressionAttributeValues: values } };
    }
  }
}
