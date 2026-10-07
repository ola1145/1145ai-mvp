export type DialOutFailure = 'invalid_input' | 'number_not_routed' | 'dispatch_failed' | 'dial_failed';

/** `dialOut` could not place the call. `reason` says why; `sipStatusCode` is set when the carrier answered (486 busy, 480 no answer...). */
export class DialOutError extends Error {
  constructor(readonly reason: DialOutFailure, message: string, readonly sipStatusCode?: number) {
    super(message);
    this.name = 'DialOutError';
  }
}

/** The worker event is not from our worker (missing or bad service token, wrong principal, wrong tenant or call). Answer 401. */
export class WorkerEventAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkerEventAuthError'; }
}

/** Authenticated, but the event body is not something the worker should ever send. Answer 400. */
export class WorkerEventError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkerEventError'; }
}

/** A correctly authenticated event of a type we do not map (including LiveKit's own webhooks). Acknowledge and drop. */
export class UnsupportedEventError extends Error {
  constructor(readonly eventType: string) { super(`unsupported livekit event type: ${eventType}`); this.name = 'UnsupportedEventError'; }
}

/** Some of the tenant's number routes could not be updated. `failed` holds masked numbers. Do not record the new state as applied. */
export class RouteStateError extends Error {
  constructor(readonly failed: string[], readonly total: number) {
    super(`route state not updated for ${failed.length} of ${total} number(s)`);
    this.name = 'RouteStateError';
  }
}
