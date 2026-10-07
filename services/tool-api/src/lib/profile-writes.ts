import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { keys, makeEvent, type TenantContext } from '@1145/shared';
import { HttpError, json, type HttpResult } from './http.js';
import {
  cleanText, normaliseChange, stepUpRequired, stepUpSecretsOf, verifyStepUpToken, type AuditEntry, type ChangeDeps,
} from './changes.js';
import type { TenantRepo, ToolDeps } from './repo.js';
import type { AuthDeps } from './tenant-auth.js';
import type { WeeklyWindow } from './slots.js';

/**
 * Direct owner edits from the dashboard (updateHours, updateService). Unlike propose/confirm (changes.ts), the owner
 * is already at the screen, so the edit lands in one call: validate, write (with an audit entry), then emit
 * admin.change_applied so the render-agent step rebuilds the receptionist's instructions from the new profile.
 *
 * Validation and the one-line summaries are T2's (normaliseChange), so a typed edit and a confirmed edit read the same.
 * Tenant identity comes from requireTenantContext only. The service id comes from the path and is looked up inside the
 * caller's own tenant partition; nothing in the body can name a tenant, a key or an item.
 */

export interface HoursEdit {
  timezone: string;
  weekly: WeeklyWindow[];
  /** Replaces the stored list when present. Left alone when absent. */
  closedDates?: string[];
}

export interface ServiceEdit { name?: string; durationMin?: number; priceCents?: number; active?: boolean }

/**
 * Persistence for direct edits. Expected to hang off TenantRepo as `repo.profileWrites` (change request T4-1), so it is
 * implicitly scoped to one tenant like every other repo method. Every write lands together with its audit entry.
 */
export interface ProfileWriteStore {
  /** Atomically: write HOURS (timezone, weekly, closedDates if given), keep PROFILE.timezone in step, write the audit entry. */
  putHours(hours: HoursEdit, audit: AuditEntry): Promise<void>;
  /** Atomically: patch the service and write the audit entry. False when this tenant has no such service. */
  patchService(serviceId: string, patch: ServiceEdit, audit: AuditEntry): Promise<boolean>;
}

export type ProfileWriteDeps = ToolDeps & AuthDeps & Pick<ChangeDeps, 'stepUpSecrets'>;

export function profileWritesOf(repo: TenantRepo): ProfileWriteStore {
  const store = (repo as TenantRepo & { profileWrites?: ProfileWriteStore }).profileWrites;
  if (!store) throw new HttpError(501, 'not_implemented', 'repo has no profile write store yet', "I can't save changes just yet.");
  return store;
}

// ---- validation ------------------------------------------------------------------------------------------------

const badEdit = (message: string) =>
  new HttpError(400, 'invalid', message, "I couldn't quite follow that. Can you tell me what to update again?");

function asBody(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw badEdit('body must be a JSON object');
  return v as Record<string, unknown>;
}

const MAX_CLOSED_DATES = 366;

