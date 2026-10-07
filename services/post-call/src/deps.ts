/**
 * Production PostCallDeps and the EventBridge Lambda entrypoint for call.ended.
 * Owner: issue G3 (tasks/G3.md). The logic lives in handler.ts; this file wires AWS to it:
 *
 *   parseCallEnded      what the Lambda accepts off the bus (source, tenant, call id, transcript folder)
 *   createDynamoLedger  per-call progress and lease at TENANT#<tid> / POSTCALL#<callId>
 *   createPostCallDeps  S3 transcript, Bedrock analysis (G1), conversation record, EventBridge, and G2's three ports
 *   loadG2Ports         finds G2's modules by name; fails loudly if one is missing
 *   handler             the Lambda entry
 *
 * Tenant identity comes from the envelope on the bus, nowhere else. Nothing here logs call content.
 */
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { asTenantId, keys, type CallEndedData, type EventEnvelope } from '@1145/shared';
import { analyzeCall, bedrockInvoker, type AnalyzeDeps, type FlaggedTurn } from './analyze.js';
import {
  LeaseLostError,
  onCallEnded,
  STEPS,
  type CallEndedResult,
  type CallLease,
  type CallLedger,
  type CallProgress,
  type ConversationRecord,
  type LoadedTranscript,
  type PostCallDeps,
  type Step,
  type StepOutput,
  type StoredAnalysis,
  type Turn,
} from './handler.js';

type Line = Record<string, unknown>;
export type Db = Pick<DynamoDBDocumentClient, 'send'>;

export const EVENT_SOURCE = '1145.post-call';
/** Same default the other Bedrock callers in the repo use; the stack passes ANALYSIS_MODEL_ID. */
export const DEFAULT_ANALYSIS_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

// ─────────────────────────────── what the Lambda accepts ───────────────────────────────

export class InvalidCallEnded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCallEnded';
  }
}

const CALL_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const TRANSCRIPT_NAME_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_CALL_SEC = 24 * 3600;
const END_REASONS: ReadonlyArray<CallEndedData['endReason']> = ['caller_hangup', 'agent_hangup', 'transfer', 'error', 'over_cap', 'suspended'];

const record = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new InvalidCallEnded(`${what} must be an object`);
  return v as Record<string, unknown>;
};

/**
 * Checks an EventBridge event and returns the call.ended envelope. Errors name the field, never echo its value.
 * A transcript key outside tenants/<tid>/transcripts/ is dropped (the call is still billed): the Lambda can read
 * every tenant's transcripts, so the tenant boundary for that read is this check.
 */
export function parseCallEnded(event: unknown): EventEnvelope<CallEndedData> {
  const e = record(event, 'event');
  if (typeof e.source !== 'string' || !e.source.startsWith('1145.')) throw new InvalidCallEnded('source must be a 1145 service');
  if (e['detail-type'] !== 'call.ended') throw new InvalidCallEnded('detail-type must be call.ended');
  const d = record(e.detail, 'detail');
  if (d.type !== 'call.ended') throw new InvalidCallEnded('detail.type must be call.ended');
  if (d.version !== 1) throw new InvalidCallEnded('unsupported envelope version');
  let tenantId;
  try {
    tenantId = asTenantId(typeof d.tenantId === 'string' ? d.tenantId : '');
  } catch {
    throw new InvalidCallEnded('invalid tenantId');
  }
  if (typeof d.occurredAt !== 'string' || Number.isNaN(Date.parse(d.occurredAt))) throw new InvalidCallEnded('invalid occurredAt');

  const data = record(d.data, 'data');
  if (typeof data.callId !== 'string' || !CALL_ID_RE.test(data.callId)) throw new InvalidCallEnded('invalid callId');
  const durationSec = data.durationSec;
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec < 0 || durationSec > MAX_CALL_SEC) throw new InvalidCallEnded('invalid durationSec');
  const endReason = END_REASONS.find((r) => r === data.endReason);
  if (!endReason) throw new InvalidCallEnded('invalid endReason');

  const prefix = `tenants/${tenantId}/transcripts/`;
  const key = typeof data.transcriptKey === 'string' ? data.transcriptKey : undefined;
  const transcriptKey = key && key.startsWith(prefix) && !key.includes('..') && TRANSCRIPT_NAME_RE.test(key.slice(prefix.length)) ? key : undefined;
  const engineConversationId = typeof data.engineConversationId === 'string' && data.engineConversationId.length <= 200 ? data.engineConversationId : undefined;
  const channel = data.channel === 'voice' || data.channel === 'webchat' ? data.channel : undefined;

  return {
    type: 'call.ended',
    version: 1,
    tenantId,
    correlationId: typeof d.correlationId === 'string' && d.correlationId ? d.correlationId : data.callId,
    occurredAt: d.occurredAt,
    data: {
      callId: data.callId,
      durationSec,
      endReason,
      ...(transcriptKey ? { transcriptKey } : {}),
      ...(engineConversationId ? { engineConversationId } : {}),
      ...(channel ? { channel } : {}),
    },
  };
}

