/**
 * Onboarding API: list scraped facts, record the owner's decisions, complete the facts task token.
 * Owner: issue D3 (tasks/D3.md). Contract: contracts/openapi/onboarding-internal.yaml
 *   GET  /internal/onboarding/{onboardingId}/facts            (listFacts)
 *   POST /internal/onboarding/{onboardingId}/facts/decisions  (decideFacts)
 *
 * This file also holds the plumbing agent-name.ts shares (auth, JSON helpers, the single-table store, the
 * Step Functions call), because the issue owns only these two handlers and one test file.
 *
 * Rules this code enforces (docs/security/threat-model.md SEC-05):
 *  - The tenant comes from the ONBOARDING record the server wrote, never from the path, query or body.
 *  - Only ids that were in the latest listing can be approved, so a model cannot approve what the owner never saw.
 *  - A fact that looks like an instruction is never approved from chat. It is held back and stays unverified.
 *  - The channel message id of each decision is stored when the caller passes it (trusted header, not model output).
 * Scraped text is data: it is shown to the model with angle brackets and control characters removed.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { asTenantId, keys, safeEqual } from '@1145/shared';
import { detectInstructionLike } from '../lib/sanitize.js';
import { cleanInline } from '../templates/types.js';

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

export type TaskName = 'facts' | 'profile' | 'agentName';
export type StepOutcome = 'completed' | 'already_done' | 'not_waiting';
export type FactDecisionKind = 'approved' | 'rejected';
export type FactStatus = 'pending' | FactDecisionKind;

/** ONBOARDING#<id> / STATE, the attributes this lane reads or writes (contracts/CHANGE_REQUESTS/D3-1.md). */
export interface OnboardingRecord {
  onboardingId: string;
  /** Written by the start-provisioning endpoint. Absent until provisioning has started. */
  tenantId?: string;
  /** Written by await-owner (D8) when a workflow step starts waiting; one token per waiting step. */
  taskTokens?: Partial<Record<TaskName, string>>;
  factsShown?: string[];
  factsDecision?: { at: string; approved: number; rejected: number; heldBack: number };
  factsCompletedAt?: string;
  agentName?: string;
  agentNameLockedAt?: string;
}

/** TENANT#<tid> / FACT#<fid> (contracts/dynamodb/keys.md). `flags` is the list sanitize.ts produced. */
export interface FactRecord {
  id: string;
  text: string;
  source: string;
  verified: boolean;
  flaggedInstructionLike?: boolean;
  flags?: string[];
  decision?: FactDecisionKind;
  createdAt?: string;
}

export interface DecisionSummary { approved: number; rejected: number; heldBack: number }
export interface DecisionMeta { at: string; messageId?: string }

export interface OnboardingStore {
  getOnboarding(onboardingId: string): Promise<OnboardingRecord | undefined>;
  listFacts(tenantId: string): Promise<FactRecord[]>;
  saveShown(onboardingId: string, ids: readonly string[], at: string): Promise<void>;
  /** All-or-nothing for the facts; throws FactChangedError if a fact vanished or became flagged meanwhile. */
  applyFactDecisions(
    onboardingId: string, tenantId: string, decisions: ReadonlyArray<{ id: string; decision: FactDecisionKind }>,
    summary: DecisionSummary, meta: DecisionMeta,
  ): Promise<void>;
  /** Always saved on the onboarding record; also on PROFILE when that exists. */
  saveAgentName(onboardingId: string, tenantId: string | undefined, name: string, at: string): Promise<{ profileUpdated: boolean }>;
  /** Records that the step finished and removes the task token it used (if it is still the stored one). */
  markStepDone(onboardingId: string, step: 'facts' | 'agentName', token: string | undefined, at: string): Promise<void>;
}

export interface Workflow {
  /** Throws TaskGoneError when the task already finished, timed out or never existed. */
  succeed(taskToken: string, output: Record<string, unknown>): Promise<void>;
}

