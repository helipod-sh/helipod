/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `ReplicaTailer` (Fleet slice 2, Task 2) — tails the Postgres primary's MVCC log VERBATIM onto a
 * local embedded replica `DocStore` (an in-process SQLite instance, in the intended deployment),
 * deriving invalidation ranges straight from the SAME batch it just applied — not a separate
 * query — so a follower's reactive fan-out is provably consistent with what actually landed on the
 * replica.
 *
 * Evolves `CommitTailer` (`commit-notifier.ts`, slice 1)'s LISTEN + poll wake posture, the
 * `draining` re-entrancy guard, and watermark-advances-only-after-`onInvalidation`-resolves
 * semantics — but diverges in two structural ways `CommitTailer` never needed:
 *
 *   1. VERBATIM APPLY — `CommitTailer` only ever derived ranges to wake a LIVE in-process runtime;
 *      it never touched a second store. This class additionally re-materializes the primary's
 *      actual `DocumentLogEntry`/`IndexWrite` rows onto a real replica `DocStore` via `write(...,
 *      "Overwrite")`, so the replica is a byte-for-byte MVCC mirror (historical reads included),
 *      not just a wake signal.
 *   2. BOOTSTRAP CATCH-UP — a fresh replica starts at watermark 0 (or wherever it last left off),
 *      which can be arbitrarily far behind the primary. `start()` doesn't resolve until the
 *      replica has caught up to the primary's `maxTimestamp()` AT CALL TIME (the ready gate),
 *      batching the catch-up in `batchSize`-sized ticks instead of one unbounded pull.
 *
 * `CommitTailer` was the slice-1 derive-only precursor; slice 2 (Task 4) deleted it once this class
 * subsumed its wake/derive posture with verbatim replica apply. `AppliedInvalidation` below carries
 * the invalidation shape (identical members to what `CommitTailer.DerivedInvalidation` had).
 *
 * Per-tick pipeline (see the class body for the full step-by-step):
 *   1. `newMax = await primary.maxTimestamp()`; no-op if `<= watermark`.
 *   2. Pull `DocumentLogEntry` rows for `(watermark, newMax]` via `primary.load_documents`,
 *      capped at `batchSize` — but never splitting a single commit's ts group across ticks (a
 *      transaction shares exactly one commit `ts` across all its writes, see
 *      `postgres-docstore.ts`'s `write()` doc comment; if the batch fills mid-way through a ts
 *      group, the remaining same-ts rows are drained too before capping, so a partial
 *      transaction's writes are never applied on the replica).
 *   3. Pull the matching `indexes` rows for the SAME `(watermark, cappedMax]` via raw SQL and
 *      invert `postgres-docstore.ts`'s `write()` serialization exactly: `deleted=true` → the
 *      `Deleted` variant, else `NonClustered` carrying the decoded `docId`.
 *   4. `replica.write(docs, indexWrites, "Overwrite")` — verbatim, idempotent re-apply.
 *   5. Build `AppliedInvalidation` from the SAME in-memory batch (index-derived writtenTables/
 *      writtenKeys, DISTINCT-by-(tableId,internalId) writtenDocs from the doc entries).
 *   6. `await onInvalidation(inv)`, THEN advance the watermark, THEN resolve any satisfied
 *      `waitFor()`s — a throwing/slow handler must not cause a range to be silently skipped.
 */
import type { PostgresDocStore } from "@stackbase/docstore-postgres";
import type { DatabaseIndexValue, DocStore, DocumentLogEntry, IndexWrite } from "@stackbase/docstore";
import { decodeStorageTableId, encodeStorageTableId } from "@stackbase/id-codec";
import type { CommitChannelClient } from "./commit-notifier";

const COMMIT_CHANNEL = "stackbase_commits";
const DEFAULT_POLL_MS = 1000;
const DEFAULT_BATCH_SIZE = 1000;

/** Mirrors slice 1's `DerivedInvalidation` shape byte-for-byte (see the module doc comment for why
 *  this is a deliberate parallel type, not an import). `newMaxTs` is the tick's APPLIED ceiling,
 *  which may be less than the primary's live `maxTimestamp()` when a batch was capped. */
