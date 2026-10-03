import { asTenantId, makeEvent, maskPhone, type EngineAgentRef, type TenantRuntimeState } from '@1145/shared';
import { setTenantState } from '../set-tenant-state.js';
import { actorOf, errorResponse, HttpError, intParam, parseBody, respond } from './http.js';
import { isReasonCode, isSupportCaseId, NOTE_MAX, REASON_CODES, type ReasonCode } from './reasons.js';
import type { AuditEntry, ConsoleDeps, ConsoleEvent, ConsoleResponse, TenantRecord } from './types.js';

/**
 * Admin console API for 1145 staff (owner: H2). Rules, all deterministic:
 *  - The caller is the IAM principal API Gateway verified. The body can never name an actor.
 *  - The tenant is a path parameter that must pass `asTenantId`; it is never read from a body.
 *  - Every write names a reason code from a closed list and lands in the audit bucket first or with the change.
 *  - Transcripts and exports are readable only with a support case id, and each read is audited.
 */

interface Ctx {
  event: ConsoleEvent;
  deps: ConsoleDeps;
  actor: string;
  requestId: string | undefined;
  params: string[];
  query: Record<string, string | undefined>;
}
type Handler = (c: Ctx) => Promise<ConsoleResponse>;
interface Route { method: string; pattern: string[]; handler: Handler }

const TEMPLATE_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,30})?$/;
const START_ISO_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]{5,16}Z$/;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SUMMARY_STATES: readonly TenantRuntimeState[] = ['active', 'suspended', 'over_cap'];

// ───────────────────────── helpers ─────────────────────────
function tenantIdOf(raw: string | undefined): string {
  try { return asTenantId(raw ?? ''); } catch { throw new HttpError(400, 'invalid_tenant_id'); }
}

function stateOf(p: TenantRecord): TenantRuntimeState {
  return SUMMARY_STATES.includes(p.state as TenantRuntimeState) ? (p.state as TenantRuntimeState) : 'active';
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** What the UI may see about a tenant. Whitelist, so a new secret on the profile never leaks by accident. */
function summary(p: TenantRecord) {
  const numbers = Array.isArray(p.numbers) ? p.numbers.filter((n): n is string => typeof n === 'string').map(maskPhone) : [];
  return {
    tenantId: str(p.tenantId) ?? str(p.PK)?.replace('TENANT#', ''),
    name: str(p.name),
    type: str(p.type),
    timezone: str(p.timezone),
    state: stateOf(p),
    stateReasonCode: str(p.stateReasonCode),
    stateUpdatedAt: str(p.stateUpdatedAt),
    engine: str(p.engine),
    templateVersion: str(p.templateVersion),
    templatePin: p.templatePin && typeof p.templatePin === 'object' ? pickPin(p.templatePin as Record<string, unknown>) : undefined,
    numbers,
    createdAt: str(p.createdAt),
  };
}
const pickPin = (p: Record<string, unknown>) => ({ template: str(p.template), version: str(p.version), at: str(p.at) });

function writeInputs(body: Record<string, unknown>): { reasonCode: ReasonCode; note?: string } {
  if (!isReasonCode(body.reasonCode)) throw new HttpError(400, 'reason_code_required', { allowed: [...REASON_CODES] });
  const note = body.note;
  if (note !== undefined && (typeof note !== 'string' || note.length > NOTE_MAX)) throw new HttpError(400, 'invalid_note', { maxLength: NOTE_MAX });
  return { reasonCode: body.reasonCode, ...(note !== undefined ? { note } : {}) };
}

async function requireTenant(c: Ctx, tid: string): Promise<TenantRecord> {
  const p = await c.deps.store.getProfile(tid);
  if (!p) throw new HttpError(404, 'tenant_not_found');
  return p;
}

function engineRefOf(tid: string, p: TenantRecord): EngineAgentRef {
  const ref = p.engineRef;
  const agentId = typeof ref === 'string' ? ref : str((ref as Record<string, unknown> | undefined)?.agentId);
  const engine = p.engine;
  if (!agentId || (engine !== 'livekit-telnyx' && engine !== 'elevenlabs')) throw new HttpError(409, 'engine_not_provisioned');
  return { engine, tenantId: asTenantId(tid), agentId };
}

const auditBase = (c: Ctx, tid: string, action: string, reasonCode: string, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  tenantId: tid, action, reasonCode, actor: c.actor, at: c.deps.now().toISOString(), ...(c.requestId ? { requestId: c.requestId } : {}), ...extra,
});