export class TaskGoneError extends Error { constructor() { super('TaskGone'); this.name = 'TaskGone'; } }
export class FactChangedError extends Error { constructor() { super('FactChanged'); this.name = 'FactChanged'; } }

export interface OnboardingApiDeps {
  store: OnboardingStore;
  workflow: Workflow;
  /**
   * Is this bearer token allowed to act on this onboarding? Today one static service token (serviceTokenAuthorizer);
   * SEC-22 replaces it with a short-lived token whose `onb` claim must equal `onboardingId`.
   */
  authorize(token: string | undefined, onboardingId: string): Promise<boolean>;
  now?: () => Date;
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP plumbing shared with agent-name.ts
// ---------------------------------------------------------------------------------------------------------------

export interface ApiEvent {
  rawPath?: string;
  path?: string;
  pathParameters?: Record<string, string | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  headers?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  httpMethod?: string;
  requestContext?: { http?: { method?: string } };
}

export interface ApiResult { statusCode: number; headers: Record<string, string>; body: string }

export interface Ctx {
  onboardingId: string;
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  event: ApiEvent;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MAX_BODY_BYTES = 64 * 1024;

export const json = (statusCode: number, body: unknown): ApiResult => ({
  statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body),
});
/** Error body: `code` is what callers branch on (agents/common/api.py reads it), `message` is plain words. */
export const fail = (statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): ApiResult =>
  json(statusCode, { code, message, ...extra });

export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, msg, ...fields })); // never task tokens, service tokens or fact text
}

function header(event: ApiEvent, name: string): string | undefined {
  for (const [k, v] of Object.entries(event.headers ?? {})) if (k.toLowerCase() === name && typeof v === 'string') return v;
  return undefined;
}

function bearer(event: ApiEvent): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header(event, 'authorization') ?? '');
  return m?.[1];
}

/** The id comes from the path the router bound (API Gateway names the parameter `id` in the stack, `onboardingId` in the contract). */
function pathOnboardingId(event: ApiEvent): string | undefined {
  const p = event.pathParameters;
  const fromParams = p?.onboardingId ?? p?.id;
  const raw = fromParams ?? /^\/internal\/onboarding\/([^/]+)\//.exec(event.rawPath ?? event.path ?? '')?.[1];
  return raw && ID_RE.test(raw) ? raw : undefined;
}

