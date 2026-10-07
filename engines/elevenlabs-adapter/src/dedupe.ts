/**
 * Remembers which conversations the webhook has already delivered (SEC-30). The signature window (five minutes) stops
 * a captured request from being replayed later; this stops it being replayed inside the window, and drops the
 * provider's own duplicate deliveries.
 */
export interface EventDedupe {
  /**
   * True the first time `key` is seen within `ttlSec`, false for a repeat. A store shared between Lambda instances
   * (a DynamoDB conditional put with a ttl) must make this atomic; `MemoryEventDedupe` only covers one instance.
   */
  claim(key: string, ttlSec: number): Promise<boolean>;
  /** Forget a key, so a retry is accepted after a failed hand-off. */
  release?(key: string): Promise<void>;
}

/** Per-instance, bounded, expiring. The default: post-call is idempotent on the call id as well, so this is a second line. */
export class MemoryEventDedupe implements EventDedupe {
  private readonly seen = new Map<string, number>();   // key -> expiry (unix seconds); Map keeps insertion order

  constructor(private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000), private readonly maxEntries = 5000) {}

  get size(): number { return this.seen.size; }

  async claim(key: string, ttlSec: number): Promise<boolean> {
    const now = this.nowSec();
    const expiry = this.seen.get(key);
    if (expiry !== undefined && expiry > now) return false;
    this.seen.delete(key);
    this.seen.set(key, now + ttlSec);
    this.trim(now);
    return true;
  }

  async release(key: string): Promise<void> {
    this.seen.delete(key);
  }

  private trim(now: number): void {
    for (const [k, expiry] of this.seen) {
      if (this.seen.size <= this.maxEntries && expiry > now) break;
      this.seen.delete(k);   // oldest first: expired entries, then the oldest live ones if still over the cap
    }
  }
}
