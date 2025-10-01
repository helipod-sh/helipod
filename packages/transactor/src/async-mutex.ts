/**
 * A minimal async mutex (promise-chain lock). Serializes the commit phase so the
 * single-writer invariant holds across `await` points — validate, allocate timestamp, and
 * apply happen atomically with respect to other commits, even though each awaits the store.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  /** Count of holders currently in line (running OR queued). Incremented SYNCHRONOUSLY on entry —
   *  before the first `await` — and decremented on release, so `isLocked` is authoritative for a
   *  non-blocking `tryRunExclusive` even against a caller whose turn hasn't started yet. */
  private waiters = 0;

  /** True iff someone holds the mutex or is queued for it. Reflects a synchronously-updated counter,
   *  so a `tryRunExclusive` decision made in the same tick as a `runExclusive` call is never wrong. */
  get isLocked(): boolean {
    return this.waiters > 0;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.waiters++;
    let release: () => void = () => {};
    const prev = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      this.waiters--;
      release();
    }
  }

  /**
   * Non-blocking acquire: if the mutex is free RIGHT NOW, take it, run `fn` under it, and return
   * `true`; if it is held or queued (a commit is in flight), return `false` immediately WITHOUT
   * waiting. The `isLocked` check and the `runExclusive` entry are one synchronous step (no `await`
   * between them, and `runExclusive` reserves its slot synchronously before its first `await`), so a
   * commit racing in right after our check serializes behind us rather than interleaving.
   */
  async tryRunExclusive<T>(fn: () => Promise<T>): Promise<boolean> {
    if (this.isLocked) return false;
    await this.runExclusive(fn);
    return true;
  }
}