export function readJson(event: ApiEvent): { ok: true; value: unknown } | { ok: false } {
  try {
    const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}';
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return { ok: false };
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export const nowIso = (deps: Pick<OnboardingApiDeps, 'now'>): string => (deps.now?.() ?? new Date()).toISOString();

/** Auth, id, method and error handling for one request. Everything past `authorize` runs inside `handle`. */
export async function serve(deps: OnboardingApiDeps, rawEvent: unknown, handle: (c: Ctx) => Promise<ApiResult>): Promise<ApiResult> {
  const event = (rawEvent ?? {}) as ApiEvent;
  const onboardingId = pathOnboardingId(event);
  try {
    if (!(await deps.authorize(bearer(event), onboardingId ?? ''))) return fail(401, 'unauthorized', 'Missing or invalid service token.');
    if (!onboardingId) return fail(400, 'invalid_onboarding_id', 'The onboarding id in the path is missing or not valid.');
    return await handle({
      onboardingId,
      method: (event.requestContext?.http?.method ?? event.httpMethod ?? '').toUpperCase(),
      path: (event.rawPath ?? event.path ?? '').replace(/\/+$/, ''),
      query: event.queryStringParameters ?? {},
      event,
    });
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    log('error', 'onboarding api failed', { onboardingId, error: e?.name ?? 'Error', status: e?.$metadata?.httpStatusCode });
    return fail(500, 'unavailable', "That didn't go through. Try again in a moment.");
  }
}

/** The step is only finished once, whatever the caller does twice. */
export async function completeStep(
  deps: OnboardingApiDeps, rec: OnboardingRecord, step: 'facts' | 'agentName', output: Record<string, unknown>,
): Promise<StepOutcome> {
  const done = step === 'facts' ? rec.factsCompletedAt : rec.agentNameLockedAt;
  const token = rec.taskTokens?.[step];
  if (!token) return done ? 'already_done' : 'not_waiting';
  let outcome: StepOutcome = 'completed';
  try {
    await deps.workflow.succeed(token, output);
  } catch (err) {
    if (!(err instanceof TaskGoneError)) throw err; // outage or throttling: the caller retries, the decision is already saved
    outcome = 'already_done';
  }
  await deps.store.markStepDone(rec.onboardingId, step, token, nowIso(deps));
  return outcome;
}

// ---------------------------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------------------------

const MAX_LISTED = 100;
const MAX_DECISION_IDS = 100;
const STATUS_FILTERS = new Set(['pending', 'approved', 'rejected', 'all']);

const FLAG_REASONS: Record<string, string> = {
  override: "It tells an assistant to ignore its rules, so it isn't really about your business.",
  persona: "It tries to give the receptionist a new role, so it isn't really about your business.",
  'prompt-ref': "It talks about an assistant's instructions, so it isn't really about your business.",
  'role-tag': "It has chat markup in it, so it isn't plain business info.",
  exfil: "It asks for private details like passwords, so it isn't really about your business.",
  'tool-call': "It tells an assistant to run a tool, so it isn't really about your business.",
};
const GENERIC_REASON = 'It reads like an instruction to an assistant, not a fact about your business.';
const STAYS_OUT = ' It stays out of what the receptionist says.';

/** Why a flagged fact is held out, in words the owner would use. One reason, not a pile; machine flag names never show. */
export function plainReason(flags: readonly string[]): string {
  const first = flags.find((f) => f in FLAG_REASONS);
  return (first ? FLAG_REASONS[first]! : GENERIC_REASON) + STAYS_OUT;
}

function flagsOf(f: FactRecord): string[] {
  return [...new Set([...(f.flags ?? []), ...detectInstructionLike(f.text)])]; // stored flags plus a fresh check of the text
}
const isFlagged = (f: FactRecord): boolean => f.flaggedInstructionLike === true || flagsOf(f).length > 0;
const statusOf = (f: FactRecord): FactStatus => f.decision ?? (f.verified ? 'approved' : 'pending');

export interface FactView { id: string; text: string; source: string; flagged: boolean; status: FactStatus; reason?: string }

function toView(f: FactRecord): FactView {
  const flagged = isFlagged(f);
  return {
    id: f.id,
    text: cleanInline(f.text, 700),       // what the model reads: one line, no angle brackets, no control characters
    source: cleanInline(f.source, 300),
    flagged,
    status: statusOf(f),
    ...(flagged ? { reason: plainReason(flagsOf(f)) } : {}),
  };
}

const flaggedFirst = (a: FactRecord, b: FactRecord): number =>
  Number(isFlagged(b)) - Number(isFlagged(a)) || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id);

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

async function listFacts(deps: OnboardingApiDeps, c: Ctx): Promise<ApiResult> {
  const status = c.query.status ?? 'pending';
  if (!STATUS_FILTERS.has(status)) return fail(400, 'invalid_status', 'status must be pending, approved, rejected or all.');
  const rec = await deps.store.getOnboarding(c.onboardingId);
  if (!rec) return fail(404, 'onboarding_not_found', 'No onboarding with that id.');
  if (!rec.tenantId) return json(200, { facts: [] }); // provisioning has not started, so nothing has been scraped

  const all = await deps.store.listFacts(rec.tenantId);
  const shown = all.filter((f) => status === 'all' || statusOf(f) === status).sort(flaggedFirst).slice(0, MAX_LISTED);
  const ids = shown.map((f) => f.id);
  if (!sameSet(rec.factsShown ?? [], ids)) await deps.store.saveShown(c.onboardingId, ids, nowIso(deps)); // the latest listing is what can be approved

  // Nothing is left to ask (no facts at all, or every one decided) but the step is still waiting: finish it, so the
  // workflow is not stuck for days on an owner who was told "nothing to confirm".
  if (rec.taskTokens?.facts && all.every((f) => statusOf(f) !== 'pending')) {
    await completeStep(deps, rec, 'facts', { approved: 0, rejected: 0, heldBack: 0, nothingToConfirm: true });
  }
  return json(200, { facts: shown.map(toView) });
}

