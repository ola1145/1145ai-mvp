/**
 * Upsert customer from a call (merge by phone via GSI1, never overwrite owner edits).
 * Owner: issue G2 (tasks/G2.md).
 *
 * Rules this file keeps:
 *  - One customer per phone per tenant. The caller is found through GSI1 (`TENANT#<tid>#PHONE` / `<e164>`), so a customer
 *    the owner already has is merged into, not duplicated. A new one gets an id derived from the phone, so two calls
 *    ending together cannot create two records (the second conditional create fails and merges instead).
 *  - Owner edits win. A call only fills a field that is empty (name, phones), and never touches email or notes. A field
 *    listed in the record's `ownerEditedFields` is never filled. Everything the call adds lives in fields of its own
 *    (`lastSeen`, `callCount`, `lastCallId`, `lastCallSummary`).
 *  - Updates are targeted UpdateItem writes, never a whole-item put, so an owner edit that lands in between cannot be
 *    overwritten. Fill and `lastSeen` writes carry a compare-and-set on the value that was read; losing the race just
 *    re-reads and re-plans.
 *  - One call counts once: the customer write and an `IDEMP#crm:<callId>` guard item share one transaction.
 *  - The tenant id is the event's. The phone is the carrier caller id fetched server-side (never the model's words), and
 *    the summary is stored as data only, clamped and stripped of control characters.
 */
import { createHash } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { asTenantId, keys, type TenantId } from '@1145/shared';
import type { PostCallDeps } from './handler.js';
import { assertCallId, cancellationCodes, guardTtl, replayGuardSk, toDate, type TenantDocProvider } from './usage-store.js';

const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_SUMMARY = 500;
const MAX_NAME = 80;
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** `+12145550123` from what a person or a carrier might write, or undefined when it is not a real E.164 number. */
export function normalizePhone(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().replace(/[\s().-]/g, '');
  return E164.test(s) ? s : undefined;
}

/** Deterministic customer id for a phone, so concurrent first calls collide on one key instead of making two records. */
export function customerIdForPhone(phone: string): string {
  return `c_${createHash('sha256').update(phone).digest('hex').slice(0, 20)}`;
}

const clean = (s: string, max: number): string => s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

export interface StoredCustomer {
  customerId: string;
  name?: string;
  phones?: string[];
  lastSeen?: string;
  /** Fields the owner has edited by hand; a call never fills these. */
  ownerEditedFields?: string[];
}

export interface PlanInput { phone: string; callId: string; summary: string; at: string; name?: string }

export type CustomerWrite =
  | { kind: 'create'; customerId: string; phone: string; callId: string; summary: string; at: string; name?: string }
  | {
      kind: 'touch';
      customerId: string;
      phone: string;
      callId: string;
      /** Set the name, only if the stored name is still exactly `expect` (empty or missing). */
      fillName?: { name: string; expect: string | undefined };
      /** Set `phones` to [phone], only if the customer has none. */
      fillPhones?: true;
      /** Move lastSeen and the last-call fields forward, only if lastSeen is still exactly `expect`. */
      seen?: { at: string; summary: string; expect: string | undefined };
    };

/** Pure: what to write for this call given what is stored. Never plans to touch email, notes or a name that is set. */
export function planCustomerWrite(existing: StoredCustomer | undefined, input: PlanInput): CustomerWrite {
  if (!existing) {
    return {
      kind: 'create', customerId: customerIdForPhone(input.phone), phone: input.phone, callId: input.callId, summary: input.summary, at: input.at,
      ...(input.name ? { name: input.name } : {}),
    };
  }
  const ownerEdited = (field: string) => existing.ownerEditedFields?.includes(field) === true;
  const blankName = typeof existing.name !== 'string' || existing.name.trim() === '';
  const newer = existing.lastSeen === undefined || !(Date.parse(existing.lastSeen) >= Date.parse(input.at));
  return {
    kind: 'touch',
    customerId: existing.customerId,
    phone: input.phone,
    callId: input.callId,
    ...(input.name && blankName && !ownerEdited('name') ? { fillName: { name: input.name, expect: existing.name } } : {}),
    ...(existing.phones === undefined && !ownerEdited('phones') ? { fillPhones: true as const } : {}),
    ...(newer ? { seen: { at: input.at, summary: input.summary, expect: existing.lastSeen } } : {}),
  };
}

// ───────────────────────────── store port ─────────────────────────────