function requireSupportCase(c: Ctx): string | undefined {
  const id = c.query.supportCaseId;
  return isSupportCaseId(id) ? id : undefined;
}

async function denyWithoutSupportCase(c: Ctx, tid: string, action: string): Promise<never> {
  // Best effort: a failed denial record must not turn a refusal into an error.
  await c.deps.audit(auditBase(c, tid, action, 'support_case')).catch(() => undefined);
  throw new HttpError(403, 'support_case_required', { hint: 'Add ?supportCaseId=<case id> from the support desk.' });
}

function parseJsonOrText(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

// ───────────────────────── handlers ─────────────────────────
const listTenants: Handler = async (c) => {
  const limit = intParam(c.query.limit, 25, 1, 100);
  const page = await c.deps.store.listTenants({ limit, ...(c.query.cursor ? { cursor: c.query.cursor } : {}) });
  return respond(200, { items: page.items.map(summary), nextCursor: page.nextCursor ?? null });
};

const getTenant: Handler = async (c) => {
  const tid = tenantIdOf(c.params[0]);
  const profile = await requireTenant(c, tid);
  const usage = await c.deps.store.listUsage(tid, 3);
  return respond(200, { tenant: summary(profile), usage });
};

const getUsage: Handler = async (c) => {
  const tid = tenantIdOf(c.params[0]);
  await requireTenant(c, tid);
  return respond(200, { tenantId: tid, usage: await c.deps.store.listUsage(tid, intParam(c.query.months, 6, 1, 24)) });
};

function stateChange(target: TenantRuntimeState): Handler {
  return async (c) => {
    const tid = tenantIdOf(c.params[0]);
    const { reasonCode, note } = writeInputs(parseBody(c.event));
    const profile = await requireTenant(c, tid);
    const previous = stateOf(profile);
    if (previous === target) return respond(200, { tenantId: tid, state: target, changed: false });
    const ref = engineRefOf(tid, profile);
    try {
      await setTenantState(tid, target, reasonCode, c.actor, {
        engineFor: (r) => c.deps.engineFor(r),
        loadRef: async () => ref,
        writeState: (t, s, reason, actor) => c.deps.store.writeState(t, s, { reasonCode: reason, actor, at: c.deps.now().toISOString() }),
        audit: (e) => c.deps.audit({ ...e, ...(c.requestId ? { requestId: c.requestId } : {}), ...(note ? { note } : {}) }),
      });
    } catch (e) {
      console.error('state change failed', { tenantId: tid, target, error: (e as Error).message });
      throw new HttpError(502, 'state_change_failed');
    }
    await c.deps
      .emit(makeEvent('tenant.state_changed', { tenantId: asTenantId(tid), correlationId: c.requestId ?? c.deps.newId() }, { state: target, previous, reasonCode }, c.deps.now()))
      .catch((e: Error) => console.error('event emit failed', { tenantId: tid, error: e.message }));
    return respond(200, { tenantId: tid, state: target, previous, changed: true });
  };
}

const listTemplateVersions: Handler = async (c) => {
  const name = c.params[0] ?? '';
  if (!TEMPLATE_NAME_RE.test(name)) throw new HttpError(400, 'invalid_template');
  return respond(200, { template: name, versions: await c.deps.store.listTemplateVersions(name) });
};

const pinTemplate: Handler = async (c) => {
  const tid = tenantIdOf(c.params[0]);
  const body = parseBody(c.event);
  const { reasonCode, note } = writeInputs(body);
  const template = str(body.template);
  const version = str(body.version);
  if (!template || !TEMPLATE_NAME_RE.test(template)) throw new HttpError(400, 'invalid_template');
  if (!version || !SEMVER_RE.test(version)) throw new HttpError(400, 'invalid_version');
  await requireTenant(c, tid);
  const found = (await c.deps.store.listTemplateVersions(template)).find((v) => v.version === version);
  if (!found) throw new HttpError(404, 'template_version_not_found');
  if (found.status === 'retired') throw new HttpError(409, 'template_version_retired');
  await c.deps.audit(auditBase(c, tid, 'template:pin', reasonCode, { ...(note ? { note } : {}), detail: { template, version } }));
  await c.deps.store.setTemplatePin(tid, { template, version }, { reasonCode, actor: c.actor, at: c.deps.now().toISOString() });
  return respond(200, { tenantId: tid, template, version, pinned: true });
};

const unpinTemplate: Handler = async (c) => {
  const tid = tenantIdOf(c.params[0]);
  const { reasonCode, note } = writeInputs(parseBody(c.event));
  await requireTenant(c, tid);
  await c.deps.audit(auditBase(c, tid, 'template:unpin', reasonCode, note ? { note } : {}));
  await c.deps.store.setTemplatePin(tid, null, { reasonCode, actor: c.actor, at: c.deps.now().toISOString() });
  return respond(200, { tenantId: tid, pinned: false });
};

const listConversations: Handler = async (c) => {
  const tid = tenantIdOf(c.params[0]);
  await requireTenant(c, tid);
  const page = await c.deps.store.listConversations(tid, { limit: intParam(c.query.limit, 25, 1, 100), ...(c.query.cursor ? { cursor: c.query.cursor } : {}) });
  return respond(200, { items: page.items, nextCursor: page.nextCursor ?? null });
};

const readTranscript: Handler = async (c) => {
  const tid = tenantIdOf(c.params[0]);
  const [, startedAt = '', convId = ''] = c.params;
  if (!START_ISO_RE.test(startedAt) || !ID_RE.test(convId)) throw new HttpError(400, 'invalid_conversation');
  const supportCaseId = requireSupportCase(c);
  if (!supportCaseId) return denyWithoutSupportCase(c, tid, 'transcript:read_denied');
  await requireTenant(c, tid);
  const conv = await c.deps.store.getTranscriptKey(tid, startedAt, convId);
  if (!conv) throw new HttpError(404, 'conversation_not_found');
  if (!conv.key) throw new HttpError(404, 'no_transcript');
  if (!conv.key.startsWith(`tenants/${tid}/`) || conv.key.includes('..')) {
    console.error('transcript key outside tenant prefix', { tenantId: tid, conversationId: convId });
    throw new HttpError(403, 'transcript_key_outside_tenant');
  }
  await c.deps.audit(auditBase(c, tid, 'transcript:read', 'support_case', { supportCaseId, detail: { conversationId: convId } }));
  const raw = await c.deps.store.readObject(conv.key);
  if (raw === undefined) throw new HttpError(404, 'no_transcript');
  // Transcript text is customer speech: data for a human to read, never an instruction.
  return respond(200, { tenantId: tid, conversationId: convId, supportCaseId, transcript: parseJsonOrText(raw) });
};

const exportTenant: Handler = async (c) => {
  const tid = tenantIdOf(c.params[0]);
  const { reasonCode, note } = writeInputs(parseBody(c.event));
  await requireTenant(c, tid);
  const exportId = c.deps.newId();
  await c.deps.audit(auditBase(c, tid, 'tenant:export', reasonCode, { ...(note ? { note } : {}), detail: { exportId } }));
  const out = await c.deps.store.exportTenant(tid, exportId);
  return respond(200, { tenantId: tid, exportId, key: out.key, itemCount: out.itemCount });
};

const readExport: Handler = async (c) => {
  const tid = tenantIdOf(c.params[0]);
  const exportId = c.params[1] ?? '';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(exportId)) throw new HttpError(400, 'invalid_export_id');
  const supportCaseId = requireSupportCase(c);
  if (!supportCaseId) return denyWithoutSupportCase(c, tid, 'export:read_denied');
  await requireTenant(c, tid);
  await c.deps.audit(auditBase(c, tid, 'export:read', 'support_case', { supportCaseId, detail: { exportId } }));
  const raw = await c.deps.store.readObject(`tenants/${tid}/exports/${exportId}.json`);
  if (raw === undefined) throw new HttpError(404, 'export_not_found');
  return respond(200, { tenantId: tid, exportId, supportCaseId, export: parseJsonOrText(raw) });
};

