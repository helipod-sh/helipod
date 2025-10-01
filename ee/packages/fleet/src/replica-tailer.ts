/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `ReplicaTailer` (Fleet slice 2, Task 2; Fenced Frontier B1, D5/D6) — tails the Postgres
 * primary's MVCC log VERBATIM onto a local embedded replica `DocStore` (an in-process SQLite
 * instance, in the intended deployment), deriving invalidation ranges straight from the SAME
 * batch it just applied — not a separate query — so a follower's reactive fan-out is provably
 * consistent with what actually landed on the replica.
 *
 * Evolves `CommitTailer` (`commit-notifier.ts`, slice 1)'s LISTEN + poll wake posture, the
 * `draining` re-entrancy guard, and watermark-advances-only-after-`onInvalidation`-resolves
 * semantics — but diverges in structural ways `CommitTailer` never needed:
 *
 *   1. VERBATIM APPLY — `CommitTailer` only ever derived ranges to wake a LIVE in-process runtime;
 *      it never touched a second store. This class additionally re-materializes the primary's
 *      actual `DocumentLogEntry`/`IndexWrite` rows onto a real replica `DocStore` via `write(...,
 *      "Overwrite")`, so the replica is a byte-for-byte MVCC mirror (historical reads included),
 *      not just a wake signal.
 *   2. BOOTSTRAP CATCH-UP — a fresh replica starts at watermark 0 (or wherever it last left off),
 *      which can be arbitrarily far behind the primary. `start()` doesn't resolve until the
 *      replica has caught up to the FENCED FRONTIER `F` AT CALL TIME (the ready gate), batching
 *      the catch-up in `batchSize`-sized ticks instead of one unbounded pull.
 *   3. FENCED-FRONTIER TARGETING (D5) — the pull target is no longer `primary.maxTimestamp()` (the
 *      log's live high-water mark, which can include a commit that raced past the last fence
 *      check under contention) but `F = shard_leases.frontier_ts` — the durably-fenced, dense
 *      prefix the epoch-fenced commit guard (`node.ts`'s `installCommitGuard`) advances inside
 *      every commit transaction. At one shard F advances exactly with commits, so this is
 *      behavior-identical to the old target in the steady state; the difference only matters
 *      under a wedged-writer fencing race (B1 D3/D4), where `maxTimestamp()` could momentarily
 *      run ahead of what's actually safe to consider durable. See `stable-prefix.ts` for the
 *      `StablePrefixTs` brand this introduces.
 *   4. DENSITY ASSERTIONS (D5) — defense-in-depth: the construction (D1 store-allocated ts + D3
 *      epoch-fenced commits) is what actually PREVENTS a skipped commit from ever landing on a
 *      replica, but the apply loop additionally verifies it, per document entry, before applying:
 *      the replica's current head for that doc must chain from `prev_ts` exactly (or be absent,
 *      for an insert). A violation throws `DensityViolationError` — crash loudly rather than serve
 *      silently corrupted state; the operator remedy is the already-shipped delete-and-re-bootstrap
 *      (a replica file is a rebuildable mirror).
 *
 * `CommitTailer` was the slice-1 derive-only precursor; slice 2 (Task 4) deleted it once this class
 * subsumed its wake/derive posture with verbatim replica apply. `AppliedInvalidation` below carries
 * the invalidation shape (identical members to what `CommitTailer.DerivedInvalidation` had).
 *
 * Per-tick pipeline (see the class body for the full step-by-step):
 *   1. `F = await readFrontier()` (D5: `shard_leases.frontier_ts`, branded `StablePrefixTs`); no-op
 *      if `<= watermark`. F is asserted non-decreasing across reads (D5's other defense-in-depth
 *      invariant) — a regression means `shard_leases` itself was corrupted/hand-tampered.
 *   2. Pull `DocumentLogEntry` rows for `(watermark, F]` via `primary.load_documents`, capped at
 *      `batchSize` — but never splitting a single commit's ts group across ticks (a transaction
 *      shares exactly one commit `ts` across all its writes, see `postgres-docstore.ts`'s
 *      `write()` doc comment; if the batch fills mid-way through a ts group, the remaining
 *      same-ts rows are drained too before capping, so a partial transaction's writes are never
 *      applied on the replica).
 *   3. Pull the matching `indexes` rows for the SAME `(watermark, cappedMax]` via raw SQL and
 *      invert `postgres-docstore.ts`'s `write()` serialization exactly: `deleted=true` → the
 *      `Deleted` variant, else `NonClustered` carrying the decoded `docId`.
 *   4. Density-assert the batch (D5) against the replica's PRE-apply state, THEN
 *      `replica.write(docs, indexWrites, "Overwrite")` — verbatim, idempotent re-apply.
 *   5. Build `AppliedInvalidation` from the SAME in-memory batch (index-derived writtenTables/
 *      writtenKeys, DISTINCT-by-(tableId,internalId) writtenDocs from the doc entries).
 *   6. `await onInvalidation(inv)`, THEN advance the watermark (branded `StablePrefixTs`), THEN
 *      resolve any satisfied `waitFor()`s — a throwing/slow handler must not cause a range to be
 *      silently skipped.
 */
