import {
  BatchWriteCommand, GetCommand, QueryCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { keys } from '@1145/shared';
import { HttpError } from './http.js';
import type {
  ConsoleStore, ConversationRecord, Page, TemplateVersion, TenantRecord, UsageRecord,
} from './types.js';

export interface DdbStoreConfig {
  ddb: DynamoDBDocumentClient;
  s3: S3Client;
  table: string;
  tenantBucket: string;
}

type Key = { PK: string; SK: string };

function encodeCursor(k: Key): string {
  return Buffer.from(JSON.stringify({ PK: k.PK, SK: k.SK })).toString('base64url');
}

/** A cursor is untrusted input. It may only point inside the partition (or key family) the call is allowed to read. */
function decodeCursor(cursor: string | undefined, allowed: (pk: string) => boolean): Key | undefined {
  if (!cursor) return undefined;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof v.PK === 'string' && typeof v.SK === 'string' && allowed(v.PK)) return { PK: v.PK, SK: v.SK };
  } catch { /* falls through */ }
  throw new HttpError(400, 'invalid_cursor');
}

const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export class DdbConsoleStore implements ConsoleStore {
  constructor(private cfg: DdbStoreConfig) {}

  private get table() { return this.cfg.table; }

  async listTenants(q: { limit: number; cursor?: string }): Promise<Page<TenantRecord>> {
    // No tenant index exists yet, so this reads the table in pages and keeps the PROFILE rows (see contracts/CHANGE_REQUESTS/H2-2.md).
    let start = decodeCursor(q.cursor, (pk) => pk.startsWith('TENANT#'));
    const items: TenantRecord[] = [];
    for (let pages = 0; pages < 10 && items.length < q.limit; pages++) {
      const r = await this.cfg.ddb.send(new ScanCommand({
        TableName: this.table,
        FilterExpression: 'SK = :p AND begins_with(PK, :t)',
        ExpressionAttributeValues: { ':p': keys.profileSk(), ':t': 'TENANT#' },
        ExclusiveStartKey: start,
        Limit: 500,
      }));
      items.push(...((r.Items ?? []) as TenantRecord[]));
      start = r.LastEvaluatedKey as Key | undefined;
      if (!start) break;
    }
    if (items.length > q.limit) {
      const page = items.slice(0, q.limit);
      const last = page[page.length - 1] as Key;
      return { items: page, nextCursor: encodeCursor(last) };
    }
    return { items, ...(start ? { nextCursor: encodeCursor(start) } : {}) };
  }

  async getProfile(tenantId: string): Promise<TenantRecord | undefined> {
    const r = await this.cfg.ddb.send(new GetCommand({ TableName: this.table, Key: { PK: keys.tenantPk(tenantId), SK: keys.profileSk() } }));
    return r.Item as TenantRecord | undefined;
  }

  async listUsage(tenantId: string, limit: number): Promise<UsageRecord[]> {
    const r = await this.cfg.ddb.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': keys.tenantPk(tenantId), ':sk': 'USAGE#' },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return (r.Items ?? []).map((i) => ({ month: String(i.SK).slice('USAGE#'.length), billableSeconds: Number(i.billableSeconds ?? i.seconds ?? 0) }));
  }

  async listTemplateVersions(template: string): Promise<TemplateVersion[]> {
    const r = await this.cfg.ddb.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `TEMPLATE#${template}`, ':sk': 'V#' },
    }));
    return (r.Items ?? []).map((i) => ({
      template,
      version: String(i.SK).slice('V#'.length),
      ...(typeof i.status === 'string' ? { status: i.status } : {}),
      ...(typeof i.canary === 'number' ? { canaryPercent: i.canary } : {}),
    }));
  }

  async writeState(tenantId: string, state: string, meta: { reasonCode: string; actor: string; at: string }): Promise<void> {
    await this.cfg.ddb.send(new UpdateCommand({
      TableName: this.table,
      Key: { PK: keys.tenantPk(tenantId), SK: keys.profileSk() },
      UpdateExpression: 'SET #s = :s, stateReasonCode = :r, stateActor = :a, stateUpdatedAt = :t',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':s': state, ':r': meta.reasonCode, ':a': meta.actor, ':t': meta.at },
    }));
  }

  async setTemplatePin(
    tenantId: string,
    pin: { template: string; version: string } | null,
    meta: { reasonCode: string; actor: string; at: string },
  ): Promise<void> {
    await this.cfg.ddb.send(new UpdateCommand({
      TableName: this.table,
      Key: { PK: keys.tenantPk(tenantId), SK: keys.profileSk() },
      UpdateExpression: pin ? 'SET templatePin = :p' : 'REMOVE templatePin',
      ConditionExpression: 'attribute_exists(PK)',
      ...(pin ? { ExpressionAttributeValues: { ':p': { ...pin, reasonCode: meta.reasonCode, actor: meta.actor, at: meta.at } } } : {}),
    }));
  }

  async listConversations(tenantId: string, q: { limit: number; cursor?: string }): Promise<Page<ConversationRecord>> {
    const pk = keys.tenantPk(tenantId);
    const r = await this.cfg.ddb.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': 'CONV#' },
      ScanIndexForward: false,
      Limit: q.limit,
      ExclusiveStartKey: decodeCursor(q.cursor, (p) => p === pk),
    }));
    const items = (r.Items ?? []).map((i): ConversationRecord => {
      const [startedAt = '', ...rest] = String(i.SK).slice('CONV#'.length).split('#');
      return {
        conversationId: rest.join('#'),
        startedAt,
        ...(typeof i.channel === 'string' ? { channel: i.channel } : {}),
        ...(typeof i.sentiment === 'string' ? { sentiment: i.sentiment } : {}),
        hasTranscript: typeof i.transcriptKey === 'string' && i.transcriptKey.length > 0,
      };
    });
    return { items, ...(r.LastEvaluatedKey ? { nextCursor: encodeCursor(r.LastEvaluatedKey as Key) } : {}) };
  }

  async getTranscriptKey(tenantId: string, startedAt: string, conversationId: string): Promise<{ key?: string } | undefined> {
    const r = await this.cfg.ddb.send(new GetCommand({ TableName: this.table, Key: { PK: keys.tenantPk(tenantId), SK: keys.convSk(startedAt, conversationId) } }));
    if (!r.Item) return undefined;
    return typeof r.Item.transcriptKey === 'string' ? { key: r.Item.transcriptKey } : {};
  }

  async readObject(key: string): Promise<string | undefined> {
    try {
      const r = await this.cfg.s3.send(new GetObjectCommand({ Bucket: this.cfg.tenantBucket, Key: key }));
      return await r.Body?.transformToString();
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return undefined;
      throw e;
    }
  }

  /** Every item in the tenant partition, as keys plus (optionally) attributes. Pages until the partition is done. */
  private async tenantItems(tenantId: string, projection?: string): Promise<Array<Record<string, unknown>>> {
    const pk = keys.tenantPk(tenantId);
    const out: Array<Record<string, unknown>> = [];
    let start: Key | undefined;
    do {
      const r = await this.cfg.ddb.send(new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ...(projection ? { ProjectionExpression: projection } : {}),
        ExclusiveStartKey: start,
      }));
      out.push(...((r.Items ?? []) as Array<Record<string, unknown>>));
      start = r.LastEvaluatedKey as Key | undefined;
    } while (start);
    return out;
  }

  async exportTenant(tenantId: string, exportId: string): Promise<{ key: string; itemCount: number }> {
    const items = (await this.tenantItems(tenantId)).filter((i) => !String(i.SK).startsWith('IDEMP#'));
    const key = `tenants/${tenantId}/exports/${exportId}.json`;
    await this.cfg.s3.send(new PutObjectCommand({
      Bucket: this.cfg.tenantBucket, Key: key, ContentType: 'application/json',
      Body: JSON.stringify({ schema: 1, tenantId, items }),
    }));
    return { key, itemCount: items.length };
  }

  private async batchDelete(del: Key[]): Promise<void> {
    for (const group of chunk(del, 25)) {
      let pending: Array<{ DeleteRequest: { Key: Key } }> = group.map((Key) => ({ DeleteRequest: { Key } }));
      for (let attempt = 0; pending.length > 0; attempt++) {
        if (attempt >= 5) throw new Error('batch delete left unprocessed items');
        const r = await this.cfg.ddb.send(new BatchWriteCommand({ RequestItems: { [this.table]: pending } }));
        pending = (r.UnprocessedItems?.[this.table] ?? []) as typeof pending;
        if (pending.length) await new Promise((res) => setTimeout(res, 50 * 2 ** attempt));
      }
    }
  }

  /** Route items that point at this tenant. Each one is read first, so a recycled number owned by someone else is left alone. */
  private async ownedRoutes(tenantId: string, profile: TenantRecord): Promise<Key[]> {
    const candidates: Key[] = [];
    if (Array.isArray(profile.numbers)) {
      for (const n of profile.numbers) {
        if (typeof n !== 'string') continue;
        try { candidates.push({ PK: keys.numberRoutePk(n), SK: keys.routeSk() }); } catch { /* malformed number: skip */ }
      }
    }
    const ref = profile.engineRef;
    const agentId = typeof ref === 'string' ? ref : (ref as { agentId?: string } | undefined)?.agentId;
    if (typeof profile.engine === 'string' && agentId) {
      try { candidates.push({ PK: keys.engineAgentRoutePk(profile.engine, agentId), SK: keys.routeSk() }); } catch { /* skip */ }
    }
    const owned: Key[] = [];
    for (const k of candidates) {
      const r = await this.cfg.ddb.send(new GetCommand({ TableName: this.table, Key: k }));
      if (r.Item && (r.Item.tid === tenantId || r.Item.tenantId === tenantId)) owned.push(k);
    }
    return owned;
  }

  private async deletePrefix(prefix: string): Promise<number> {
    let removed = 0;
    let token: string | undefined;
    do {
      const l = await this.cfg.s3.send(new ListObjectsV2Command({ Bucket: this.cfg.tenantBucket, Prefix: prefix, ContinuationToken: token }));
      const objs = (l.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (objs.length) {
        const d = await this.cfg.s3.send(new DeleteObjectsCommand({ Bucket: this.cfg.tenantBucket, Delete: { Objects: objs, Quiet: true } }));
        if (d.Errors?.length) throw new Error('object delete failed');
        removed += objs.length;
      }
      token = l.IsTruncated ? l.NextContinuationToken : undefined;
    } while (token);
    return removed;
  }

  async deleteTenant(tenantId: string, profile: TenantRecord): Promise<{ items: number; objects: number; routes: number }> {
    const pk = keys.tenantPk(tenantId);
    const routes = await this.ownedRoutes(tenantId, profile);
    await this.batchDelete(routes); // callers and webhooks stop resolving this tenant first
    const all = (await this.tenantItems(tenantId, 'PK, SK')) as unknown as Key[];
    const rest = all.filter((k) => k.PK === pk && k.SK !== keys.profileSk());
    await this.batchDelete(rest.map(({ PK, SK }) => ({ PK, SK })));
    const objects = await this.deletePrefix(`tenants/${tenantId}/`);
    await this.batchDelete([{ PK: pk, SK: keys.profileSk() }]);
    return { items: rest.length + 1, objects, routes: routes.length };
  }
}
