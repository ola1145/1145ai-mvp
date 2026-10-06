import type { EngineAgentRef, EventEnvelope, TenantRuntimeState, VoiceEngine } from '@1145/shared';

/** The slice of an API Gateway HTTP API (payload 2.0) event the console reads. */
export interface ConsoleEvent {
  rawPath: string;
  rawQueryString?: string;
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: {
    requestId?: string;
    http: { method: string; path?: string };
    /** Present when the route uses the IAM authorizer; this is the only place the actor comes from. */
    authorizer?: { iam?: { userArn?: string; accountId?: string; callerId?: string } };
  };
}

export interface ConsoleResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type TenantRecord = Record<string, unknown>;

export interface Page<T> { items: T[]; nextCursor?: string }

export interface UsageRecord { month: string; billableSeconds: number }

export interface TemplateVersion { template: string; version: string; status?: string; canaryPercent?: number }

export interface ConversationRecord {
  conversationId: string;
  startedAt: string;
  channel?: string;
  sentiment?: string;
  hasTranscript: boolean;
}

export interface AuditEntry {
  tenantId: string;
  action: string;
  reasonCode: string;
  actor: string;
  at: string;
  requestId?: string;
  supportCaseId?: string;
  note?: string;
  detail?: Record<string, unknown>;
}

/** Persistence for the console. Every method is scoped by a tenant id that already passed `asTenantId`. */
export interface ConsoleStore {
  listTenants(q: { limit: number; cursor?: string }): Promise<Page<TenantRecord>>;
  getProfile(tenantId: string): Promise<TenantRecord | undefined>;
  listUsage(tenantId: string, limit: number): Promise<UsageRecord[]>;
  listTemplateVersions(template: string): Promise<TemplateVersion[]>;
  writeState(tenantId: string, state: TenantRuntimeState, meta: { reasonCode: string; actor: string; at: string }): Promise<void>;
  setTemplatePin(
    tenantId: string,
    pin: { template: string; version: string } | null,
    meta: { reasonCode: string; actor: string; at: string },
  ): Promise<void>;
  listConversations(tenantId: string, q: { limit: number; cursor?: string }): Promise<Page<ConversationRecord>>;
  /** Returns the object key of the transcript, if the conversation exists in THIS tenant's partition. */
  getTranscriptKey(tenantId: string, startedAt: string, conversationId: string): Promise<{ key?: string } | undefined>;
  readObject(key: string): Promise<string | undefined>;
  /** Writes tenants/<tid>/exports/<exportId>.json. Idempotency items are left out. */
  exportTenant(tenantId: string, exportId: string): Promise<{ key: string; itemCount: number }>;
  /** Removes the tenant partition, its S3 prefix and its route items. The profile goes last so a retry can resume. */
  deleteTenant(tenantId: string, profile: TenantRecord): Promise<{ items: number; objects: number; routes: number }>;
}

export interface ConsoleDeps {
  store: ConsoleStore;
  /** Must throw if the entry did not land. Writes that cannot be audited do not happen. */
  audit(entry: AuditEntry): Promise<void>;
  emit(event: EventEnvelope): Promise<void>;
  engineFor(ref: EngineAgentRef): VoiceEngine;
  now(): Date;
  newId(): string;
}