// ─────────────────────────────── the ledger ───────────────────────────────

/** Longer than the Lambda timeout (60 s), shorter than the first async retry gap, so a dead run is taken over. */
const LEASE_SEC = 75;
/** Longer than the 30-day event archive, so an archive replay still finds the finished ledger. */
const LEDGER_TTL_DAYS = 60;

const conditionFailed = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
const isEpoch = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function readUsage(v: unknown): CallProgress['usage'] {
  const u = v as { seconds?: unknown; usedSec?: unknown; capSec?: unknown } | null;
  return u && isEpoch(u.seconds) && isEpoch(u.usedSec) && isEpoch(u.capSec) ? { seconds: u.seconds, usedSec: u.usedSec, capSec: u.capSec } : undefined;
}

const E164_RE = /^\+[1-9]\d{6,14}$/;
const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;

function readAnalysis(v: unknown): StoredAnalysis | undefined {
  const a = v as { summary?: unknown; sentiment?: unknown; intents?: unknown; callerE164?: unknown } | null;
  if (!a || typeof a.summary !== 'string' || !SENTIMENTS.includes(a.sentiment as never) || !Array.isArray(a.intents) || !a.intents.every((i) => typeof i === 'string')) return undefined;
  return {
    summary: a.summary,
    sentiment: a.sentiment as StoredAnalysis['sentiment'],
    intents: a.intents as string[],
    ...(typeof a.callerE164 === 'string' && E164_RE.test(a.callerE164) ? { callerE164: a.callerE164 } : {}),
  };
}

function readProgress(item: Record<string, unknown> | undefined): CallProgress {
  const done = new Set<Step>(STEPS.filter((s) => typeof item?.[`step_${s}`] === 'string'));
  const usage = readUsage(item?.usage);
  const analysis = readAnalysis(item?.analysis);
  return { done, ...(usage ? { usage } : {}), ...(analysis ? { analysis } : {}) };
}

export interface LedgerOptions {
  db: Db;
  table: string;
  now?: () => Date;
  /** Unique per begin(). Tests pass a counter. */
  newToken?: () => string;
  leaseSec?: number;
}

/**
 * Item: PK TENANT#<tid>, SK POSTCALL#<callId>. Attributes: leaseOwner, leaseUntil (epoch s), step_<name> (ISO time),
 * usage, analysis, ttl. Everything is a conditional UpdateItem on that one item, so the only IAM it needs is
 * UpdateItem under the tenant's own partition.
 */
