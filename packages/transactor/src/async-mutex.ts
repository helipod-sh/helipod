/**
 * A minimal async mutex (promise-chain lock). Serializes the commit phase so the
 * single-writer invariant holds across `await` points — validate, allocate timestamp, and
 * apply happen atomically with respect to other commits, even though each awaits the store.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const prev = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