export interface CustomerStore {
  /** The customer for this phone: through GSI1 first, then a consistent read of the id a first call would have created. */
  findByPhone(tenantId: TenantId, phone: string): Promise<StoredCustomer | undefined>;
  /**
   * Apply one planned write together with the per-call guard.
   * `applied`: done. `replayed`: this call was already applied, nothing changed. `conflict`: the record changed since it
   * was read (or another call created it first); read again and re-plan.
   */
  write(tenantId: TenantId, callId: string, op: CustomerWrite): Promise<'applied' | 'replayed' | 'conflict'>;
}

type Row = Record<string, unknown>;

function toStored(row: Row): StoredCustomer | undefined {
  const sk = String(row.SK ?? '');
  if (!sk.startsWith('CUSTOMER#')) return undefined;
  return {
    customerId: typeof row.customerId === 'string' ? row.customerId : sk.slice('CUSTOMER#'.length),
    ...(typeof row.name === 'string' ? { name: row.name } : {}),
    ...(Array.isArray(row.phones) ? { phones: row.phones.filter((p): p is string => typeof p === 'string') } : {}),
    ...(typeof row.lastSeen === 'string' ? { lastSeen: row.lastSeen } : {}),
    ...(Array.isArray(row.ownerEditedFields) ? { ownerEditedFields: row.ownerEditedFields.filter((f): f is string => typeof f === 'string') } : {}),
  };
}

