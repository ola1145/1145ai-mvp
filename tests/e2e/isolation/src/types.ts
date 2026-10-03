/** Ports the probes talk through. Real adapters hit dev AWS; the self-test plugs in in-memory fakes. */

export interface HttpRequest {
  method: string;
  /** Path with any path params already filled in, e.g. /v1/tools/bookings/bk_1/cancel. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  /** Bearer token, or null for an unauthenticated request. */
  token: string | null;
}
export interface HttpResponse { status: number; body: string }
export type HttpPort = (req: HttpRequest) => Promise<HttpResponse>;

export type DdbOp = 'Query' | 'GetItem' | 'Scan' | 'PutItem' | 'BatchGetItem';
export type DdbResult = { ok: true; data: unknown } | { ok: false; errorType: string; message: string };
export interface DdbSession { call(op: DdbOp, input: Record<string, unknown>): Promise<DdbResult> }
export interface DataPlanePort {
  /** sts:AssumeRole on the tenant data role with the given session tags (e.g. { tenant_id }). */
  assumeRole(tags: Record<string, string>): Promise<DdbSession>;
}

export type RealtimeResult = { ok: true } | { ok: false; error: string };
export interface RealtimePort {
  subscribe(jwt: string, channel: string): Promise<RealtimeResult>;
  /** ok only if the service accepted at least one event. */
  publish(jwt: string, channel: string, event: unknown): Promise<RealtimeResult>;
}
