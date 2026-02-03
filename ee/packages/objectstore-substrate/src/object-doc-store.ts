/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `ObjectStoreDocStore` (Tier 3 Slice 2, design record §4/§6a/§7) — a `DocStore` DECORATOR over a
 * local `SqliteDocStore` + one shard of an `ObjectStore`. Object storage is the linearization point
 * (the durable log a second process replays); the local SQLite store is a materialized cache that
 * must never get ahead of it.
 *
 * - Every read/non-commit method is a straight FORWARD to the local store (it already has the
 *   fully materialized, queryable state — that's the point of local materialization, design §6a).
 * - `commitWrite`/`commitWriteBatch` are INTERCEPTED and made OBJECT-FIRST: allocate ts from the
 *   manifest → append an immutable segment → CAS the manifest (the fence) → only on CAS success
 *   apply the same rows to the local store via the explicit-ts `write(..., "Overwrite")` path (the
 *   same primitive `open`'s bootstrap and a replica tailer use — no second explicit-ts path).
 *
 * Commits serialize under an in-process mutex (`runExclusive`) so the cached `{manifest, etag}` this
 * instance holds is always read-then-CAS'd by exactly one commit at a time — required because the
 * manifest CAS is optimistic (etag-conditional) but the LOCAL apply that follows it is not: without
 * the mutex two concurrent `commitWriteBatch` calls from the same process could race the same cached
 * etag into `casManifest` and (since only one wins) leave the loser's local apply inconsistent with
 * which segment its ts's actually landed in.
 *
 * Any `casManifest` failure (fence OR ambiguous/lost-response) POISONS this instance (whole-branch
 * review C1): the cached cursor is then untrustworthy and reusing a segment seqno would overwrite a
 * durable referenced segment on an overwrite-semantics store. Recovery = re-open (re-bootstrap).
 *
 * SLICE-2 BOUNDARIES — follow-ups the failover/replica slices (S4/S5) MUST NOT inherit silently:
 * - **Globals + client-verdict receipts are LOCAL-ONLY** (`writeGlobal*`/`recordClientVerdict`/… forward
 *   to the local store; they never enter the segment log). So a from-scratch bootstrap over object
 *   storage alone does NOT reconstruct them: `createEmbeddedRuntime` would mint a NEW `deploymentId`
 *   (flipping every outbox client to `known:false`) and lose dedup receipts (effectively-once →
 *   at-least-once). Single-node with a PERSISTENT local SQLite file survives restarts fine; but the
 *   failover slice (a fresh node materializing from the bucket) MUST persist `deploymentId` (e.g. in
 *   the manifest) and address receipt durability before it can claim "byte-identical from object
 *   storage alone" for engine bookkeeping. Effectively-once itself → the manifest idempotency window (deferred).
 * - **Fence/failure paths are tested only on `objectstore-fs`** (keep-first `putImmutable`), which
 *   structurally masks the C1 overwrite hazard the fix above guards; add MinIO-gated fence/failure
 *   variants when the failover slice lands (the C1 unit test simulates the overwrite hazard via a
 *   wrapper, so the fix is covered — but real-S3 coverage of the fence path is still owed).
 */
import type { ObjectStore } from "@stackbase/objectstore";
import { isCasConflict } from "@stackbase/objectstore";
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
import type { JSONValue } from "@stackbase/values";
import type { SqliteDocStore } from "@stackbase/docstore-sqlite";
import { encodeSegment, decodeSegment, type SegmentPayload } from "./segment";
import { readManifest, createManifest, casManifest, type Manifest } from "./manifest";
import { writeSnapshot, readSnapshot, type SnapshotPayload } from "./snapshot";
import { FencedError } from "./fenced-error";

function segmentKey(shard: string, seqno: number): string {
  return `s${shard}/seg/${seqno}`;
}

/** Take a snapshot after this many committed segments since the last one (Tier 3 Slice 3, Task
 *  3.2). Small deliberately — tests exercise the cadence without huge commit loops; a real
 *  deployment can raise it if snapshot-object churn matters more than bootstrap tail length. */
const SNAPSHOT_EVERY = 8;

export interface ObjectStoreDocStoreOpts {
  objectStore: ObjectStore;
  shard: string;
  local: SqliteDocStore;
}

export class ObjectStoreDocStore implements DocStore {
  private readonly objectStore: ObjectStore;
  private readonly shard: string;
  private readonly local: SqliteDocStore;

  /** The last manifest state this process successfully CAS'd (or bootstrapped from) + its etag —
   *  the read-half of the next `casManifest`'s optimistic-concurrency check. Updated ONLY after a
   *  successful CAS (never speculatively), under `mutex`. */
  private cached: { manifest: Manifest; etag: string };
  /** The next free segment seqno for THIS process — dense (`[0..n]`), advanced only after a
   *  successful manifest CAS references it. */
  private nextSeqno: number;
  /** Set when a post-CAS local apply fails: the commit is durable but the local materialization is
   *  inconsistent, so further commits are refused until the store is re-opened (re-bootstrapped). */
  private poisoned = false;
  /** Serializes `commitWrite`/`commitWriteBatch` — see class doc. */
  private mutex: Promise<void> = Promise.resolve();
  /** Committed segments since the last successful snapshot (or since `open`) — `maybeSnapshot`'s
   *  cadence trigger. Reset to 0 only on a successful `snapshot()`. */
  private committedSegmentsSinceSnapshot = 0;

  private constructor(objectStore: ObjectStore, shard: string, local: SqliteDocStore, cached: { manifest: Manifest; etag: string }, nextSeqno: number) {
    this.objectStore = objectStore;
    this.shard = shard;
    this.local = local;
    this.cached = cached;
    this.nextSeqno = nextSeqno;
  }

  /**
   * Open (or initialize) a shard's object-storage-backed store: read-or-create the manifest, then
   * BOOTSTRAP the local store. If the manifest references a snapshot (Tier 3 Slice 3, Task 3.2),
   * restore it first (`write(..., "Overwrite")` of its current-state dump) and replay only the
   * TAIL segments (`seqno > snapshotSegBase`) — O(state + tail) instead of the full log. Otherwise
   * (no snapshot taken yet) replay every referenced segment, in order, via the same explicit-ts
   * `write(..., "Overwrite")` path — the identical primitive a post-CAS commit applies with, and the
   * one a replica tailer would use (design record §7). A fresh (empty) bucket bootstraps to an empty
   * local store; a bucket with prior commits reconstructs the IDENTICAL current state either way.
   */
  static async open(opts: ObjectStoreDocStoreOpts): Promise<ObjectStoreDocStore> {
    const { objectStore, shard, local } = opts;
    await local.setupSchema();

    let cached = await readManifest(objectStore, shard);
    if (cached === null) {
      try {
        cached = await createManifest(objectStore, shard);
      } catch (e) {
        // Lost a create-only race against another opener of the same shard (manifest.ts's
        // documented contract) — someone else already initialized it; read what they wrote.
        if (!isCasConflict(e)) throw e;
        cached = await readManifest(objectStore, shard);
        if (cached === null) throw e;
      }
    }

    const snapshotSegBase = cached.manifest.snapshotSegBase;
    if (cached.manifest.snapshotTs !== undefined) {
      const snap = await readSnapshot(objectStore, shard, cached.manifest.snapshotTs);
      if (snap === null) {
        throw new Error(
          `objectstore-substrate: bootstrap missing snapshot '${cached.manifest.snapshotTs}' referenced by manifest (torn state)`,
        );
      }
      // BENIGN DIVERGENCE (whole-branch review, Minor #2): `dumpCurrentState` (and so this restore)
      // excludes tombstones, so if `snap.frontierTs` is itself a DELETE's ts and the process restarts
      // with no tail beyond this snapshot, the restored `documents` table has no row AT that ts — the
      // local store's `maxTimestamp()` (`MAX(ts) FROM documents`) then TRAILS `manifest.frontierTs`.
      // This is SAFE for commit-ts correctness: `commitWriteBatch`'s floor is
      // `max(tsCounter, localMax)` and `tsCounter == frontierTs` here, so no ts is ever reused or
      // regressed. But it means `DocStore.maxTimestamp()`'s "highest committed timestamp" contract can
      // diverge post-restore — a consumer needing the AUTHORITATIVE frontier must read the manifest
      // (`frontierTs`), not call `local.maxTimestamp()`. Not fixed here (seeding a fake tombstone row
      // just to keep `maxTimestamp()` honest is worse than documenting the divergence).
      await local.write(snap.documents, snap.indexUpdates, "Overwrite");
    }

    for (const seqno of cached.manifest.segments) {
      if (snapshotSegBase !== undefined && seqno <= snapshotSegBase) continue; // covered by the snapshot
      const entry = await objectStore.get(segmentKey(shard, seqno));
      if (entry === null) {
        throw new Error(`objectstore-substrate: bootstrap missing segment '${segmentKey(shard, seqno)}' referenced by manifest`);
      }
      const payload = decodeSegment(entry.body);
      await local.write(payload.documents, payload.indexUpdates, "Overwrite");
    }

    // Read the explicit `nextSeqno` cursor (whole-branch review, Task 3.3 fix) — NEVER derive it from
    // `segments` via `Math.max(...)`: once `snapshot()` trims `segments` to the post-snapshot tail, a
    // snapshot-covers-everything bootstrap (empty tail) would otherwise compute 0 instead of the true
    // cursor, and even pre-trim, `Math.max(...segments)` argument-spreads the WHOLE array onto the
    // call stack and throws `RangeError: Maximum call stack size exceeded` past ~100k segments.
    // `nextSeqno ?? …` is a belt-and-suspenders fallback for a hand-built/pre-fix test fixture
    // manifest missing the field — the real commit/snapshot paths always set it.
    const nextSeqno =
      cached.manifest.nextSeqno ?? (cached.manifest.segments.length === 0 ? 0 : Math.max(...cached.manifest.segments) + 1);
    return new ObjectStoreDocStore(objectStore, shard, local, cached, nextSeqno);
  }

  /** Chain `fn` onto the mutex so commits from this process serialize (see class doc). */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutex.then(fn, fn);
    // Swallow the result's rejection for the CHAIN's sake only — `result` itself (returned below)
    // still carries the real rejection to this call's caller.
    this.mutex = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ── Commit path (intercepted, object-first) ─────────────────────────────────────────────────

  async commitWriteBatch(units: readonly CommitUnit[], shardId?: ShardId): Promise<bigint[]> {
    const tsList = await this.runExclusive(async () => {
      // Empty batch is a no-op (matches SqliteDocStore.commitWriteBatch) — never write an empty segment.
      if (units.length === 0) return [];
      if (this.poisoned) {
        throw new Error(
          `ObjectStoreDocStore for shard '${this.shard}' is poisoned (a prior post-commit local apply failed); it must be re-opened before further use`,
        );
      }
      const localMax = await this.local.maxTimestamp();
      const cachedTsCounter = BigInt(this.cached.manifest.tsCounter);
      const floor = cachedTsCounter > localMax ? cachedTsCounter : localMax;

      const stampedUnits: Array<{ documents: DocumentLogEntry[]; indexUpdates: IndexWrite[] }> = [];
      const allDocuments: DocumentLogEntry[] = [];
      const allIndexUpdates: IndexWrite[] = [];
      const tsList: bigint[] = [];

      for (let i = 0; i < units.length; i++) {
        const unit = units[i]!;
        const ts = floor + BigInt(i) + 1n;
        tsList.push(ts);
        const stampedDocs = unit.documents.map((d) => ({ ...d, ts }));
        const stampedIdx = unit.indexUpdates.map((w) => ({ ...w, ts }));
        stampedUnits.push({ documents: stampedDocs, indexUpdates: stampedIdx });
        allDocuments.push(...stampedDocs);
        allIndexUpdates.push(...stampedIdx);
      }

      const maxTs = tsList[tsList.length - 1]!;
      const seqno = this.nextSeqno;
      const payload: SegmentPayload = { documents: allDocuments, indexUpdates: allIndexUpdates };
      await this.objectStore.putImmutable(segmentKey(this.shard, seqno), encodeSegment(payload));

      // Spread `this.cached.manifest` FIRST so `snapshotTs`/`snapshotSegBase` (Task 3.2) carry
      // forward untouched — a commit never changes what the latest snapshot covers, only
      // `snapshot()` does — then override the fields this commit actually advances.
      const next: Manifest = {
        ...this.cached.manifest,
        frontierTs: maxTs.toString(),
        tsCounter: maxTs.toString(),
        segments: [...this.cached.manifest.segments, seqno],
        nextSeqno: seqno + 1,
      };

      let etag: string;
      try {
        ({ etag } = await casManifest(this.objectStore, this.shard, next, this.cached.etag));
      } catch (e) {
        // ANY casManifest failure POISONS this instance (whole-branch review C1). After a failed CAS
        // our cached `{manifest, etag}` and `nextSeqno` are untrustworthy: a `CasConflict` means we
        // were fenced (the manifest moved); a GENERIC error is AMBIGUOUS — the CAS may have LANDED
        // (a lost response) even though it threw. In both cases, continuing to serve commits on this
        // instance would reuse `seqno` against a stale cursor and, on an OVERWRITE-semantics object
        // store (S3/R2/MinIO — `objectstore-fs`'s keep-first hides this, which is why no test caught
        // it), OVERWRITE a durable manifest-referenced segment with different bytes → silent log
        // corruption + ts regression. So we stop: the instance must be RE-OPENED (re-bootstrapped from
        // the true manifest), which resyncs `cached`/`nextSeqno`. (Poisoning a clean CAS-fail that
        // truly didn't land is stricter than necessary — that only overwrites our own unreferenced
        // orphan — but ambiguity makes it the correct universal choice.) The just-PUT `seg/${seqno}`
        // is an orphan (unreferenced or ambiguously-referenced; GC is a later slice).
        this.poisoned = true;
        if (isCasConflict(e)) {
          throw new FencedError(
            `commit fenced: manifest for shard '${this.shard}' moved (stale etag) — this writer is no longer current and is now poisoned (re-open to continue)`,
          );
        }
        throw e;
      }

      // CAS succeeded: the durable log now includes this commit — it CANNOT be un-committed. Apply the
      // SAME rows to the local store via the explicit-ts path (bootstrap's own primitive) BEFORE
      // advancing the cached cursor, so `cached`/`nextSeqno` never claim "caught up" while `local` is
      // behind. If a post-CAS local write throws (a genuine local-store fault), the commit is still
      // DURABLE, so we must NOT surface a retryable-looking failure (which would double-commit under
      // fresh timestamps) — poison this instance (its local materialization is now inconsistent) and
      // throw a distinct, non-retryable error demanding a re-open. A restart re-bootstraps correctly
      // from the object log (which already contains this commit).
      try {
        for (const u of stampedUnits) {
          await this.local.write(u.documents, u.indexUpdates, "Overwrite", shardId);
        }
      } catch (e) {
        this.poisoned = true;
        throw new Error(
          `post-commit local apply failed after a DURABLE commit to shard '${this.shard}' (seqno ${seqno}); ` +
            `the commit is durable but this ObjectStoreDocStore's local materialization is inconsistent and must be re-opened. Cause: ${(e as Error)?.message ?? String(e)}`,
        );
      }
      this.cached = { manifest: next, etag };
      this.nextSeqno = seqno + 1;
      this.committedSegmentsSinceSnapshot++;

      return tsList;
    });
    // Outside the exclusive block (DEADLOCK HAZARD — see class doc / snapshot()'s own doc): a
    // snapshot itself takes the mutex, so triggering it from inside the commit's own exclusive
    // body would chain a second `runExclusive` onto a mutex this call still holds. Best-effort: a
    // snapshot failure must never fail an already-durable commit.
    await this.#maybeSnapshotBestEffort();
    return tsList;
  }

  async commitWrite(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    shardId?: ShardId,
    opts?: { meta?: Record<string, string> },
  ): Promise<bigint> {
    const out = await this.commitWriteBatch([{ documents, indexUpdates, meta: opts?.meta }], shardId);
    return out[0]!;
  }

  // ── Snapshots (Tier 3 Slice 3, Task 3.2) — object-first, under the commit mutex ─────────────

  /**
   * Take a snapshot of the local store's current state and CAS the manifest to reference it, so a
   * future `open` can bootstrap in O(state + tail) instead of replaying the whole segment log.
   * Serializes against commits via `runExclusive` — same reasoning as `commitWriteBatch`: it reads
   * `cached`/`nextSeqno` and CAS's the manifest, so it must not race a concurrent commit's CAS
   * against the same cached etag.
   *
   * DEADLOCK HAZARD: `runExclusive` is NOT reentrant. Never call `snapshot()`/`maybeSnapshot()` from
   * INSIDE another `runExclusive` body (e.g. the commit path's own exclusive block) — chain it AFTER
   * that block resolves instead (see `commitWriteBatch`'s `#maybeSnapshotBestEffort` call site).
   *
   * BENIGN DIVERGENCE (whole-branch review, Minor #2): if this snapshot's boundary (`frontierTs`) is
   * a DELETE's ts, the dump it captures (`dumpCurrentState` excludes tombstones) has no row at that
   * ts — see the matching note at `open()`'s snapshot-restore site for the full explanation and why
   * it's safe (the `tsCounter` commit floor, not `local.maxTimestamp()`, is what guards ts reuse).
   */
  async snapshot(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.poisoned) {
        throw new Error(
          `ObjectStoreDocStore for shard '${this.shard}' is poisoned (a prior post-commit local apply failed); it must be re-opened before further use`,
        );
      }
      if (this.nextSeqno === 0) return; // no committed segments yet — nothing to snapshot

      const dump = await this.local.dumpCurrentState();
      const frontierTs = this.cached.manifest.frontierTs;
      const segBase = this.nextSeqno - 1; // the last committed seqno
      const payload: SnapshotPayload = { frontierTs, segBase, documents: dump.documents, indexUpdates: dump.indexUpdates };

      // Object-first (same torn-forward discipline as segments): the snapshot object lands BEFORE
      // the manifest references it, so the manifest can never point at an absent snapshot.
      await writeSnapshot(this.objectStore, this.shard, payload);

      // TRIM `segments` to the post-snapshot tail (whole-branch review, Task 3.3 fix): everything
      // <= segBase is now covered by the snapshot itself — bootstrap's `open()` never reads them
      // again (see the segBase skip in the replay loop above) — so keeping them in the manifest only
      // grows this array without bound over the store's history (O(N²) commits, and a
      // `Math.max(...segments)` bootstrap read that would eventually RangeError). `nextSeqno` is
      // preserved untouched by the `{...cached.manifest}` spread below — a snapshot never advances or
      // rewinds the segment cursor, only `commitWriteBatch` does.
      const next: Manifest = {
        ...this.cached.manifest,
        snapshotTs: frontierTs,
        snapshotSegBase: segBase,
        segments: this.cached.manifest.segments.filter((s) => s > segBase),
      };
      try {
        const { etag } = await casManifest(this.objectStore, this.shard, next, this.cached.etag);
        this.cached = { manifest: next, etag };
      } catch (e) {
        // Same C1 discipline as the commit path: ANY casManifest failure (fence or ambiguous lost
        // response) leaves `cached`'s etag untrustworthy for the NEXT commit's CAS — poison rather
        // than risk a stale-etag reuse. Note `nextSeqno` is unaffected either way (a snapshot never
        // consumes a segment seqno), but the poisoned flag still forces a re-open before any further
        // commit or snapshot is served.
        this.poisoned = true;
        if (isCasConflict(e)) {
          throw new FencedError(
            `snapshot fenced: manifest for shard '${this.shard}' moved (stale etag) — this writer is no longer current and is now poisoned (re-open to continue)`,
          );
        }
        throw e;
      }
      this.committedSegmentsSinceSnapshot = 0;
    });
  }

  /** Take a snapshot if `SNAPSHOT_EVERY` segments have committed since the last one. No-op
   *  (including a poisoned instance — the next commit/explicit `snapshot()` call will surface that
   *  loudly) otherwise. */
  async maybeSnapshot(): Promise<void> {
    if (this.poisoned) return;
    if (this.committedSegmentsSinceSnapshot < SNAPSHOT_EVERY) return;
    await this.snapshot();
  }

  /** `maybeSnapshot()`, swallowing any error — called from OUTSIDE the commit's exclusive block
   *  (see `commitWriteBatch`). A snapshot failure must never fail an already-durable commit; if it
   *  poisoned this instance, the next commit's own poisoned-check surfaces that loudly instead. */
  async #maybeSnapshotBestEffort(): Promise<void> {
    try {
      await this.maybeSnapshot();
    } catch {
      // Swallowed by design — see doc comment above.
    }
  }

  // ── GC (Tier 3 Slice 3, Task 3.3) — reclaim what the latest snapshot has superseded ─────────

  /**
   * Reclaim durable objects the CURRENT manifest's snapshot has superseded: every segment with
   * `seqno <= snapshotSegBase` (its state is captured in the snapshot, so bootstrap never reads
   * it) and every snapshot object except the current one (`snapshotTs`). The newest snapshot is
   * the floor — no consumer/replica watermark (that's a later slice).
   *
   * Runs under `runExclusive` — it reads `this.cached.manifest` and must see a consistent
   * snapshot pointer, and must not race a concurrent commit/snapshot that could move
   * `snapshotSegBase` out from under it. Never touches the manifest itself or `this.cached`/
   * `nextSeqno` — GC is purely subtractive over objects the manifest no longer needs.
   *
   * PERFORMANCE NOTE (whole-branch review, Minor #4): because it runs under `runExclusive`, `gc()`
   * blocks `commitWriteBatch`/`snapshot()` on this instance for the ENTIRE list+delete sweep — fine
   * for a manual, occasional, single-node call (today's only caller), but revisit the locking
   * granularity once GC becomes an automatic/background driver.
   *
   * S4 MULTI-WRITER HAZARD (whole-branch review, Minor #3, not reachable in single-node Slice 3): this
   * deletes every `snap/*` except THIS instance's own cached `snapshotTs`. A stale/fenced writer whose
   * `poisoned` flag hasn't tripped yet (it only trips after an ATTEMPTED CAS — see the class doc's C1
   * note) still holds an OLD `snapshotTs` and would delete the CURRENT writer's live snapshot out from
   * under it, sinking a fresh bootstrap. Before `gc()` is exposed under multi-writer (S4), it must be
   * epoch-fenced (checked against the current manifest's `epoch`) before it deletes anything.
   */
  async gc(): Promise<{ deletedSegments: number; deletedSnapshots: number }> {
    return this.runExclusive(async () => {
      if (this.poisoned) {
        throw new Error(
          `ObjectStoreDocStore for shard '${this.shard}' is poisoned (a prior post-commit local apply failed); it must be re-opened before further use`,
        );
      }
      if (this.cached.manifest.snapshotTs === undefined) {
        return { deletedSegments: 0, deletedSnapshots: 0 }; // no snapshot yet — nothing to GC
      }
      const segBase = this.cached.manifest.snapshotSegBase!;
      const keepSnap = this.cached.manifest.snapshotTs!;

      const segPrefix = `s${this.shard}/seg/`;
      const segKeys = await this.objectStore.list(segPrefix);
      let deletedSegments = 0;
      for (const key of segKeys) {
        const suffix = key.slice(key.lastIndexOf("/") + 1);
        const seqno = Number(suffix);
        // Defensive: skip any key whose suffix doesn't parse to an integer — never delete an
        // object we don't understand. NEVER delete seqno > segBase (a live segment bootstrap
        // still replays); the predicate below is deliberately `<=`, never anything looser.
        if (!Number.isInteger(seqno)) continue;
        if (seqno <= segBase) {
          await this.objectStore.delete(key);
          deletedSegments++;
        }
      }

      const snapPrefix = `s${this.shard}/snap/`;
      const snapKeys = await this.objectStore.list(snapPrefix);
      let deletedSnapshots = 0;
      for (const key of snapKeys) {
        const ts = key.slice(key.lastIndexOf("/") + 1);
        if (ts !== keepSnap) {
          await this.objectStore.delete(key);
          deletedSnapshots++;
        }
      }

      return { deletedSegments, deletedSnapshots };
    });
  }

  // ── Everything else: forward to the local materialized store ───────────────────────────────

  setupSchema(options?: SchemaSetupOptions): Promise<void> {
    return this.local.setupSchema(options);
  }

  write(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    conflictStrategy: ConflictStrategy,
    shardId?: ShardId,
  ): Promise<void> {
    return this.local.write(documents, indexUpdates, conflictStrategy, shardId);
  }

  addCommitGuard(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store-specific querier type, mirrors DocStore's own signature
    guard: (q: any, units: readonly CommitGuardUnit[], shardId: ShardId) => void | Promise<void>,
  ): () => void {
    // Manifest-atomic guards + effectively-once forwarding are a LATER slice (the whole-arc plan's
    // "Global constraints": Slice 2 defers guard atomicity/effectively-once and just delegates to
    // the local store, same as it does for every other non-commit method). A guard registered here
    // runs inside the LOCAL SQLite commit only, AFTER the object-storage commit has already landed
    // durably — it is not part of the fence and cannot abort the durable write.
    return this.local.addCommitGuard(guard);
  }

  get(id: InternalDocumentId, readTimestamp?: bigint): Promise<LatestDocument | null> {
    return this.local.get(id, readTimestamp);
  }

  index_scan(
    indexId: string,
    tableId: string,
    readTimestamp: bigint,
    interval: Interval,
    order: Order,
    limit?: number,
  ): AsyncGenerator<readonly [Uint8Array, LatestDocument]> {
    return this.local.index_scan(indexId, tableId, readTimestamp, interval, order, limit);
  }

  load_documents(range: TimestampRange, order: Order, limit?: number): AsyncGenerator<DocumentLogEntry> {
    return this.local.load_documents(range, order, limit);
  }

  previous_revisions(queries: readonly PrevRevQuery[]): Promise<Map<string, DocumentLogEntry>> {
    return this.local.previous_revisions(queries);
  }

  scan(tableId: string, readTimestamp?: bigint): Promise<LatestDocument[]> {
    return this.local.scan(tableId, readTimestamp);
  }

  count(tableId: string): Promise<number> {
    return this.local.count(tableId);
  }

  maxTimestamp(): Promise<bigint> {
    return this.local.maxTimestamp();
  }

  getGlobal(key: string): Promise<JSONValue | null> {
    return this.local.getGlobal(key);
  }

  writeGlobal(key: string, value: JSONValue): Promise<void> {
    return this.local.writeGlobal(key, value);
  }

  writeGlobalIfAbsent(key: string, value: JSONValue): Promise<boolean> {
    return this.local.writeGlobalIfAbsent(key, value);
  }

  getClientVerdict(identity: string, clientId: string, seq: number): Promise<ClientVerdictRecord | null> {
    return this.local.getClientVerdict(identity, clientId, seq);
  }

  getClientFloor(identity: string, clientId: string): Promise<number | null> {
    return this.local.getClientFloor(identity, clientId);
  }

  recordClientVerdict(identity: string, clientId: string, seq: number, record: ClientVerdictWrite): Promise<void> {
    return this.local.recordClientVerdict(identity, clientId, seq, record);
  }

  updateClientVerdictValue(identity: string, clientId: string, seq: number, value: JSONValue): Promise<void> {
    return this.local.updateClientVerdictValue(identity, clientId, seq, value);
  }

  pruneClientMutations(
    identity: string,
    clientId: string,
    opts: { ackedThrough?: number; ttlBeforeMs?: number },
  ): Promise<{ prunedThroughSeq: number }> {
    return this.local.pruneClientMutations(identity, clientId, opts);
  }

  sweepExpiredClientMutations(beforeMs: number): Promise<{ deletedCount: number }> {
    return this.local.sweepExpiredClientMutations(beforeMs);
  }

  close(): void | Promise<void> {
    // The object store is a stateless client (an HTTP/fs handle, nothing to release) — only the
    // local store owns a resource (the SQLite connection/file) that needs closing.
    return this.local.close();
  }
}