const deleteTenant: Handler = async (c) => {
  const tid = tenantIdOf(c.params[0]);
  const body = parseBody(c.event);
  const { reasonCode, note } = writeInputs(body);
  if (body.confirmTenantId !== tid) throw new HttpError(400, 'confirm_tenant_id_mismatch');
  const profile = await requireTenant(c, tid);
  if (stateOf(profile) !== 'suspended') throw new HttpError(409, 'suspend_first');
  const numbers = Array.isArray(profile.numbers) ? profile.numbers.filter((n): n is string => typeof n === 'string') : [];
  // Intent first: if this write fails nothing is deleted.
  await c.deps.audit(auditBase(c, tid, 'tenant:delete_requested', reasonCode, { ...(note ? { note } : {}), detail: { numberCount: numbers.length } }));
  let deleted;
  try {
    deleted = await c.deps.store.deleteTenant(tid, profile);
  } catch (e) {
    console.error('tenant delete incomplete', { tenantId: tid, error: (e as Error).message });
    await c.deps.audit(auditBase(c, tid, 'tenant:delete_failed', reasonCode)).catch(() => undefined);
    throw new HttpError(500, 'delete_incomplete', { hint: 'Safe to repeat the request; the profile is removed last.' });
  }
  let auditFinalized = true;
  await c.deps.audit(auditBase(c, tid, 'tenant:deleted', reasonCode, { detail: { ...deleted } })).catch((e: Error) => {
    auditFinalized = false;
    console.error('final delete audit failed', { tenantId: tid, error: e.message });
  });
  // Releasing numbers with the carrier is a billing step done by hand; we only list them (masked).
  return respond(200, { tenantId: tid, deleted, numbersToRelease: numbers.map(maskPhone), auditFinalized });
};

