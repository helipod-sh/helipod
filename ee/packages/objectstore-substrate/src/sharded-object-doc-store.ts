/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `ShardedObjectStoreDocStore` — object-storage multi-shard SINGLE-NODE write scale-out: one node
 * owns ALL N object-storage lanes (each a full `ObjectStoreDocStore`, design record §5's `s{shard}/…`
 * physically independent prefix) and this class composes them behind ONE `DocStore` the engine's
 * `ShardedTransactor` talks to exactly as it talks to a single store today.
 *
 * OWNERSHIP: this class is a pure DocStore-shaped decorator over an already-open, already-`acquire()`d
 * `Map<ShardId, ObjectStoreDocStore>` — it does NOT open/acquire/heartbeat/gc the lanes itself (the
 * boot layer, `packages/cli/src/boot.ts`, drives each lane's lease/heartbeat/gc independently, so a
 * fence on one lane doesn't wait on another lane's cadence). This mirrors `ObjectStoreDocStore`'s own
 * "everything else forwards" shape, just fanned out over N lanes instead of one.
 *
 * ROUTING CONTRACT (confirmed against `packages/transactor/src/shard-writer.ts`): `commitWrite`/
 * `commitWriteBatch`/`write` are ALWAYS called by the transactor with an explicit `shardId` (the
 * `ShardedTransactor`'s own `ShardWriter.shardId`) — that is the ONE input that tells this class which
 * lane owns the commit. `get`/`scan`/`index_scan`/`load_documents`/`previous_revisions` are NEVER
 * called with a shard id (a query spans every shard) — so every read method here MERGES across every
 * lane. This is the asymmetry the whole class is built around: writes route by an explicit key, reads
 * fan out and merge.
 *
 * READ-MERGE CORRECTNESS NOTE (the caveat worth flagging to a reviewer): `get`/`scan`/
 * `previous_revisions` probe EVERY lane (a doc lives in exactly one lane — the one-doc-one-ring
 * invariant B2a established — but the `DocStore` interface gives `get(id)` no shard hint, since the
 * shard key is a document FIELD, not derivable from the internal id alone). This is O(N lanes) local
 * SQLite calls per read — correct, and cheap in practice (every lane is a FULLY MATERIALIZED local
 * store per design §6a, so this is N in-process SQLite lookups, never network I/O), but is a real cost
 * that grows with shard count. A future optimization could route `get`/`previous_revisions` directly
 * when a caller happens to know the shard; out of scope here.
 */
import type {
  ClientVerdictRecord,
  ClientVerdictWrite,
  CommitGuardUnit,
  CommitUnit,
  ConflictStrategy,
  DocStore,
  DocumentLogEntry,
  Interval,
  LatestDocument,
  Order,
  PrevRevQuery,
  SchemaSetupOptions,
  ShardId,
  TimestampRange,
  InternalDocumentId,
  IndexWrite,
} from "@stackbase/docstore";
import { DEFAULT_SHARD } from "@stackbase/id-codec";
import type { JSONValue } from "@stackbase/values";
import { mergeSortedAsyncGenerators, compareBytesLex, compareBigint } from "./merge-sorted";

export interface ShardedObjectStoreDocStoreOpts {
  /** The lane this class routes deployment-level bookkeeping to (globals, client-verdict receipts) —
   *  a single source of truth rather than N independently-diverging copies. Unset -> `"default"`
   *  (`DEFAULT_SHARD`), matching the un-sharded-table convention every other routing seam in the repo
   *  uses (`shard.ts`'s `DEFAULT_SHARD`, `jump-hash.ts`'s slot 0). MUST be a key present in `lanes`. */
  defaultShard?: ShardId;
}

export class ShardedObjectStoreDocStore implements DocStore {
  private readonly lanes: ReadonlyMap<ShardId, DocStore>;
  private readonly defaultShard: ShardId;

  constructor(lanes: ReadonlyMap<ShardId, DocStore>, opts?: ShardedObjectStoreDocStoreOpts) {
    if (lanes.size === 0) {
      throw new Error("ShardedObjectStoreDocStore: at least one lane is required");
    }
    const defaultShard = opts?.defaultShard ?? DEFAULT_SHARD;
    if (!lanes.has(defaultShard)) {
      throw new Error(
        `ShardedObjectStoreDocStore: defaultShard '${defaultShard}' is not one of the composed lanes (${[...lanes.keys()].join(", ")})`,
      );
    }
    this.lanes = lanes;
    this.defaultShard = defaultShard;
  }

  private lane(shardId: ShardId): DocStore {
    const l = this.lanes.get(shardId);
    if (!l) {
      throw new Error(
        `ShardedObjectStoreDocStore: unknown shard '${shardId}' — composed lanes are (${[...this.lanes.keys()].join(", ")})`,
      );
    }
    return l;
  }

  private laneList(): DocStore[] {
    return [...this.lanes.values()];
  }

  // ── Writes — route by the caller-supplied shardId (the ShardedTransactor always passes one for
  //    commits; `write`'s replica/bootstrap callers do too — see `ObjectStoreDocStore.materializeTo`) ─

  setupSchema(options?: SchemaSetupOptions): Promise<void> {
    return Promise.all(this.laneList().map((l) => l.setupSchema(options))).then(() => undefined);
  }

  // NOTE: these three are deliberately `async` (not a bare `return this.lane(...)...`) so an
  // unknown-shardId lookup failure — thrown SYNCHRONOUSLY by `this.lane()` — surfaces as a REJECTED
  // promise, matching every other `DocStore` method's async contract, rather than throwing
  // synchronously out of the call before the caller ever gets a promise to await/catch.
  async write(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    conflictStrategy: ConflictStrategy,
    shardId?: ShardId,
  ): Promise<void> {
    return this.lane(shardId ?? this.defaultShard).write(documents, indexUpdates, conflictStrategy, shardId);
  }

  async commitWrite(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    shardId?: ShardId,
    opts?: { meta?: Record<string, string> },
  ): Promise<bigint> {
    return this.lane(shardId ?? this.defaultShard).commitWrite(documents, indexUpdates, shardId, opts);
  }

  async commitWriteBatch(units: readonly CommitUnit[], shardId?: ShardId): Promise<bigint[]> {
    return this.lane(shardId ?? this.defaultShard).commitWriteBatch(units, shardId);
  }

  /**
   * Fan the SAME guard out to every lane (one registration per lane) — a guard for the sharded case
   * therefore fences/effects PER LANE, not atomically across the whole sharded store. This matches
   * `ObjectStoreDocStore`'s own single-lane note ("guard atomicity + effectively-once forwarding are a
   * LATER slice") — composing N of them doesn't add a NEW atomicity gap, it just makes the existing
   * per-lane-only scope explicit at the sharded layer too.
   */
  addCommitGuard(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store-specific querier type, mirrors DocStore's own signature
    guard: (q: any, units: readonly CommitGuardUnit[], shardId: ShardId) => void | Promise<void>,
  ): () => void {
    const unregs = this.laneList().map((l) => l.addCommitGuard(guard));
    return () => {
      for (const unreg of unregs) unreg();
    };
  }

  // ── Reads — MERGE across every lane (the transactor never tells us which shard a read is for) ────

  async get(id: InternalDocumentId, readTimestamp?: bigint): Promise<LatestDocument | null> {
    const hits = await Promise.all(this.laneList().map((l) => l.get(id, readTimestamp)));
    for (const hit of hits) if (hit !== null) return hit;
    return null;
  }

  async *index_scan(
    indexId: string,
    tableId: string,
    readTimestamp: bigint,
    interval: Interval,
    order: Order,
    limit?: number,
  ): AsyncGenerator<readonly [Uint8Array, LatestDocument]> {
    const generators = this.laneList().map((l) => l.index_scan(indexId, tableId, readTimestamp, interval, order, limit));
    yield* mergeSortedAsyncGenerators(generators, (a, b) => compareBytesLex(a[0], b[0]), order, limit);
  }

  async *load_documents(range: TimestampRange, order: Order, limit?: number): AsyncGenerator<DocumentLogEntry> {
    const generators = this.laneList().map((l) => l.load_documents(range, order, limit));
    yield* mergeSortedAsyncGenerators(generators, (a, b) => compareBigint(a.ts, b.ts), order, limit);
  }

  async previous_revisions(queries: readonly PrevRevQuery[]): Promise<Map<string, DocumentLogEntry>> {
    const perLane = await Promise.all(this.laneList().map((l) => l.previous_revisions(queries)));
    const merged = new Map<string, DocumentLogEntry>();
    for (const laneResult of perLane) {
      for (const [key, entry] of laneResult) merged.set(key, entry);
    }
    return merged;
  }

  async scan(tableId: string, readTimestamp?: bigint): Promise<LatestDocument[]> {
    const perLane = await Promise.all(this.laneList().map((l) => l.scan(tableId, readTimestamp)));
    return perLane.flat();
  }

  async count(tableId: string): Promise<number> {
    const perLane = await Promise.all(this.laneList().map((l) => l.count(tableId)));
    return perLane.reduce((sum, n) => sum + n, 0);
  }

  async maxTimestamp(): Promise<bigint> {
    const perLane = await Promise.all(this.laneList().map((l) => l.maxTimestamp()));
    let max = 0n;
    for (const ts of perLane) if (ts > max) max = ts;
    return max;
  }

  // ── Deployment-level bookkeeping — route to ONE lane (the default shard) consistently, never
  //    fan out: these are single-source-of-truth concerns (fleet identity, per-client receipts), not
  //    per-shard data. Routing every deployment ever to the SAME lane means a client's receipts/floor
  //    are never split across lanes regardless of which table its mutations touched. ────────────────

  getGlobal(key: string): Promise<JSONValue | null> {
    return this.lane(this.defaultShard).getGlobal(key);
  }

  writeGlobal(key: string, value: JSONValue): Promise<void> {
    return this.lane(this.defaultShard).writeGlobal(key, value);
  }

  writeGlobalIfAbsent(key: string, value: JSONValue): Promise<boolean> {
    return this.lane(this.defaultShard).writeGlobalIfAbsent(key, value);
  }

  getClientVerdict(identity: string, clientId: string, seq: number): Promise<ClientVerdictRecord | null> {
    return this.lane(this.defaultShard).getClientVerdict(identity, clientId, seq);
  }

  getClientFloor(identity: string, clientId: string): Promise<number | null> {
    return this.lane(this.defaultShard).getClientFloor(identity, clientId);
  }

  recordClientVerdict(identity: string, clientId: string, seq: number, record: ClientVerdictWrite): Promise<void> {
    return this.lane(this.defaultShard).recordClientVerdict(identity, clientId, seq, record);
  }

  updateClientVerdictValue(identity: string, clientId: string, seq: number, value: JSONValue): Promise<void> {
    return this.lane(this.defaultShard).updateClientVerdictValue(identity, clientId, seq, value);
  }

  pruneClientMutations(
    identity: string,
    clientId: string,
    opts: { ackedThrough?: number; ttlBeforeMs?: number },
  ): Promise<{ prunedThroughSeq: number }> {
    return this.lane(this.defaultShard).pruneClientMutations(identity, clientId, opts);
  }

  sweepExpiredClientMutations(beforeMs: number): Promise<{ deletedCount: number }> {
    return this.lane(this.defaultShard).sweepExpiredClientMutations(beforeMs);
  }

  async close(): Promise<void> {
    await Promise.all(this.laneList().map((l) => l.close()));
  }
}