export function createDdbCustomerStore(docFor: TenantDocProvider, table: string, now: () => number = Date.now): CustomerStore {
  return {
    async findByPhone(tenantId, phone) {
      const doc = await docFor(tenantId);
      const PK = keys.tenantPk(tenantId);
      const q = await doc.send(new QueryCommand({
        TableName: table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p AND GSI1SK = :n',
        ExpressionAttributeValues: { ':p': `${PK}#PHONE`, ':n': phone }, Limit: 10,
      }));
      const found = (q.Items ?? []).map((i) => toStored(i)).filter((c): c is StoredCustomer => c !== undefined);
      const ours = customerIdForPhone(phone);
      const hit = found.find((c) => c.customerId === ours) ?? found.sort((a, b) => a.customerId.localeCompare(b.customerId))[0];
      if (hit) return hit;
      // GSI1 is eventually consistent: a customer a moment-ago call created may not be in it yet.
      const g = await doc.send(new GetCommand({ TableName: table, Key: { PK, SK: keys.customerSk(ours) }, ConsistentRead: true }));
      return g.Item ? toStored(g.Item) : undefined;
    },

    async write(tenantId, callId, op) {
      const doc = await docFor(tenantId);
      const PK = keys.tenantPk(tenantId);
      const guard = {
        Put: {
          TableName: table,
          Item: { PK, SK: replayGuardSk('crm', callId), customerId: op.customerId, ttl: guardTtl(now()) },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      };

      let customer: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>[number];
      if (op.kind === 'create') {
        customer = {
          Put: {
            TableName: table,
            Item: {
              PK, SK: keys.customerSk(op.customerId), GSI1PK: `${PK}#PHONE`, GSI1SK: op.phone,
              customerId: op.customerId, ...(op.name ? { name: op.name } : {}), phones: [op.phone],
              lastSeen: op.at, lastCallId: op.callId, lastCallSummary: op.summary, callCount: 1, createdAt: op.at, createdBy: 'call',
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        };
      } else {
        const names: Record<string, string> = { '#callCount': 'callCount' };
        const values: Record<string, unknown> = { ':one': 1 };
        const sets: string[] = [];
        const conditions = ['attribute_exists(PK)'];
        if (op.seen) {
          Object.assign(names, { '#lastSeen': 'lastSeen', '#lastCallId': 'lastCallId', '#lastCallSummary': 'lastCallSummary' });
          Object.assign(values, { ':at': op.seen.at, ':callId': op.callId, ':summary': op.seen.summary });
          sets.push('#lastSeen = :at', '#lastCallId = :callId', '#lastCallSummary = :summary');
          if (op.seen.expect === undefined) conditions.push('attribute_not_exists(#lastSeen)');
          else { conditions.push('#lastSeen = :expectSeen'); values[':expectSeen'] = op.seen.expect; }
        }
        if (op.fillName) {
          names['#name'] = 'name';
          values[':name'] = op.fillName.name;
          sets.push('#name = :name');
          if (op.fillName.expect === undefined) conditions.push('attribute_not_exists(#name)');
          else { conditions.push('#name = :expectName'); values[':expectName'] = op.fillName.expect; }
        }
        if (op.fillPhones) {
          names['#phones'] = 'phones';
          values[':phones'] = [op.phone];
          sets.push('#phones = :phones');
          conditions.push('attribute_not_exists(#phones)');
        }
        customer = {
          Update: {
            TableName: table,
            Key: { PK, SK: keys.customerSk(op.customerId) },
            UpdateExpression: `${sets.length ? `SET ${sets.join(', ')} ` : ''}ADD #callCount :one`,
            ConditionExpression: conditions.join(' AND '),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          },
        };
      }

      try {
        await doc.send(new TransactWriteCommand({ TransactItems: [customer, guard] }));
        return 'applied';
      } catch (err) {
        const codes = cancellationCodes(err);
        if (!codes) throw err;
        if (codes[1] === 'ConditionalCheckFailed') return 'replayed'; // the guard exists: this call is already in the record
        if (codes[0] === 'ConditionalCheckFailed' || codes.includes('TransactionConflict')) return 'conflict';
        throw err;
      }
    },
  };
}

// ───────────────────────────── upsert ─────────────────────────────

export interface CustomerUpsertInput {
  /** From the call.ended envelope. */
  tenantId: string;
  callId: string;
  /** Carrier caller id in E.164, looked up server-side. Never taken from the transcript or the analysis. */
  phone: string;
  /** The analysis summary. Stored as data in `lastCallSummary`, never in the owner's notes. */
  summary: string;
  /** When the call ended. */
  at: Date | string;
  /** A name the system already trusts (for example a verified booking). Only ever fills an empty name. */
  name?: string;
}

export type CustomerUpsertResult =
  | { status: 'created' | 'updated' | 'replayed'; customerId: string }
  | { status: 'skipped'; reason: 'no_phone' | 'invalid_phone' };

export interface UpsertDeps {
  store: CustomerStore;
  /** Re-plan attempts when the record changes underneath us. Default 5. */
  maxAttempts?: number;
}

export async function upsertCustomerFromCall(input: CustomerUpsertInput, deps: UpsertDeps): Promise<CustomerUpsertResult> {
  const tenantId = asTenantId(input.tenantId);
  assertCallId(input.callId);
  const phone = normalizePhone(input.phone);
  if (!phone) return { status: 'skipped', reason: typeof input.phone === 'string' && input.phone.trim() ? 'invalid_phone' : 'no_phone' };

  const plan: PlanInput = {
    phone, callId: input.callId, at: toDate(input.at).toISOString(), summary: clean(input.summary ?? '', MAX_SUMMARY),
    ...(input.name && clean(input.name, MAX_NAME) ? { name: clean(input.name, MAX_NAME) } : {}),
  };

  const attempts = deps.maxAttempts ?? 5;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const existing = await deps.store.findByPhone(tenantId, phone);
    const op = planCustomerWrite(existing, plan);
    const outcome = await deps.store.write(tenantId, input.callId, op);
    if (outcome === 'conflict') continue;
    if (outcome === 'replayed') return { status: 'replayed', customerId: op.customerId };
    return { status: op.kind === 'create' ? 'created' : 'updated', customerId: op.customerId };
  }
  throw new Error('customer record kept changing; giving up');
}

// ───────────────────────────── PostCallDeps adapter ─────────────────────────────

export interface CallerFacts {
  /** Carrier caller id, E.164. */
  phone?: string;
  name?: string;
  /** When the call ended, if known. */
  at?: string;
}

export interface CrmDeps extends UpsertDeps {
  /**
   * Who called, from a source the model cannot influence (the engine's verified SIP caller id). Returns nothing when
   * the call had no usable number; then the customer step is skipped.
   */
  callerFor(tenantId: string, callId: string): Promise<CallerFacts | undefined>;
  now?: () => Date;
}

/** Adapter for PostCallDeps.upsertCustomerFromCall. Tenant and call id come from the event via the handler's arguments. */
export function makeUpsertCustomerFromCall(deps: CrmDeps): PostCallDeps['upsertCustomerFromCall'] {
  return async (tenantId, callId, summary) => {
    const caller = await deps.callerFor(tenantId, callId);
    await upsertCustomerFromCall(
      {
        tenantId, callId, summary, phone: caller?.phone ?? '', at: caller?.at ?? (deps.now?.() ?? new Date()),
        ...(caller?.name ? { name: caller.name } : {}),
      },
      deps,
    );
  };
}