import type { PostgresDocStore } from "@stackbase/docstore-postgres";
import type {
  DatabaseIndexValue,
  DocStore,
  DocumentLogEntry,
  IndexWrite,
  InternalDocumentId,
} from "@stackbase/docstore";
import { decodeStorageTableId, encodeStorageTableId } from "@stackbase/id-codec";
import type { CommitChannelClient } from "./commit-notifier";
import { stablePrefixFromFrontier, type StablePrefixTs } from "./stable-prefix";

const COMMIT_CHANNEL = "stackbase_commits";
const DEFAULT_POLL_MS = 1000;
const DEFAULT_BATCH_SIZE = 1000;
/** Default shard count (B1 single-shard behavior) when `numShards` is unset — `min(frontier_ts)` over
 *  the one `default` row, `count(*) >= 1`, byte-identical to B1's `WHERE shard_id = 'default'`. */
const DEFAULT_NUM_SHARDS = 1;

/** Stable string key for a document identity — used to dedupe/track per-doc state across a
 *  batch (both the density-assertion running-head cache below and `writtenDocs`'s DISTINCT). */
function docDedupeKey(id: InternalDocumentId): string {
  return `${encodeStorageTableId(id.tableNumber)}|${Buffer.from(id.internalId).toString("hex")}`;
}

/** Human-readable doc label shared by `DensityViolationError`'s message. */
function docLabel(id: InternalDocumentId): string {
  return `table=${encodeStorageTableId(id.tableNumber)} internalId=${Buffer.from(id.internalId).toString("hex")}`;
}

/** Normalizes a `shard_leases.frontier_ts` (BIGINT) read-back to `bigint` — normally already a
 *  `bigint` (both `NodePgClient` and the PGlite test client normalize int8 columns), but coerced
 *  defensively rather than trusting a specific driver's normalization here. */
function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" || typeof v === "string") return BigInt(v);
  throw new Error(`fleet: expected shard_leases.frontier_ts to be a BIGINT-like value, got ${typeof v}`);
}

/**
 * Thrown by the apply loop's density assertion (D5, defense-in-depth — the construction, D1 store-
 * allocated ts + D3 epoch-fenced commits, is the actual guarantee that prevents this) when a
 * document entry's `prev_ts` doesn't chain from the replica's actual current head: either a
 * non-null `prev_ts` that doesn't match (or is missing entirely — no live head), or a null
 * `prev_ts` (an insert) where the replica already has a live head. Either shape means a commit
 * touching this document was skipped somewhere between the primary and this replica — serving
 * reads off it from here on would be silent corruption, so the tailer crashes loudly instead. The
 * shipped operator remedy is deleting the local replica file and letting it re-bootstrap from the
 * primary (a replica is always a rebuildable mirror).
 */
