/** Minimal API Gateway HTTP API (payload v2) types, so the package has no @types/aws-lambda dependency. */
export interface HttpEvent {
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  requestContext: {
    requestId: string;
    authorizer?: { jwt?: { claims: Record<string, string> } };
  };
}
export interface HttpResult { statusCode: number; headers?: Record<string, string>; body: string }

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public sayToCaller?: string) { super(message); }
}

export const json = (statusCode: number, body: unknown): HttpResult => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

export function parseBody<T>(event: HttpEvent): T {
  if (!event.body) return {} as T;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try { return JSON.parse(raw) as T; } catch { throw new HttpError(400, 'bad_json', 'body is not valid JSON'); }
}

export function header(event: HttpEvent, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** What a guard learns once the request is over. `code` is the error code when the request failed. */
export interface GuardOutcome { status: number; code?: string }

export type GuardDecision =
  | { allow: true; /** Called once the handler has answered. A failure here never changes the response. */ settled?: (outcome: GuardOutcome) => Promise<void> }
  | { allow: false; response: HttpResult };

/** Runs before every handler. The rate limiter (lib/rate-limit.ts) is one; handle() knows nothing about what it checks. */
export interface RequestGuard { check(event: HttpEvent): Promise<GuardDecision> }

export interface HandleOptions {
  /** Use this guard instead of the process-wide one; `false` turns guarding off for this handler. */
  guard?: RequestGuard | false;
}

let installed: RequestGuard | false | undefined;
let lazyDefault: Promise<RequestGuard | undefined> | undefined;

/** Install the process-wide guard (tests, local servers). `undefined` goes back to the default described in guardFor. */
export function setRequestGuard(guard: RequestGuard | false | undefined): void {
  installed = guard;
  lazyDefault = undefined;
}

/**
 * Which guard applies: the handler's own option, then an installed one, then the production rate limiter, which switches
 * itself on when the Lambda has the tenant data role (see prodRequestGuard). Loaded lazily so a handler that never gets a
 * request never pays for it, and so http.ts has no static dependency on the module that depends on it.
 */
async function guardFor(opts: HandleOptions): Promise<RequestGuard | undefined> {
  if (opts.guard !== undefined) return opts.guard || undefined;
  if (installed !== undefined) return installed || undefined;
  lazyDefault ??= import('./rate-limit.js').then((m) => m.defaultRequestGuard()).catch((err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'rate limiter failed to load, requests are not limited', err: String(err) }));
    return undefined;
  });
  return lazyDefault;
}

/** The error code of a handler that answered with a 4xx instead of throwing an HttpError. */
function codeOf(result: HttpResult): string | undefined {
  if (result.statusCode < 400 || result.statusCode >= 500 || result.body.length > 4096) return undefined;
  try {
    const code = (JSON.parse(result.body) as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
  } catch { return undefined; }
}

/**
 * Wrap a handler: guard first (rate limits; a 429 means the handler never runs), then the handler. HttpError becomes JSON,
 * stack traces never leak, and voice paths always get a caller-safe line. A guard that breaks lets the request through:
 * abuse protection must not be the thing that takes calls down.
 */
export function handle(fn: (e: HttpEvent) => Promise<HttpResult>, opts: HandleOptions = {}) {
  return async (event: HttpEvent): Promise<HttpResult> => {
    const guard = await guardFor(opts);
    let decision: GuardDecision | undefined;
    if (guard) {
      try {
        decision = await guard.check(event);
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', requestId: event.requestContext?.requestId, msg: 'request guard failed, letting the request through', err: String(err) }));
      }
      if (decision && !decision.allow) return decision.response;
    }

    let result: HttpResult;
    let code: string | undefined;
    try {
      result = await fn(event);
      code = codeOf(result);
    } catch (err) {
      if (err instanceof HttpError) {
        code = err.code;
        result = json(err.status, { code: err.code, message: err.message, sayToCaller: err.sayToCaller });
      } else {
        console.error(JSON.stringify({ level: 'error', requestId: event.requestContext?.requestId, err: String(err) }));
        code = 'internal';
        result = json(500, {
          code: 'internal', message: 'internal error',
          sayToCaller: "I'm having trouble with that right now. Let me take a message so the team can call you back.",
        });
      }
    }

    if (decision?.allow && decision.settled) {
      try {
        await decision.settled({ status: result.statusCode, ...(code ? { code } : {}) });
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', requestId: event.requestContext?.requestId, msg: 'request guard could not record the outcome', err: String(err) }));
      }
    }
    return result;
  };
}
