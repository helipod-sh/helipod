/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * A generic k-way merge over N already-sorted `AsyncGenerator`s, used by
 * `ShardedObjectStoreDocStore` to merge each lane's own `index_scan`/`load_documents` stream into
 * ONE globally-ordered stream without ever buffering a whole lane into memory.
 *
 * Each source generator MUST already yield in the SAME order this merge is told to produce (the
 * caller — `ShardedObjectStoreDocStore` — gets this for free: it calls every lane's `index_scan`/
 * `load_documents` with the identical `order` argument, and each lane's own store already honors
 * that ordering, exactly as `SqliteDocStore.index_scan`'s SQL `ORDER BY i.key ASC|DESC` does). This
 * function does not itself sort anything — it only ever compares the CURRENT head of each source.
 */

/** Byte-lexicographic comparison — matches SQLite's own BLOB ordering (unsigned byte-wise), which
 *  `SqliteDocStore.index_scan`'s `ORDER BY i.key` already relies on, so merging N lanes' index-scan
 *  streams by this comparator reproduces the SAME total order a single, unsharded store would. */
export function compareBytesLex(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/** bigint comparison — for merging `load_documents`' `ts`-ordered streams. */
export function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Merge `sources` (each already sorted per `keyCompare`/`order`) into one sorted `AsyncGenerator`,
 * stopping after `limit` yielded items (or exhausting every source when `limit` is undefined).
 *
 * Algorithm: prime every source's first item, then repeatedly pick the source whose current head
 * compares smallest (`order: "asc"`) or largest (`order: "desc"`) per `keyCompare`, yield it, and
 * advance ONLY that source. This is the textbook k-way merge — O(log k) per step with a heap, but a
 * linear scan over k sources here (k = shard count, expected small — tens at most) is simpler and
 * fast enough; a heap can replace the linear scan later if shard counts ever grow large.
 *
 * `limit`, when set, is a HARD cap on the number of items this generator yields — matching every
 * `DocStore.index_scan`/`load_documents` implementation's own `limit` contract. Passing the SAME
 * `limit` down to each individual source (as `ShardedObjectStoreDocStore` does) is always a safe
 * over-fetch: the merged output can never need MORE than `limit` items from any single source, since
 * the whole merged output is capped at `limit`.
 *
 * On early exit (limit reached, or the caller stops iterating this generator before exhaustion — a
 * `for await` `break`), every NOT-YET-EXHAUSTED source generator is `.return()`'d so it can release
 * whatever resources it's holding (mirroring how a single-store `AsyncGenerator` is expected to clean
 * up on an early `.return()` call — the same contract, just fanned out over N sources).
 */
export async function* mergeSortedAsyncGenerators<T>(
  sources: readonly AsyncGenerator<T>[],
  keyCompare: (a: T, b: T) => number,
  order: "asc" | "desc",
  limit?: number,
): AsyncGenerator<T> {
  interface Cursor {
    gen: AsyncGenerator<T>;
    current: T | undefined;
    done: boolean;
  }
  const cursors: Cursor[] = sources.map((gen) => ({ gen, current: undefined, done: false }));

  async function advance(c: Cursor): Promise<void> {
    const r = await c.gen.next();
    if (r.done) {
      c.done = true;
      c.current = undefined;
    } else {
      c.current = r.value;
    }
  }

  try {
    await Promise.all(cursors.map((c) => advance(c)));

    let yielded = 0;
    for (;;) {
      if (limit !== undefined && yielded >= limit) return;

      let bestIdx = -1;
      for (let i = 0; i < cursors.length; i++) {
        const c = cursors[i]!;
        if (c.done) continue;
        if (bestIdx === -1) {
          bestIdx = i;
          continue;
        }
        const cmp = keyCompare(c.current as T, cursors[bestIdx]!.current as T);
        if (order === "asc" ? cmp < 0 : cmp > 0) bestIdx = i;
      }
      if (bestIdx === -1) return; // every source exhausted

      const winner = cursors[bestIdx]!;
      yield winner.current as T;
      yielded++;
      await advance(winner);
    }
  } finally {
    // Release any source generator this merge never fully drained (limit hit, or the consumer broke
    // out of a `for await` early) — best-effort, never let a cleanup failure mask the real outcome.
    await Promise.all(
      cursors
        .filter((c) => !c.done)
        .map(async (c) => {
          try {
            await c.gen.return(undefined);
          } catch {
            /* best-effort cleanup only */
          }
        }),
    );
  }
}
