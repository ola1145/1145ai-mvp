import type { ConsoleEvent, ConsoleResponse } from './types.js';

const BASE_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export function respond(statusCode: number, body: unknown, extra: Record<string, string> = {}): ConsoleResponse {
  return { statusCode, headers: { ...BASE_HEADERS, ...extra }, body: JSON.stringify(body) };
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(code);
  }
}

export function errorResponse(e: HttpError): ConsoleResponse {
  return respond(e.status, { error: e.code, ...e.extra });
}

/** The caller's IAM ARN, as set by API Gateway after SigV4 verification. Nothing in the body or headers counts. */
export function actorOf(event: ConsoleEvent): string {
  const arn = event.requestContext.authorizer?.iam?.userArn;
  if (!arn) throw new HttpError(401, 'unauthenticated');
  return arn;
}

export function parseBody(event: ConsoleEvent): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > 16_384) throw new HttpError(413, 'body_too_large');
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

export function intParam(v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'invalid_limit', { min, max });
  return n;
}