function idList(v: unknown): string[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_DECISION_IDS) return undefined;
  if (!v.every((x) => typeof x === 'string' && ID_RE.test(x))) return undefined;
  return [...new Set(v as string[])];
}

async function decideFacts(deps: OnboardingApiDeps, c: Ctx): Promise<ApiResult> {
  const body = readJson(c.event);
  if (!body.ok) return fail(400, 'invalid_json', 'The request body is not valid JSON.');
  const b = (typeof body.value === 'object' && body.value !== null && !Array.isArray(body.value) ? body.value : undefined) as
    { approved?: unknown; rejected?: unknown } | undefined;
  const approvedIn = idList(b?.approved);
  const rejected = idList(b?.rejected);
  if (!b || !approvedIn || !rejected) return fail(400, 'invalid_decisions', 'approved and rejected must be lists of fact ids.');
  const approved = approvedIn.filter((id) => !rejected.includes(id)); // unsure counts as rejected
  if (!approved.length && !rejected.length) return fail(400, 'no_decisions', 'Send at least one fact id to approve or reject.');
  if (approved.length + rejected.length > MAX_DECISION_IDS) return fail(400, 'too_many', `Send at most ${MAX_DECISION_IDS} fact ids at a time.`);

  const rec = await deps.store.getOnboarding(c.onboardingId);
  if (!rec) return fail(404, 'onboarding_not_found', 'No onboarding with that id.');
  if (!rec.tenantId) return fail(409, 'not_started', 'Setup has not started yet, so there are no facts to decide on.');

  const byId = new Map((await deps.store.listFacts(rec.tenantId)).map((f) => [f.id, f] as const));
  if ([...approved, ...rejected].some((id) => !byId.has(id))) return fail(400, 'unknown_fact', 'One of those ids is not a fact for this business.');
  const shown = new Set(rec.factsShown ?? []);
  if (approved.some((id) => !shown.has(id))) return fail(400, 'fact_not_shown', 'Only facts from the latest list can be approved. Get the list again first.');

  const heldBack = approved.map((id) => byId.get(id)!).filter(isFlagged)
    .map((f) => ({ id: f.id, reason: plainReason(flagsOf(f)) }));
  const heldIds = new Set(heldBack.map((h) => h.id));
  const toApprove = approved.filter((id) => !heldIds.has(id));

  const messageId = header(c.event, 'x-1145-message-id');
  const meta: DecisionMeta = { at: nowIso(deps), ...(messageId && MESSAGE_ID_RE.test(messageId) ? { messageId } : {}) };
  const summary: DecisionSummary = { approved: toApprove.length, rejected: rejected.length, heldBack: heldBack.length };
  try {
    await deps.store.applyFactDecisions(
      c.onboardingId, rec.tenantId,
      [...toApprove.map((id) => ({ id, decision: 'approved' as const })), ...rejected.map((id) => ({ id, decision: 'rejected' as const }))],
      summary, meta,
    );
  } catch (err) {
    if (err instanceof FactChangedError) return fail(409, 'fact_changed', 'A fact changed while saving. Get the list again and confirm once more.');
    throw err;
  }

  // Read again after the write: if the workflow stored its token while we were saving, either this request or the
  // await-owner step (which checks the saved decisions after storing the token) completes the step. Never neither.
  const fresh = (await deps.store.getOnboarding(c.onboardingId)) ?? rec;
  const workflow = await completeStep(deps, fresh, 'facts', { ...summary });
  log('info', 'facts decided', { onboardingId: c.onboardingId, ...summary, messageId: meta.messageId, workflow });
  return json(200, { approved: toApprove, rejected, heldBack, workflow });
}