export function createDynamoLedger(o: LedgerOptions): CallLedger {
  const now = o.now ?? (() => new Date());
  const newToken = o.newToken ?? randomUUID;
  const leaseSec = o.leaseSec ?? LEASE_SEC;

  return {
    async begin(tenantId, callId): Promise<CallLease | undefined> {
      if (callId.includes('#')) throw new Error('invalid call id');
      const Key = { PK: keys.tenantPk(tenantId), SK: `POSTCALL#${callId}` };
      const token = newToken();
      const nowSec = Math.floor(now().getTime() / 1000);
      let attributes: Record<string, unknown> | undefined;
      try {
        const r = (await o.db.send(new UpdateCommand({
          TableName: o.table,
          Key,
          UpdateExpression: 'SET #owner = :owner, #until = :until, #ttl = :ttl',
          // Free if the item is new or the previous holder's lease has run out (or was released: leaseUntil 0).
          ConditionExpression: 'attribute_not_exists(PK) OR #until < :now',
          ExpressionAttributeNames: { '#owner': 'leaseOwner', '#until': 'leaseUntil', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':owner': token, ':until': nowSec + leaseSec, ':ttl': nowSec + LEDGER_TTL_DAYS * 24 * 3600, ':now': nowSec },
          ReturnValues: 'ALL_NEW',
        }))) as { Attributes?: Record<string, unknown> };
        attributes = r.Attributes;
      } catch (e) {
        if (conditionFailed(e)) return undefined;
        throw e;
      }

      return {
        progress: readProgress(attributes),
        async record(step: Step, output?: StepOutput) {
          const names: Record<string, string> = { '#owner': 'leaseOwner', '#step': `step_${step}` };
          const values: Record<string, unknown> = { ':owner': token, ':at': now().toISOString() };
          let expr = 'SET #step = :at';
          if (output?.usage) { expr += ', #usage = :usage'; names['#usage'] = 'usage'; values[':usage'] = output.usage; }
          if (output?.analysis) { expr += ', #analysis = :analysis'; names['#analysis'] = 'analysis'; values[':analysis'] = output.analysis; }
          try {
            await o.db.send(new UpdateCommand({ TableName: o.table, Key, UpdateExpression: expr, ConditionExpression: '#owner = :owner', ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
          } catch (e) {
            if (conditionFailed(e)) throw new LeaseLostError(tenantId, callId);
            throw e;
          }
        },
        async release() {
          try {
            await o.db.send(new UpdateCommand({
              TableName: o.table,
              Key,
              UpdateExpression: 'SET #until = :zero',
              ConditionExpression: '#owner = :owner',
              ExpressionAttributeNames: { '#until': 'leaseUntil', '#owner': 'leaseOwner' },
              ExpressionAttributeValues: { ':zero': 0, ':owner': token },
            }));
          } catch {
            // Not ours any more, or DynamoDB is unwell. Either way the lease runs out by itself.
          }
        },
      };
    },
  };
}

// ─────────────────────────────── G2's modules ───────────────────────────────

/** Everything G2's factories get. Same db client, table and publisher this Lambda uses. */
export interface G2Env {
  db: Db;
  table: string;
  publish(e: EventEnvelope): Promise<void>;
  now: () => Date;
  /** Secrets Manager name of the Stripe key (STRIPE_SECRET_ID). G2's stripe module fetches the value itself. */
  stripeSecretId?: string;
}

/** The three calls G3 needs from G2. Each must be safe to repeat for the same callId. */
export interface G2Ports {
  upsertCustomerFromCall: PostCallDeps['upsertCustomerFromCall'];
  addUsage: PostCallDeps['addUsage'];
  reportStripeUsage: PostCallDeps['reportStripeUsage'];
}

export interface G2Modules {
  crm(): Promise<unknown>;
  usageStore(): Promise<unknown>;
  stripeUsage(): Promise<unknown>;
}
const g2Modules: G2Modules = {
  crm: () => import('./crm.js'),
  usageStore: () => import('./usage-store.js'),
  stripeUsage: () => import('./stripe-usage.js'),
};

type AnyFn = (...args: never[]) => unknown;
function portFrom(mod: unknown, file: string, factory: string, method: string, env: G2Env): AnyFn {
  const make = (mod as Record<string, unknown> | null)?.[factory];
  if (typeof make !== 'function') throw new Error(`${file} does not export ${factory}(env). G3 expects it: see contracts/CHANGE_REQUESTS/G3-1.md`);
  const port = (make as (env: G2Env) => Record<string, unknown> | undefined)(env);
  const call = port?.[method];
  if (typeof call !== 'function') throw new Error(`${file}: ${factory}() must return an object with ${method}(). See contracts/CHANGE_REQUESTS/G3-1.md`);
  return (call as AnyFn).bind(port);
}

/**
 * Finds G2's modules by the names agreed in contracts/CHANGE_REQUESTS/G3-1.md. A missing one throws, so the
 * invocation fails and the event waits in the dead-letter queue: never a stand-in that quietly skips billing.
 */
export async function loadG2Ports(env: G2Env, modules: G2Modules = g2Modules): Promise<G2Ports> {
  const [crm, usageStore, stripeUsage] = await Promise.all([modules.crm(), modules.usageStore(), modules.stripeUsage()]);
  return {
    upsertCustomerFromCall: portFrom(crm, 'crm.ts', 'createCrm', 'upsertCustomerFromCall', env) as G2Ports['upsertCustomerFromCall'],
    addUsage: portFrom(usageStore, 'usage-store.ts', 'createUsageStore', 'addUsage', env) as G2Ports['addUsage'],
    reportStripeUsage: portFrom(stripeUsage, 'stripe-usage.ts', 'createStripeUsage', 'reportUsage', env) as G2Ports['reportStripeUsage'],
  };
}

// ─────────────────────────────── the production dependencies ───────────────────────────────

export function eventBridgePublisher(events: Pick<EventBridgeClient, 'send'>, busName: string): (e: EventEnvelope) => Promise<void> {
  return async (e) => {
    const r = await events.send(new PutEventsCommand({ Entries: [{ EventBusName: busName, Source: EVENT_SOURCE, DetailType: e.type, Detail: JSON.stringify(e) }] }));
    if (r.FailedEntryCount) throw new Error(`PutEvents rejected: ${r.Entries?.find((x) => x.ErrorCode)?.ErrorCode ?? 'unknown'}`);
  };
}

const MAX_TURNS = 400;
const MAX_FLAGGED = 20;
const MAX_FLAGGED_TEXT = 500;

/** The voice worker's transcript object, reduced to valid turns. Anything unreadable counts as "no transcript". */
function parseTranscript(body: string | undefined): LoadedTranscript | undefined {
  if (!body) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    return undefined;
  }
  const o = obj as { turns?: unknown; callerE164?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.turns)) return undefined;
  const turns: Turn[] = [];
  for (const t of o.turns as Array<{ role?: unknown; text?: unknown }>) {
    if ((t?.role === 'agent' || t?.role === 'caller') && typeof t.text === 'string' && t.text.trim()) turns.push({ role: t.role, text: t.text });
    if (turns.length >= MAX_TURNS) break;
  }
  return { turns, ...(typeof o.callerE164 === 'string' && E164_RE.test(o.callerE164) ? { callerE164: o.callerE164 } : {}) };
}

export interface PostCallConfig {
  db: Db;
  s3: Pick<S3Client, 'send'>;
  events: Pick<EventBridgeClient, 'send'>;
  /** Production: bedrockInvoker(client, modelId). Tests: a fake. */
  invokeModel: AnalyzeDeps['invokeModel'];
  g2: G2Ports;
  table: string;
  bucket: string;
  busName: string;
  now?: () => Date;
  newToken?: () => string;
  log?: (line: Line) => void;
}

export function createPostCallDeps(c: PostCallConfig): PostCallDeps {
  const now = c.now ?? (() => new Date());
  // Flagged turns are saved with the conversation record (one write, one place), so there is nothing to store here.
  const analyzeDeps: AnalyzeDeps = { invokeModel: c.invokeModel, storeFlaggedTurns: async () => {} };
  const publish = eventBridgePublisher(c.events, c.busName);

  return {
    ledger: createDynamoLedger({ db: c.db, table: c.table, now, ...(c.newToken ? { newToken: c.newToken } : {}) }),

    async loadTranscript(key) {
      // Only GetObject is granted (no bucket listing), so S3 may answer AccessDenied instead of NoSuchKey for an
      // object that is gone. That is deliberately not treated as "no transcript": it throws, retries, and ends up
      // in the DLQ where someone looks, instead of silently skipping the analysis if the grant is ever wrong.
      try {
        const r = await c.s3.send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
        return parseTranscript(await r.Body?.transformToString());
      } catch (e) {
        if ((e as { name?: string } | null)?.name === 'NoSuchKey') return undefined;
        throw e;
      }
    },

    analyze: (input) => analyzeCall(input, analyzeDeps),

    async saveConversation(rec: ConversationRecord) {
      const flagged = rec.naturalness.flaggedTurns.slice(0, MAX_FLAGGED).map((t: FlaggedTurn) => ({ turn: t.turn, text: t.text.slice(0, MAX_FLAGGED_TEXT), score: t.score, issues: t.issues }));
      // A plain overwrite: every value derives from the event and the analysis, so a repeat writes the same item.
      const attrs: Record<string, unknown> = {
        callId: rec.callId,
        channel: rec.channel,
        durationSec: rec.durationSec,
        endReason: rec.endReason,
        transcriptKey: rec.transcriptKey,
        summary: rec.summary,
        sentiment: rec.sentiment,
        intents: rec.intents,
        naturalnessScore: rec.naturalness.score,
        worstTurnScore: rec.naturalness.worstTurnScore,
        flaggedTurns: flagged,
        analyzedAt: now().toISOString(),
      };
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const sets = Object.entries(attrs).map(([name, value], i) => {
        names[`#a${i}`] = name;
        values[`:v${i}`] = value;
        return `#a${i} = :v${i}`;
      });
      await c.db.send(new UpdateCommand({
        TableName: c.table,
        Key: { PK: keys.tenantPk(rec.tenantId), SK: keys.convSk(rec.startedAt, rec.callId) },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }));
    },

    upsertCustomerFromCall: c.g2.upsertCustomerFromCall,
    addUsage: c.g2.addUsage,
    reportStripeUsage: c.g2.reportStripeUsage,
    publish,
    log: c.log ?? ((line) => console.log(JSON.stringify(line))),
  };
}

// ─────────────────────────────── the Lambda entry ───────────────────────────────

/**
 * Builds the entrypoint. Dependencies are built on first use and kept for the warm container; a failed build is
 * not kept, so the next invocation tries again. A bad event is logged (without its payload) and dropped: retrying
 * it cannot help. A failed pipeline throws, so Lambda retries and, in the end, parks the event in the DLQ.
 */
export function createHandler(getDeps: () => Promise<PostCallDeps>, log: (line: Line) => void = (l) => console.log(JSON.stringify(l))) {
  let pending: Promise<PostCallDeps> | undefined;
  const deps = () => (pending ??= getDeps().catch((e: unknown) => { pending = undefined; throw e; }));
  return async (event: unknown): Promise<CallEndedResult> => {
    let evt: EventEnvelope<CallEndedData>;
    try {
      evt = parseCallEnded(event);
    } catch (e) {
      log({ level: 'error', msg: 'post-call-invalid-event', reason: e instanceof Error ? e.message : 'unreadable' });
      return { skipped: true, reason: 'invalid_event' };
    }
    return onCallEnded(evt, await deps());
  };
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function buildProductionDeps(): Promise<PostCallDeps> {
  const table = need('TABLE_NAME');
  const bucket = need('TENANT_BUCKET');
  const busName = need('EVENT_BUS_NAME');
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const events = new EventBridgeClient({});
  const g2 = await loadG2Ports({ db, table, publish: eventBridgePublisher(events, busName), now: () => new Date(), stripeSecretId: process.env.STRIPE_SECRET_ID });
  return createPostCallDeps({
    db,
    s3: new S3Client({}),
    events,
    invokeModel: bedrockInvoker(new BedrockRuntimeClient({}), process.env.ANALYSIS_MODEL_ID ?? DEFAULT_ANALYSIS_MODEL),
    g2,
    table,
    bucket,
    busName,
  });
}

export const handler = createHandler(buildProductionDeps);