export class DensityViolationError extends Error {
  constructor(
    readonly docId: InternalDocumentId,
    readonly expectedPrevTs: bigint | null,
    readonly actualHeadTs: bigint | null,
  ) {
    super(
      `fleet: replica density violation for doc (${docLabel(docId)}) — expected prev_ts ` +
        `${expectedPrevTs === null ? "null (insert — replica must have no live head)" : String(expectedPrevTs)}, ` +
        `but the replica's actual head ts is ${actualHeadTs === null ? "null (no live head)" : String(actualHeadTs)}. ` +
        `A commit touching this document was skipped between the primary and this replica; delete ` +
        `<replica path>/fleet-replica.db to re-bootstrap.`,
    );
    this.name = "DensityViolationError";
  }
}

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
  /** Number of shards the fleet runs (B2a). The tailer's target is `F = min(frontier_ts)` over ALL
   *  shard rows, and it refuses to treat a partial `shard_leases` (`count(*) < numShards`) as ready —
   *  a half-created lease table must not fake a min (belt-and-braces against the F1×N hole). Default
   *  1 → B1's single-shard behavior. */
  numShards?: number;
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
  private readonly numShards: number;
  private readonly onInvalidation: (inv: AppliedInvalidation) => Promise<void>;
  /** The tailer's own applied high-water mark — a `StablePrefixTs` (D6): only ever seeded from the
   *  replica's own persisted `maxTimestamp()` (a prior run's watermark, on restart) or advanced to
   *  a freshly-read/capped `F`. Never assigned a raw, un-branded `bigint` directly. */
  private wm: StablePrefixTs = stablePrefixFromFrontier(0n);
  /** The last-observed fenced frontier (D5) — tracked purely to assert F never regresses across
   *  reads (`null` = no read yet, so the first `readFrontier()` establishes the baseline without
   *  asserting anything). */
  private lastF: StablePrefixTs | null = null;
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
    this.numShards = opts.numShards ?? DEFAULT_NUM_SHARDS;
    this.onInvalidation = opts.onInvalidation;
  }

  /** Plain `bigint` on purpose (not the branded `StablePrefixTs`) — external callers (tests, the
   *  `PromotionDeps` seam) only ever compare/print this value; widening away the internal brand at
   *  the public boundary costs nothing and avoids forcing every caller to know about the brand. */
  watermark(): bigint {
    return this.wm;
  }

  /**
   * Reads the fenced frontier `F` (Fenced Frontier B1 D5, generalized to N shards in B2a) —
   * `F = min(frontier_ts)` over ALL `shard_leases` rows — via the same `CommitChannelClient` already
   * threaded in for LISTEN/NOTIFY. The min is the dense prefix the WHOLE fleet has durably fenced: a
   * replica may serve reads up to it and never past a commit that hasn't been fenced on every shard.
   *
   * Belt-and-braces (B2a — the F1×N hole otherwise recurs ×N): treat `count(*) < numShards` as
   * F=0-equivalent (NOT ready). A half-created `shard_leases` — some shards claimed+seeded, others not
   * yet — must not let `min` over the present rows fake a ready frontier; the writer's acquire-all +
   * seed-all completes (all N rows present, each seeded ≥ max) BEFORE it reports ready, so a real min
   * only appears once every shard is genuinely fenced. `count(*) = 0` (fresh fleet, pre-acquisition)
   * is the same F=0.
   *
   * Asserts F is monotonically non-decreasing across reads once the count gate is satisfied (D5's
   * defense-in-depth invariant) — a regression can only mean `shard_leases` was corrupted/hand-
   * tampered. The assertion is skipped while `count(*) < numShards` (F is a placeholder 0 there, so a
   * later real min is legitimately larger, not a regression).
   */
  private async readFrontier(): Promise<StablePrefixTs> {
    const rows = await this.client.query(
      `SELECT COALESCE(MIN(frontier_ts), 0) AS min_frontier, COUNT(*) AS n FROM shard_leases`,
    );
    const row = rows[0];
    const count = row === undefined ? 0 : Number(toBigInt(row.n));
    if (count < this.numShards) return stablePrefixFromFrontier(0n); // partial/absent lease table — not ready
    const raw = row === undefined ? 0n : toBigInt(row.min_frontier);
    const f = stablePrefixFromFrontier(raw);
    if (this.lastF !== null && f < this.lastF) {
      throw new Error(
        `fleet: frontier regression detected — min(shard_leases.frontier_ts) went from ${this.lastF} to ${f}. ` +
          `F must be monotonically non-decreasing; this indicates a lease row was corrupted or hand-tampered.`,
      );
    }
    this.lastF = f;
    return f;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Seed from the REPLICA's own high-water mark (0 for a fresh replica, or wherever a
    // previous run left off) — this is what makes catch-up resumable across restarts. This IS a
    // prior watermark (this node's own last-applied frontier), so it's a legitimate StablePrefixTs.
    this.wm = stablePrefixFromFrontier(await this.replica.maxTimestamp());
    const target = await this.readFrontier();

    // Bootstrap catch-up: repeat batch-capped ticks until the replica has caught up to the FENCED
    // FRONTIER F AT CALL TIME (the ready gate). Writes that land after this point are the
    // LISTEN+poll loop's job below, same as CommitTailer.
    while (!this.stopped && this.wm < target) {
      await this.tick();
    }
    // `stop()` can land while the bootstrap loop above is awaiting a `tick()` — it already cleared
    // (then-undefined) `timer`/`unlisten` and is done, so falling through to arm either here would
    // leak a listener/timer `stop()` never gets a chance to tear down. Re-check before arming.
    if (this.stopped) return;

    try {
      this.unlisten = await this.client.listen(COMMIT_CHANNEL, () => {
        void this.tick();
      });
    } catch {
      // LISTEN unsupported (e.g. a test double, or a transient connection issue) — the poll
      // loop below is the correctness path regardless, so this is not fatal to start().
      this.unlisten = undefined;
    }
    if (this.stopped) {
      // stop() landed while the (possibly slow) listen() call above was in flight.
      if (this.unlisten !== undefined) {
        const unlisten = this.unlisten;
        this.unlisten = undefined;
        await unlisten();
      }
      return;
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
      await this.drainOnce();
    } catch (e) {
      if (e instanceof DensityViolationError) {
        // A density violation means a commit was skipped between the primary and this replica — the
        // replica is corrupt and can only serve silently-wrong reads from here on. HALT PERMANENTLY:
        // the fire-and-forget `void this.tick()` callers (the LISTEN wake + the pollMs setInterval)
        // would otherwise re-hit the exact same violation every tick forever (watermark frozen, an
        // endless error loop), since the divergence is on disk and never self-heals. `stop()` clears
        // the interval + closes LISTEN so no further ticks run; the logged message already carries the
        // operator remedy (delete the replica file and re-bootstrap from the primary). Not rethrown:
        // this is the terminal handling, not a transient error to propagate.
        console.error(e.message);
        await this.stop();
        return;
      }
      throw e;
    } finally {
      this.draining = false;
    }
  }

  /** One pull-apply-invalidate walk. Split out from `tick()` so `tick()` can wrap it with the
   *  DensityViolationError halt handling without that catch swallowing the `draining` bookkeeping. */
  private async drainOnce(): Promise<void> {
    const F = await this.readFrontier();
    if (F <= this.wm) return; // spurious wake — nothing new since last apply (or no lease yet)

    const { docs, cappedAt } = await this.pullDocs(this.wm, F);
    const appliedMax = stablePrefixFromFrontier(cappedAt ?? F);

    const indexRows = await this.client.query(
      `SELECT index_id, key, ts, table_id, internal_id, deleted FROM indexes WHERE ts > $1 AND ts <= $2 ORDER BY ts ASC`,
      [this.wm, appliedMax],
    );

    if (docs.length === 0 && indexRows.length === 0) {
      // B2a: F advanced past the watermark but the range `(wm, F]` holds NO rows. This is the
      // idle-shard-closing case: the writer advances an idle shard's frontier via a bare `nextval`
      // (D5) with no backing document, so `min(frontier_ts)` can legitimately run AHEAD of the last
      // committed doc's ts. The replica IS caught up to F (there is provably nothing to apply in the
      // range — and never will be, since any future commit takes a still-later `nextval`), so ADVANCE
      // the watermark to F. Without this the bootstrap loop (`while wm < target`) would spin forever
      // waiting for documents that will never exist in this range, and RYOW `waitFor(F)` would hang.
      // (Single-shard B1 never reaches here: with the idle-closer off, F only advances alongside a
      // real commit, so an F>wm range is never empty.)
      this.wm = appliedMax;
      this.wakeSatisfiedWaiters();
      return;
    }

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

    // Density assertions (D5, defense-in-depth) — MUST run against the replica's PRE-apply
    // state, so before the write() below (which would otherwise make every check trivially
    // pass, since the entry itself would already be its own head by the time it's checked).
    await this.assertDensity(docs);

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
      const dedupeKey = docDedupeKey(d.id);
      if (seenDocs.has(dedupeKey)) continue;
      seenDocs.add(dedupeKey);
      writtenDocs.push({ tableId: encodeStorageTableId(d.id.tableNumber), internalId: d.id.internalId });
    }

    await this.onInvalidation({ newMaxTs: appliedMax, writtenTables, writtenKeys, writtenDocs });
    // Advance ONLY after onInvalidation resolves — a throwing/slow handler must not cause this
    // range to be silently skipped on the next tick.
    this.wm = appliedMax;
    this.wakeSatisfiedWaiters();
  }

  /**
   * Density assertion (D5, defense-in-depth): for EVERY document entry in this batch, in
   * `DocumentLogEntry` order, the replica's head for that document IMMEDIATELY BEFORE this entry
   * lands must chain from `entry.prev_ts` exactly — `prev_ts !== null` requires a live head equal
   * to it; `prev_ts === null` (an insert) requires no live head at all. Throws `DensityViolationError`
   * on the first mismatch.
   *
   * IDEMPOTENT RE-APPLY exception: if the replica's head is ALREADY at this exact entry's own
   * `ts`, that's not a violation — it's this exact revision being re-applied (the whole class is
   * built around `"Overwrite"` idempotency, e.g. a restart re-walking an already-applied range).
   * Since `ts` is the log's globally unique per-shard commit position, a head landing on it can
   * only mean this precise commit already landed here, never an unrelated collision.
   *
   * A batch can carry more than one revision of the SAME document (it was written more than once
   * inside the pulled `(wm, F]` range), so "the head immediately before this entry" is a running
   * per-batch simulation — seeded from the replica's REAL state (`replica.get`) the first time a
   * doc is encountered, then advanced in-memory to each entry's own `ts` as it's validated —
   * rather than re-reading the replica for every entry (which would see later, not-yet-applied
   * entries' predecessor as still absent).
   */
  private async assertDensity(docs: readonly DocumentLogEntry[]): Promise<void> {
    const headTs = new Map<string, bigint | null>();
    for (const d of docs) {
      const key = docDedupeKey(d.id);
      let head = headTs.get(key);
      if (head === undefined) {
        const existing = await this.replica.get(d.id);
        head = existing ? existing.ts : null;
      }
      if (head !== d.ts) {
        // Not already-applied — must chain from prev_ts exactly (see the idempotency note above).
        if (d.prev_ts !== null) {
          if (head === null || head !== d.prev_ts) throw new DensityViolationError(d.id, d.prev_ts, head);
        } else if (head !== null) {
          throw new DensityViolationError(d.id, null, head);
        }
      }
      headTs.set(key, d.ts);
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
