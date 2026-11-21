export type Grant = { lease: string } | { retryAfterMs: number; reason: 'busy' | 'paused' };

// Node timers are signed 32-bit; longer pauses re-arm instead of overflowing to about 1 ms.
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * At most `limit` leases out at once; callers wait up to `waitMs` in FIFO order, then get `busy`.
 * Leases expire after `leaseMs` so a caller that died without releasing cannot hold a slot forever.
 */
export class Semaphore {
  readonly limit: number;
  readonly leaseMs: number;
  readonly now: () => number;
  private readonly active = new Map<string, number>();
  private readonly waiting: { grant: (lease: string) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private pausedUntil = 0;
  private pauseWakeAt = 0;
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;
  private next = 0;
  peak = 0;

  constructor(limit: number, leaseMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.leaseMs = leaseMs;
    this.now = now;
  }

  get inFlight(): number {
    this.expire();
    return this.active.size;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /** Milliseconds left on a backend pause, 0 when not paused. */
  pausedFor(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  /** Pauses new grants for `ms` (Retry-After); only ever extends a pause. */
  pause(ms: number): void {
    const duration = Math.max(0, ms);
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + duration);
    this.pauseWakeAt = Math.max(this.pauseWakeAt, Date.now() + duration);
    this.schedulePauseWake();
  }

  // setTimeout can fire just before Date.now() reaches the deadline, so re-arm until the wake time has passed.
  private schedulePauseWake(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    const timer = setTimeout(
      () => {
        this.pauseTimer = undefined;
        if (Date.now() < this.pauseWakeAt) {
          this.schedulePauseWake();
          return;
        }
        this.drain();
      },
      Math.min(Math.max(0, this.pauseWakeAt - Date.now()), MAX_TIMEOUT_MS),
    );
    this.pauseTimer = timer;
    if (!this.waiting.length) (timer as unknown as { unref?: () => void }).unref?.();
  }

  acquire(waitMs: number): Promise<Grant> {
    const paused = this.pausedFor();
    if (paused > 0) return Promise.resolve({ retryAfterMs: paused, reason: 'paused' });
    this.expire();
    this.drain();
    if (this.active.size < this.limit && !this.waiting.length) return Promise.resolve({ lease: this.take() });
    return new Promise((resolve) => {
      const entry = {
        grant: (lease: string) => resolve({ lease }),
        timer: setTimeout(() => {
          const at = this.waiting.indexOf(entry);
          if (at >= 0) this.waiting.splice(at, 1);
          resolve({ retryAfterMs: 2_000, reason: 'busy' });
        }, waitMs),
      };
      this.waiting.push(entry);
    });
  }

  release(lease: string): void {
    if (this.active.delete(lease)) this.drain();
  }

  private take(): string {
    const lease = `${this.now().toString(36)}-${(this.next++).toString(36)}`;
    this.active.set(lease, this.now() + this.leaseMs);
    this.peak = Math.max(this.peak, this.active.size);
    return lease;
  }

  private expire(): void {
    const now = this.now();
    let freed = false;
    for (const [lease, until] of this.active)
      if (until <= now) {
        this.active.delete(lease);
        freed = true;
      }
    if (freed) this.drain();
  }

  private drain(): void {
    while (this.waiting.length && this.active.size < this.limit && this.pausedFor() === 0) {
      const entry = this.waiting.shift()!;
      clearTimeout(entry.timer);
      entry.grant(this.take());
    }
  }
}