export interface AppliedInvalidation {
  newMaxTs: bigint;
  /** DISTINCT `table_id` values touched, as strings (the storage-encoded table id). */
  writtenTables: string[];
  /** Raw written index keys — point invalidation input, NOT yet point ranges. */
  writtenKeys: Array<{ indexId: string; key: Uint8Array }>;
  /** DISTINCT `(table_id, internal_id)` pairs written in this batch, deduped from the applied
   *  `DocumentLogEntry` rows themselves (one entry per doc regardless of how many revisions or
   *  index rows accompanied it in this batch). Point invalidation input for the DOCUMENT
   *  keyspace, NOT yet point ranges — same split as `writtenKeys` above. */
  writtenDocs: Array<{ tableId: string; internalId: Uint8Array }>;
}

export interface ReplicaTailerOptions {
  /** Wall-clock poll fallback interval, in ms. Default 1000. */
  pollMs?: number;
  /** Max `DocumentLogEntry` rows pulled per tick (bootstrap catch-up + steady state). Default
   *  1000. A tick may apply slightly more than this to avoid splitting a commit's ts group. */
  batchSize?: number;
  /** Invoked once per non-empty applied batch, in watermark order, AFTER the batch has already
   *  been written to the replica. The watermark only advances after this resolves. */
  onInvalidation: (inv: AppliedInvalidation) => Promise<void>;
}

type WaitOutcome = "reached" | "timeout" | "released";

interface Waiter {
  ts: bigint;
  settle: (outcome: WaitOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Verbatim log-apply tailer: primary Postgres MVCC log -> local replica `DocStore`, plus the
 *  batch-derived invalidation feed and the `waitFor` read-your-own-writes primitive Task 3 needs. */
export class ReplicaTailer {
  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly onInvalidation: (inv: AppliedInvalidation) => Promise<void>;
  private wm = 0n;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unlisten: (() => Promise<void>) | undefined;
  private stopped = true;
  /** Reentrancy guard: a NOTIFY wake and a poll tick can land back-to-back — only one
   *  pull-apply-invalidate walk runs at a time, so `onInvalidation` never sees overlapping ranges,
   *  and the bootstrap loop in `start()` never races a concurrent LISTEN-triggered tick. */
  private draining = false;
  private readonly waiters = new Set<Waiter>();

  constructor(
    private readonly client: CommitChannelClient,
    private readonly primary: PostgresDocStore,
    private readonly replica: DocStore,
    opts: ReplicaTailerOptions,
  ) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.onInvalidation = opts.onInvalidation;
  }

  watermark(): bigint {
    return this.wm;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Seed from the REPLICA's own high-water mark (0 for a fresh replica, or wherever a
    // previous run left off) — this is what makes catch-up resumable across restarts.
    this.wm = await this.replica.maxTimestamp();
    const target = await this.primary.maxTimestamp();

    // Bootstrap catch-up: repeat batch-capped ticks until the replica has caught up to the
    // primary's max AT CALL TIME (the ready gate). Writes that land after this point are the
    // LISTEN+poll loop's job below, same as CommitTailer.
    while (!this.stopped && this.wm < target) {
      await this.tick();
    }

    try {
      this.unlisten = await this.client.listen(COMMIT_CHANNEL, () => {
        void this.tick();
      });
    } catch {
      // LISTEN unsupported (e.g. a test double, or a transient connection issue) — the poll
      // loop below is the correctness path regardless, so this is not fatal to start().
      this.unlisten = undefined;
    }

    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.unlisten !== undefined) {
      const unlisten = this.unlisten;
      this.unlisten = undefined;
      await unlisten();
    }
  }

