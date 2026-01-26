/** A per-key async mutex: serializes async operations against the SAME key so a
 *  read-etag→compare→write CAS sequence can never interleave with another op on that key.
 *  Operations against DIFFERENT keys run fully concurrently (no global lock).
 *
 *  Implemented as a promise chain per key ("tail chaining"): each `run` call appends its
 *  work behind whatever is already queued for that key, regardless of whether the prior
 *  op succeeded or failed, then advances the tail. The tail is cleared once drained so the
 *  map doesn't grow unboundedly for keys that are no longer contended. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // Run `fn` only after the previous op for this key has settled (success or failure —
    // a failed prior op must not deadlock or skip the queue for later callers).
    const result = prev.then(fn, fn);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    try {
      return await result;
    } finally {
      // Drop the tail entry if nothing new queued behind us while we ran.
      if (this.tails.get(key) === settled) this.tails.delete(key);
    }
  }
}