export function makeFactsHandler(deps: OnboardingApiDeps): (event: unknown) => Promise<ApiResult> {
  return (event) => serve(deps, event, async (c) => {
    if (c.path.endsWith('/facts/decisions')) return c.method === 'POST' ? decideFacts(deps, c) : fail(405, 'method_not_allowed', 'Use POST for decisions.');
    if (c.path.endsWith('/facts')) return c.method === 'GET' ? listFacts(deps, c) : fail(405, 'method_not_allowed', 'Use GET to list facts.');
    return fail(404, 'not_found', 'No such route.');
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------------------------

/** Accepts any of the configured tokens (current and previous, so rotation never locks the agent out). Fails closed. */
export function serviceTokenAuthorizer(tokens: () => Promise<readonly string[]>): OnboardingApiDeps['authorize'] {
  return async (presented) => {
    if (!presented) return false;
    let ok = false;
    for (const t of await tokens()) if (t && safeEqual(presented, t)) ok = true; // no early exit
    return ok;
  };
}

const TOKEN_CACHE_MS = 5 * 60_000;
let cachedTokens: { at: number; tokens: string[] } | undefined;

/** ONBOARDING_SERVICE_TOKEN_SECRET_ARN (Secrets Manager, current + previous version) in AWS; ONBOARDING_SERVICE_TOKEN for local runs. */
async function loadServiceTokens(): Promise<string[]> {
  if (cachedTokens && Date.now() - cachedTokens.at < TOKEN_CACHE_MS) return cachedTokens.tokens;
  const arn = process.env.ONBOARDING_SERVICE_TOKEN_SECRET_ARN;
  const tokens: string[] = [];
  if (arn) {
    const sm = new SecretsManagerClient({});
    for (const stage of ['AWSCURRENT', 'AWSPREVIOUS']) {
      try {
        const r = await sm.send(new GetSecretValueCommand({ SecretId: arn, VersionStage: stage }));
        const value = secretToken(r.SecretString);
        if (value) tokens.push(value);
      } catch (err) {
        if (stage === 'AWSCURRENT') throw err; // no previous version yet is normal
      }
    }
  } else if (process.env.ONBOARDING_SERVICE_TOKEN) {
    tokens.push(process.env.ONBOARDING_SERVICE_TOKEN);
  }
  cachedTokens = { at: Date.now(), tokens };
  return tokens;
}

function secretToken(secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  try {
    const parsed = JSON.parse(secret) as unknown;
    if (parsed && typeof parsed === 'object') {
      const v = (parsed as Record<string, unknown>).ONBOARDING_SERVICE_TOKEN;
      return typeof v === 'string' && v ? v : undefined;
    }
  } catch { /* a bare string secret */ }
  return secret;
}

// ---------------------------------------------------------------------------------------------------------------
// Step Functions
// ---------------------------------------------------------------------------------------------------------------

const TASK_GONE = new Set(['TaskDoesNotExist', 'TaskTimedOut', 'InvalidToken']);

export function sfnWorkflow(client: { send(cmd: any): Promise<any> }): Workflow {
  return {
    async succeed(taskToken, output) {
      try {
        await client.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(output) }));
      } catch (err) {
        if (TASK_GONE.has((err as { name?: string })?.name ?? '')) throw new TaskGoneError();
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// DynamoDB (single table t1145)
// ---------------------------------------------------------------------------------------------------------------

const errName = (e: unknown): string => (e as { name?: string })?.name ?? '';
const MAX_FACT_ITEMS = 500;

function seg(id: string): string {
  if (!ID_RE.test(id)) throw new Error('invalid id');
  return id;
}
const stateKey = (onboardingId: string) => ({ PK: `ONBOARDING#${seg(onboardingId)}`, SK: 'STATE' });

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
const optString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function validTenantId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try { return asTenantId(v); } catch { return undefined; }
}

export function ddbOnboardingStore(client: { send(cmd: any): Promise<any> }, table: string): OnboardingStore {
  return {
    async getOnboarding(onboardingId) {
      const r = await client.send(new GetCommand({ TableName: table, Key: stateKey(onboardingId), ConsistentRead: true }));
      const it = r.Item as Record<string, unknown> | undefined;
      if (!it) return undefined;
      const tokens = (typeof it.taskTokens === 'object' && it.taskTokens !== null ? it.taskTokens : {}) as Record<string, unknown>;
      const taskTokens: OnboardingRecord['taskTokens'] = {};
      for (const name of ['facts', 'profile', 'agentName'] as const) {
        const t = optString(tokens[name]);
        if (t) taskTokens[name] = t;
      }
      const d = it.factsDecision as OnboardingRecord['factsDecision'] | undefined;
      return {
        onboardingId,
        tenantId: validTenantId(it.tenantId),
        taskTokens,
        factsShown: strings(it.factsShown),
        factsDecision: d && typeof d === 'object' ? d : undefined,
        factsCompletedAt: optString(it.factsCompletedAt),
        agentName: optString(it.agentName),
        agentNameLockedAt: optString(it.agentNameLockedAt),
      };
    },

    async listFacts(tenantId) {
      const pk = keys.tenantPk(asTenantId(tenantId));
      const out: FactRecord[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const r = await client.send(new QueryCommand({
          TableName: table, ConsistentRead: true,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :f)',
          ExpressionAttributeValues: { ':pk': pk, ':f': 'FACT#' },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }));
        for (const it of (r.Items ?? []) as Array<Record<string, unknown>>) {
          const id = String(it.SK ?? '').slice('FACT#'.length);
          if (!ID_RE.test(id)) continue;
          out.push({
            id, text: String(it.text ?? ''), source: String(it.source ?? ''), verified: it.verified === true,
            flaggedInstructionLike: it.flaggedInstructionLike === true,
            flags: strings(it.flags),
            decision: it.decision === 'approved' || it.decision === 'rejected' ? it.decision : undefined,
            createdAt: optString(it.createdAt),
          });
        }
        start = r.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (start && out.length < MAX_FACT_ITEMS);
      return out;
    },

    async saveShown(onboardingId, ids, at) {
      await client.send(new UpdateCommand({
        TableName: table, Key: stateKey(onboardingId), ConditionExpression: 'attribute_exists(PK)',
        UpdateExpression: 'SET factsShown = :ids, factsShownAt = :at',
        ExpressionAttributeValues: { ':ids': [...ids], ':at': at },
      }));
    },

    async applyFactDecisions(onboardingId, tenantId, decisions, summary, meta) {
      const pk = keys.tenantPk(asTenantId(tenantId));
      if (decisions.length) {
        try {
          await client.send(new TransactWriteCommand({
            TransactItems: decisions.map(({ id, decision }) => {
              const approve = decision === 'approved';
              return {
                Update: {
                  TableName: table, Key: { PK: pk, SK: keys.factSk(id) },
                  UpdateExpression: 'SET #verified = :v, #decision = :d, decidedAt = :at, decidedVia = :via' +
                    (meta.messageId ? ', decidedMessageId = :msg' : ' REMOVE decidedMessageId'),
                  // An approval can never land on a fact that is (or became) flagged; the handler also holds those back.
                  ConditionExpression: 'attribute_exists(PK)' + (approve ? ' AND (attribute_not_exists(flaggedInstructionLike) OR flaggedInstructionLike = :no)' : ''),
                  ExpressionAttributeNames: { '#verified': 'verified', '#decision': 'decision' },
                  ExpressionAttributeValues: {
                    ':v': approve, ':d': decision, ':at': meta.at, ':via': 'onboarding-agent',
                    ...(approve ? { ':no': false } : {}),
                    ...(meta.messageId ? { ':msg': meta.messageId } : {}),
                  },
                },
              };
            }),
          }));
        } catch (err) {
          if (errName(err) === 'TransactionCanceledException') throw new FactChangedError();
          throw err;
        }
      }
      await client.send(new UpdateCommand({
        TableName: table, Key: stateKey(onboardingId), ConditionExpression: 'attribute_exists(PK)',
        UpdateExpression: 'SET factsDecision = :d',
        ExpressionAttributeValues: { ':d': { at: meta.at, ...summary, ...(meta.messageId ? { messageId: meta.messageId } : {}) } },
      }));
    },

    async saveAgentName(onboardingId, tenantId, name, at) {
      const set = { UpdateExpression: 'SET agentName = :n, agentNamedAt = :at', ExpressionAttributeValues: { ':n': name, ':at': at } };
      await client.send(new UpdateCommand({ TableName: table, Key: stateKey(onboardingId), ConditionExpression: 'attribute_exists(PK)', ...set }));
      if (!tenantId) return { profileUpdated: false };
      try {
        // Never creates PROFILE: another lane owns its creation, and a half-empty one could break its conditional put.
        await client.send(new UpdateCommand({
          TableName: table, Key: { PK: keys.tenantPk(asTenantId(tenantId)), SK: keys.profileSk() }, ConditionExpression: 'attribute_exists(PK)', ...set,
        }));
        return { profileUpdated: true };
      } catch (err) {
        if (errName(err) === 'ConditionalCheckFailedException') return { profileUpdated: false };
        throw err;
      }
    },

    async markStepDone(onboardingId, step, token, at) {
      const done = step === 'facts' ? 'factsCompletedAt' : 'agentNameLockedAt';
      const base = { TableName: table, Key: stateKey(onboardingId) };
      if (token) {
        try {
          await client.send(new UpdateCommand({
            ...base, UpdateExpression: 'SET #done = :at REMOVE taskTokens.#step', ConditionExpression: 'taskTokens.#step = :t',
            ExpressionAttributeNames: { '#done': done, '#step': step }, ExpressionAttributeValues: { ':at': at, ':t': token },
          }));
          return;
        } catch (err) {
          if (errName(err) !== 'ConditionalCheckFailedException') throw err; // the token was already removed or replaced
        }
      }
      try {
        await client.send(new UpdateCommand({
          ...base, UpdateExpression: 'SET #done = :at', ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: { '#done': done }, ExpressionAttributeValues: { ':at': at },
        }));
      } catch (err) {
        if (errName(err) !== 'ConditionalCheckFailedException') throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Lambda entry
// ---------------------------------------------------------------------------------------------------------------

let prod: OnboardingApiDeps | undefined;

/** Built on first use (not at import), so tests and tooling can import this file without AWS configuration. */
export function prodDeps(): OnboardingApiDeps {
  if (prod) return prod;
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME is not set');
  prod = {
    store: ddbOnboardingStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), table),
    workflow: sfnWorkflow(new SFNClient({})),
    authorize: serviceTokenAuthorizer(loadServiceTokens),
  };
  return prod;
}

export async function serveProd(make: (deps: OnboardingApiDeps) => (event: unknown) => Promise<ApiResult>, event: unknown): Promise<ApiResult> {
  let deps: OnboardingApiDeps;
  try {
    deps = prodDeps();
  } catch (err) {
    log('error', 'onboarding api is not configured', { error: (err as Error).message });
    return fail(500, 'unavailable', "That didn't go through. Try again in a moment.");
  }
  return make(deps)(event);
}

export const handler = (event: unknown): Promise<ApiResult> => serveProd(makeFactsHandler, event);
