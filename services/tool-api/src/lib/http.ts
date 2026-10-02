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

/** Wrap a handler: map HttpError to JSON, never leak stack traces, always include a caller-safe line on voice paths. */
export function handle(fn: (e: HttpEvent) => Promise<HttpResult>) {
  return async (event: HttpEvent): Promise<HttpResult> => {
    try {
      return await fn(event);
    } catch (err) {
      if (err instanceof HttpError) {
        return json(err.status, { code: err.code, message: err.message, sayToCaller: err.sayToCaller });
      }
      console.error(JSON.stringify({ level: 'error', requestId: event.requestContext?.requestId, err: String(err) }));
      return json(500, {
        code: 'internal', message: 'internal error',
        sayToCaller: "I'm having trouble with that right now. Let me take a message so the team can call you back.",
      });
    }
  };
}