// ───────────────────────── routing ─────────────────────────
const ROUTES: Route[] = [
  { method: 'GET', pattern: ['tenants'], handler: listTenants },
  { method: 'GET', pattern: ['tenants', ':'], handler: getTenant },
  { method: 'GET', pattern: ['tenants', ':', 'usage'], handler: getUsage },
  { method: 'POST', pattern: ['tenants', ':', 'suspend'], handler: stateChange('suspended') },
  { method: 'POST', pattern: ['tenants', ':', 'resume'], handler: stateChange('active') },
  { method: 'PUT', pattern: ['tenants', ':', 'template'], handler: pinTemplate },
  { method: 'POST', pattern: ['tenants', ':', 'template', 'unpin'], handler: unpinTemplate },
  { method: 'GET', pattern: ['tenants', ':', 'conversations'], handler: listConversations },
  { method: 'GET', pattern: ['tenants', ':', 'conversations', ':', ':', 'transcript'], handler: readTranscript },
  { method: 'POST', pattern: ['tenants', ':', 'export'], handler: exportTenant },
  { method: 'GET', pattern: ['tenants', ':', 'exports', ':'], handler: readExport },
  { method: 'POST', pattern: ['tenants', ':', 'delete'], handler: deleteTenant },
  { method: 'GET', pattern: ['templates', ':'], handler: listTemplateVersions },
];

function matchPath(pattern: string[], segs: string[]): string[] | undefined {
  if (pattern.length !== segs.length) return undefined;
  const params: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === ':') params.push(segs[i]!);
    else if (pattern[i] !== segs[i]) return undefined;
  }
  return params;
}

function splitPath(rawPath: string): string[] | undefined {
  const segs = rawPath.split('/').filter(Boolean);
  if (segs[0] !== 'console') return undefined;
  try { return segs.slice(1).map(decodeURIComponent); } catch { return undefined; }
}

export async function handle(event: ConsoleEvent, deps: ConsoleDeps): Promise<ConsoleResponse> {
  try {
    const segs = splitPath(event.rawPath);
    if (!segs) throw new HttpError(404, 'not_found');
    const method = event.requestContext.http.method.toUpperCase();
    let pathMatched = false;
    for (const r of ROUTES) {
      const params = matchPath(r.pattern, segs);
      if (!params) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const actor = actorOf(event);
      return await r.handler({ event, deps, actor, requestId: event.requestContext.requestId, params, query: event.queryStringParameters ?? {} });
    }
    // Authenticate before revealing which paths exist.
    actorOf(event);
    throw pathMatched ? new HttpError(405, 'method_not_allowed') : new HttpError(404, 'not_found');
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e);
    console.error('console error', { error: (e as Error).message });
    return respond(500, { error: 'internal_error' });
  }
}