function parseClosedDates(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > MAX_CLOSED_DATES) throw badEdit(`closedDates must be a list of at most ${MAX_CLOSED_DATES} dates`);
  const out = new Set<string>();
  for (const d of v) {
    const parsed = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00Z`) : undefined;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) throw badEdit('closedDates must be YYYY-MM-DD dates');
    out.add(d as string);
  }
  return [...out].sort();
}

/** A lunch break is two windows on one day. Two windows that overlap are a typo the receptionist would read out loud. */
function rejectOverlaps(weekly: readonly WeeklyWindow[]): void {
  const sorted = [...weekly].sort((a, b) => a.day - b.day || a.open.localeCompare(b.open));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!; const cur = sorted[i]!;
    if (prev.day === cur.day && cur.open < prev.close) {
      throw new HttpError(400, 'invalid', 'two opening windows overlap on one day',
        'Two of those time ranges overlap on the same day. Can you check them?');
    }
  }
}

export interface NormalisedEdit<E> { edit: E; summary: string; requiresStepUp: boolean }

export async function normaliseHoursEdit(body: unknown, repo: TenantRepo, now: Date): Promise<NormalisedEdit<HoursEdit>> {
  const raw = asBody(body);
  const change = await normaliseChange('hours', { timezone: raw.timezone, weekly: raw.weekly }, repo, now);
  const weekly = change.payload.weekly as WeeklyWindow[];
  rejectOverlaps(weekly);
  const edit: HoursEdit = { timezone: change.payload.timezone as string, weekly };
  if (raw.closedDates !== undefined) edit.closedDates = parseClosedDates(raw.closedDates);
  return { edit, summary: change.summary, requiresStepUp: change.requiresStepUp };
}

const SERVICE_FIELDS = ['name', 'durationMin', 'priceCents', 'active'] as const;

/** `serviceId` is the path parameter. Only the four editable fields are read from the body. */
export async function normaliseServiceEdit(
  serviceId: string | undefined, body: unknown, repo: TenantRepo, now: Date,
): Promise<NormalisedEdit<{ serviceId: string; patch: ServiceEdit }>> {
  const raw = asBody(body);
  if (!serviceId || serviceId.includes('#') || cleanText(serviceId, 80) !== serviceId) throw badEdit('serviceId in the path is not valid');
  const payload: Record<string, unknown> = { serviceId };
  for (const f of SERVICE_FIELDS) if (raw[f] !== undefined) payload[f] = raw[f];
  const change = await normaliseChange('service', payload, repo, now);
  const { serviceId: _id, ...patch } = change.payload;
  return { edit: { serviceId, patch: patch as ServiceEdit }, summary: change.summary, requiresStepUp: change.requiresStepUp };
}

// ---- step-up, audit, announce ----------------------------------------------------------------------------------

/** Same rule and the same token as applyChange: a dashboard-minted X-Step-Up-Token for THIS tenant, else 428. */
export async function requireStepUp(
  stepUpHeader: string | undefined, deps: ProfileWriteDeps, tenantId: string, now: Date,
): Promise<void> {
  const ok = verifyStepUpToken(stepUpHeader, await stepUpSecretsOf(deps), tenantId, Math.floor(now.getTime() / 1000));
  if (!ok) throw stepUpRequired();
}

export interface AppliedEdit { changeId: string; kind: 'hours' | 'service'; summary: string; requiresStepUp: boolean }

export function auditOf(ctx: TenantContext, edit: AppliedEdit, now: Date): AuditEntry {
  return {
    changeId: edit.changeId, kind: edit.kind, summary: edit.summary, principal: ctx.principal, channel: ctx.channel,
    stepUp: edit.requiresStepUp, at: now.toISOString(), correlationId: ctx.correlationId,
  };
}

/**
 * Tell the render-agent step the profile changed. The edit is already saved by now. If the bus is down we say so
 * plainly instead of reporting success: saving again writes the same values and sends the event again.
 */
export async function announceApplied(ctx: TenantContext, deps: ProfileWriteDeps, edit: AppliedEdit, now: Date): Promise<void> {
  try {
    await deps.publish(makeEvent('admin.change_applied', ctx, {
      changeId: edit.changeId, kind: edit.kind, summary: edit.summary, requiresStepUp: edit.requiresStepUp,
      appliedBy: ctx.principal, via: ctx.channel,
    }, now));
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'admin.change_applied not published', tenantId: ctx.tenantId, changeId: edit.changeId, err: String(err) }));
    throw new HttpError(502, 'publish_failed', 'saved, but the receptionist update was not sent',
      "I saved that, but your receptionist hasn't picked it up yet. Try saving it once more.");
  }
}

export function appliedResponse(edit: AppliedEdit): HttpResult {
  return json(200, {
    changeId: edit.changeId, kind: edit.kind, summary: edit.summary,
    messageForOwner: `Done. ${edit.summary} Your receptionist is picking that up now.`,
  });
}

// ---- DynamoDB implementation (to be wired into ddbRepoFor via change request T4-1) ------------------------------

type Doc = Pick<DynamoDBDocumentClient, 'send'>;

/**
 * Items (all under PK TENANT#<tid>, so the tenant role's LeadingKeys condition covers them):
 *   HOURS                      timezone, weekly, closedDates
 *   PROFILE                    timezone (kept equal to HOURS.timezone so the agent and the schedule never disagree)
 *   SERVICE#<sid>              name, durationMin, priceCents, active
 *   AUDIT#<iso>#<changeId>     one per edit, same shape as the audit entries applyChange writes
 * Only whitelisted, validated fields reach here (see normaliseHoursEdit / normaliseServiceEdit).
 */
export function ddbProfileWrites(doc: Doc, table: string, tenantId: string): ProfileWriteStore {
  const PK = keys.tenantPk(tenantId);
  const auditPut = (a: AuditEntry) => ({ Put: { TableName: table, Item: { ...a, PK, SK: `AUDIT#${a.at}#${a.changeId}` } } });

  return {
    async putHours(h, audit) {
      const names: Record<string, string> = { '#tz': 'timezone' };
      const values: Record<string, unknown> = { ':tz': h.timezone, ':w': h.weekly };
      let update = 'SET #tz = :tz, weekly = :w';
      if (h.closedDates !== undefined) { update += ', closedDates = :cd'; values[':cd'] = h.closedDates; }
      await doc.send(new TransactWriteCommand({
        TransactItems: [
          { Update: { TableName: table, Key: { PK, SK: keys.hoursSk() }, UpdateExpression: update, ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
          // Never create a stub PROFILE: it must already exist for a provisioned tenant.
          { Update: {
            TableName: table, Key: { PK, SK: keys.profileSk() }, UpdateExpression: 'SET #tz = :tz', ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeNames: { '#tz': 'timezone' }, ExpressionAttributeValues: { ':tz': h.timezone },
          } },
          auditPut(audit),
        ],
      }));
    },

    async patchService(serviceId, patch, audit) {
      const SK = keys.serviceSk(serviceId); // throws on '#', so an id can never reach another item
      const sets: string[] = []; const names: Record<string, string> = {}; const values: Record<string, unknown> = {};
      for (const f of SERVICE_FIELDS) {
        if (patch[f] === undefined) continue;
        sets.push(`#${f} = :${f}`); names[`#${f}`] = f; values[`:${f}`] = patch[f];
      }
      if (sets.length === 0) throw new Error('empty service patch');
      try {
        await doc.send(new TransactWriteCommand({
          TransactItems: [
            { Update: { TableName: table, Key: { PK, SK }, UpdateExpression: `SET ${sets.join(', ')}`,
              ConditionExpression: 'attribute_exists(PK)', ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
            auditPut(audit),
          ],
        }));
        return true;
      } catch (err) {
        const e = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
        // Item 0 is the service. Only "it does not exist" is an answer; a conflict or throttle is a real failure.
        if (e.name === 'TransactionCanceledException' && e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') return false;
        throw err;
      }
    },
  };
}