  /** Resolves when `watermark() >= ts` (immediately if already true), or when `release()` fires.
   *  Task 3's read-your-own-writes primitive: a client that just committed at `ts` can wait for
   *  a follower's replica to have caught up before serving that client's next read from it. */
  waitFor(ts: bigint, timeoutMs: number): Promise<WaitOutcome> {
    if (this.wm >= ts) return Promise.resolve("reached");
    return new Promise<WaitOutcome>((resolve) => {
      const waiter: Waiter = {
        ts,
        settle: (outcome) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          resolve(outcome);
        },
        timer: setTimeout(() => waiter.settle("timeout"), timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  /** Releases ALL pending `waitFor()`s with `"released"` (e.g. this node was just promoted to
   *  writer, or is shutting down, and callers should stop waiting on replica catch-up). */
  release(): void {
    for (const w of [...this.waiters]) w.settle("released");
  }

  private wakeSatisfiedWaiters(): void {
    for (const w of [...this.waiters]) {
      if (this.wm >= w.ts) w.settle("reached");
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      const newMax = await this.primary.maxTimestamp();
      if (newMax <= this.wm) return; // spurious wake — nothing new since last apply

      const { docs, cappedAt } = await this.pullDocs(this.wm, newMax);
      const appliedMax = cappedAt ?? newMax;

      const indexRows = await this.client.query(
        `SELECT index_id, key, ts, table_id, internal_id, deleted FROM indexes WHERE ts > $1 AND ts <= $2 ORDER BY ts ASC`,
        [this.wm, appliedMax],
      );

      if (docs.length === 0 && indexRows.length === 0) return; // nothing in range — watermark stays put

      // Invert postgres-docstore.ts's write() serialization exactly: `deleted` -> the Deleted
      // variant (table_id/internal_id are NULL on those rows and must not be read), else
      // NonClustered carrying the decoded docId.
      const indexWrites: IndexWrite[] = indexRows.map((r) => {
        const deleted = r.deleted as boolean;
        const value: DatabaseIndexValue = deleted
          ? { type: "Deleted" }
          : {
              type: "NonClustered",
              docId: {
                tableNumber: decodeStorageTableId(r.table_id as string),
                internalId: r.internal_id as Uint8Array,
              },
            };
        return {
          ts: r.ts as bigint,
          update: { indexId: r.index_id as string, key: r.key as Uint8Array, value },
        };
      });

      // Verbatim apply — exactly what load_documents yielded, plus the reconstructed index
      // writes, under "Overwrite" so a second application of the same range is a safe no-op.
      await this.replica.write(docs, indexWrites, "Overwrite");

      const tableIds = new Set<string>();
      for (const r of indexRows) if (r.table_id !== null) tableIds.add(String(r.table_id));
      const writtenTables = [...tableIds];
      const writtenKeys = indexRows.map((r) => ({ indexId: String(r.index_id), key: r.key as Uint8Array }));

      const seenDocs = new Set<string>();
      const writtenDocs: Array<{ tableId: string; internalId: Uint8Array }> = [];
      for (const d of docs) {
        const tableId = encodeStorageTableId(d.id.tableNumber);
        const dedupeKey = `${tableId}|${Buffer.from(d.id.internalId).toString("hex")}`;
        if (seenDocs.has(dedupeKey)) continue;
        seenDocs.add(dedupeKey);
        writtenDocs.push({ tableId, internalId: d.id.internalId });
      }

      await this.onInvalidation({ newMaxTs: appliedMax, writtenTables, writtenKeys, writtenDocs });
      // Advance ONLY after onInvalidation resolves — a throwing/slow handler must not cause this
      // range to be silently skipped on the next tick.
      this.wm = appliedMax;
      this.wakeSatisfiedWaiters();
    } finally {
      this.draining = false;
    }
  }

  /**
   * Pull `DocumentLogEntry` rows for `(after, upTo]` from `load_documents`, capped at
   * `this.batchSize` — but if the cap lands mid-way through a group of rows sharing the same
   * commit `ts`, keep draining until that ts group is fully collected before stopping. A single
   * transaction shares exactly one commit `ts` across every document it wrote (see
   * `postgres-docstore.ts`'s `write()`), so cutting a batch mid-group would apply a transaction's
   * writes partially, which `load_documents`'s `(after, cap]`-shaped next-tick range would then
   * never revisit (the excluded rows share `ts === cap`, which the next tick's range excludes as
   * its own lower bound).
   *
   * `TimestampRange` is `{minInclusive, maxExclusive}` (see `packages/docstore/src/types.ts`) —
   * the half-open opposite skew from the `(after, upTo]` shape this tailer needs, so the bounds
   * are translated with a `+1n` offset on both sides (safe: `ts` is a monotonic integer log
   * position, never a real number needing density guarantees).
   */
  private async pullDocs(
    after: bigint,
    upTo: bigint,
  ): Promise<{ docs: DocumentLogEntry[]; cappedAt: bigint | null }> {
    const docs: DocumentLogEntry[] = [];
    let cappedAt: bigint | null = null;
    const gen = this.primary.load_documents({ minInclusive: after + 1n, maxExclusive: upTo + 1n }, "asc");
    for await (const entry of gen) {
      if (cappedAt !== null && entry.ts !== cappedAt) break; // ts group complete — stop here
      docs.push(entry);
      if (cappedAt === null && docs.length >= this.batchSize) cappedAt = entry.ts;
    }
    return { docs, cappedAt };
  }
}
