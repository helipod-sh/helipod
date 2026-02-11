/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `ObjectStoreReplicaTailer` (Tier 3 Slice 5, Task 5.1, design record §7/§8) — the object-storage
 * analog of the shipped fleet `ReplicaTailer` (`ee/packages/fleet/src/replica-tailer.ts`): polls a
 * shard's manifest, pulls whatever segments/snapshot it references that this replica hasn't already
 * applied, materializes them onto a local `SqliteDocStore` via the SAME `write(..., "Overwrite")`
 * primitive `ObjectStoreDocStore.open()`'s `materializeTo` uses, derives an `AppliedInvalidation` from
 * the SAME batch it just applied (not a separate query), and advances its watermark only after the
 * caller's `onInvalidation` sink resolves — mirroring the fleet tailer's tick()/`AppliedInvalidation`/
 * watermark-after-sink shape (see that file's module doc for the fuller rationale this class carries
 * over unmodified: verbatim apply, advance-after-sink so a throwing/slow handler can't skip a range).
 *
 * DIVERGES from the fleet tailer in exactly the ways the substrate itself diverges from Postgres:
 *   - No LISTEN/NOTIFY wake — object storage has no such primitive, so this tailer is PURELY poll-
 *     driven (`start()` arms a `setInterval`; a caller can also drive `tick()` directly, e.g. in tests).
 *   - No `batchSize` cap — a round always pulls everything between the last applied point and the
 *     manifest's CURRENT frontier in one pass (a segment is already a bounded unit; there is no
 *     unbounded single-transaction pull to guard against the way Postgres's per-row `load_documents`
 *     needed capping).
 *   - No density assertions — object storage's manifest CAS is itself the fence (Slice 2/4); a
 *     replica can only ever observe a manifest state that was durably, atomically committed, so
 *     there is no "torn" row shape to defend against the way Postgres's row-at-a-time replication
 *     could theoretically skip a write.
 *   - A SNAPSHOT FALLBACK the fleet tailer has no analog for: object storage's `gc()` can delete a
 *     segment a lagging replica hasn't pulled yet (there is no `pg_advisory` retention the way a
 *     logical-replication slot would give Postgres) — see `#materializeRound`'s doc for how a missing
 *     segment falls back to a snapshot restore instead of failing outright. Task 5.2's watermark-aware
 *     `gc()` is the production mitigation (never GC below a lagging consumer's watermark); this
 *     fallback is the correctness backstop for the eventually-consistent object-store window regardless.
 *
 * BOOTSTRAP: unlike the fleet tailer (which bootstraps itself via a bounded catch-up loop inside
 * `start()`), this tailer does NOT bootstrap `local` — the caller is expected to have already
 * materialized it (typically via `ObjectStoreDocStore.open({objectStore, shard, local})`, or by
 * simply handing over a bare, empty `SqliteDocStore` and letting this tailer's OWN first `tick()`
 * perform the full catch-up, since `#materializeRound`'s snapshot-fallback + tail-pull IS the same
 * algorithm `materializeTo` runs). The tailer discovers where `local` actually stands lazily, on its
 * first `tick()`, by reading `local.maxTimestamp()` — see `#ensureInitialized`'s doc for why this must
 * happen lazily (on first tick, not in the constructor) and how it seeds `appliedSeqno` safely. Either
 * way, the caller MUST have already run `local.setupSchema()` before handing it over (`open()`'s own
 * first step) — this tailer never creates the schema itself, only applies rows into it.
 */
import type { ObjectStore } from "@stackbase/objectstore";
import type { DocumentLogEntry, IndexWrite, InternalDocumentId } from "@stackbase/docstore";
import type { SqliteDocStore } from "@stackbase/docstore-sqlite";
import { encodeStorageTableId, internalIdToHex } from "@stackbase/id-codec";
import { readManifest, type Manifest } from "./manifest";
import { readSnapshot } from "./snapshot";
import { decodeSegment } from "./segment";
import { segmentKey } from "./object-doc-store";

/** Bounds the missing-segment retry loop in `#materializeRound` (Finding 4, whole-branch review):
 *  on the shipped strongly-consistent adapters (fs/S3) a raced-GC restart converges in one or two
 *  iterations; this cap turns a hypothetically eventually-consistent store's non-convergence into a
 *  loud, clear error instead of an infinite spin. The normal convergence path is unaffected. */
const MAX_MISSING_SEGMENT_RETRIES = 8;

/** Mirrors the fleet tailer's `AppliedInvalidation` shape byte-for-byte (see that file's doc for why
 *  this is a deliberate parallel type, not a shared import — the substrate must not depend on
 *  `@stackbase/fleet`). `newMaxTs` is the ts THROUGH which this round applied — the manifest's
 *  `frontierTs` at the moment this round finished (see `#tickOnce`'s doc for why that, not a
 *  row-derived max, is the authoritative value here). */
export interface AppliedInvalidation {
  newMaxTs: bigint;
  /** DISTINCT storage-encoded table ids touched, derived from BOTH the applied documents' own ids
   *  AND any applied index write whose value is a live (`NonClustered`) entry — a `Deleted` index
   *  entry carries no docId to derive a table from, so it contributes nothing here (its owning
   *  document's own entry in the SAME round already does). */
  writtenTables: string[];
  /** Raw written index keys — point invalidation input, NOT yet point ranges. */
  writtenKeys: Array<{ indexId: string; key: Uint8Array }>;
  /** DISTINCT `(tableId, internalId)` pairs written this round, deduped from the applied
   *  `DocumentLogEntry` rows (one entry per doc regardless of how many revisions accompanied it).
   *  Point invalidation input for the DOCUMENT keyspace, NOT yet point ranges — same split as
   *  `writtenKeys` above. */
  writtenDocs: Array<{ tableId: string; internalId: Uint8Array }>;
}

export interface ObjectStoreReplicaTailerOptions {
  objectStore: ObjectStore;
  shard: string;
  /** The replica's materialize target. The CALLER is responsible for it existing (typically via
   *  `ObjectStoreDocStore.open()`'s bootstrap, or a bare fresh `SqliteDocStore` — see the class doc). */
  local: SqliteDocStore;
  /** Invoked once per non-empty applied round, AFTER the round has already been written to `local`.
   *  The watermark only advances after this resolves — a throwing/slow handler must not cause a
   *  round to be silently skipped on the next tick. */
  onInvalidation: (inv: AppliedInvalidation) => Promise<void>;
  /** Wall-clock poll interval for `start()`, in ms. Default 1000. */
  pollMs?: number;
}

interface Waiter {
  ts: bigint;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Poll-driven object-storage replica tailer — see the module doc for the full contract. */
export class ObjectStoreReplicaTailer {
  private readonly objectStore: ObjectStore;
  private readonly shard: string;
  private readonly local: SqliteDocStore;
  private readonly onInvalidation: (inv: AppliedInvalidation) => Promise<void>;
  private readonly pollMs: number;

  /** The highest segment seqno this tailer has itself applied (or correlated `local` to — see
   *  `#ensureInitialized`/the "nothing new" opportunistic-seed note in `#tickOnce`). `-1` means
   *  "not yet correlated to any manifest state" — the sentinel that makes `#materializeRound`'s
   *  snapshot-fallback check and tail-pull loop naturally perform a FULL catch-up (every segment,
   *  or the newest snapshot + its tail) the first time this tailer actually has new work to do,
   *  which is the correct, safe behavior for a `local` this tailer hasn't yet correlated to a
   *  known-caught-up point (re-applying already-present rows via `write(..., "Overwrite")` is an
   *  idempotent no-op on `local`'s actual state; the only cost is a possibly-oversized first
   *  invalidation batch, never a missed one). */
  private appliedSeqnoValue = -1;
  /** The ts through which `local` is known to be caught up. Lazily seeded from
   *  `local.maxTimestamp()` on the first `tick()` — see `#ensureInitialized`. */
  private appliedMaxTsValue = 0n;
  private initialized = false;

  private timer: ReturnType<typeof setInterval> | undefined;
  /** Reentrancy guard — a manual `tick()` call racing the `start()`-armed poll timer must not run
   *  two overlapping apply rounds against the same `local`/cursor state. */
  private draining = false;
  private readonly waiters = new Set<Waiter>();

  constructor(opts: ObjectStoreReplicaTailerOptions) {
    this.objectStore = opts.objectStore;
    this.shard = opts.shard;
    this.local = opts.local;
    this.onInvalidation = opts.onInvalidation;
    this.pollMs = opts.pollMs ?? 1000;
  }

  get appliedSeqno(): number {
    return this.appliedSeqnoValue;
  }

  get appliedMaxTs(): bigint {
    return this.appliedMaxTsValue;
  }

  /** Arms a `setInterval(tick, pollMs)`. Tick errors are swallowed (logged) — mirrors the fleet
   *  tailer's fire-and-forget poll posture: a transient failure must not crash the caller's process,
   *  and the NEXT tick retries from the same (unadvanced) watermark regardless. No-op if already
   *  started. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick().catch((e: unknown) => {
        console.error(`objectstore-substrate: replica tailer tick failed for shard '${this.shard}'`, e);
      });
    }, this.pollMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Resolves when `appliedMaxTs >= ts` (immediately if already true). Poll-driven: nothing here
   *  itself advances the watermark — either `start()` must be armed, or the caller must drive
   *  `tick()` itself (e.g. in a test loop). Rejects on `timeoutMs` elapsing first. */
  waitFor(ts: bigint, timeoutMs: number): Promise<void> {
    if (this.appliedMaxTsValue >= ts) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        ts,
        resolve: () => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          resolve();
        },
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            new Error(
              `ObjectStoreReplicaTailer.waitFor timed out after ${timeoutMs}ms waiting for ts >= ${ts} ` +
                `(currently at ${this.appliedMaxTsValue})`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  #wakeSatisfiedWaiters(): void {
    for (const w of [...this.waiters]) {
      if (this.appliedMaxTsValue >= w.ts) w.resolve();
    }
  }

  /** One poll round: returns `true` if anything was applied (or the watermark otherwise advanced),
   *  `false` if there was nothing new. Reentrancy-guarded (see `draining`'s doc) — a call landing
   *  while another is already in flight is a no-op `false`, not queued; the next timer tick (or the
   *  caller's own retry) picks up whatever was missed. */
  async tick(): Promise<boolean> {
    if (this.draining) return false;
    this.draining = true;
    try {
      return await this.#tickOnce();
    } finally {
      this.draining = false;
    }
  }

  /** Seeds `appliedMaxTsValue` from `local.maxTimestamp()` on the FIRST tick only — this must be
   *  lazy (not done in the constructor) because `DocStore.maxTimestamp()` is async and constructors
   *  can't await. Deliberately does NOT try to also seed `appliedSeqnoValue` here: at this point we
   *  have no manifest read yet to correlate a ts to a seqno cursor against, so `appliedSeqnoValue`
   *  stays at its conservative `-1` sentinel — `#tickOnce`'s "nothing new" branch opportunistically
   *  seeds it instead, the first time it reads a manifest whose `frontierTs` this exact
   *  `appliedMaxTsValue` already covers (see that branch's doc for why that correlation is safe). */
  async #ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.appliedMaxTsValue = await this.local.maxTimestamp();
    this.initialized = true;
  }

  async #tickOnce(): Promise<boolean> {
    await this.#ensureInitialized();

    const fresh = await readManifest(this.objectStore, this.shard);
    if (fresh === null) return false; // shard never initialized (no manifest yet) — nothing to tail
    const manifest = fresh.manifest;
    const frontierTs = BigInt(manifest.frontierTs);

    if (frontierTs <= this.appliedMaxTsValue) {
      // Nothing new since our last apply (or since `local`'s own external bootstrap, on a first
      // tick against an already-caught-up `local`). Opportunistically correlate our seqno cursor to
      // THIS manifest read if we haven't yet: we've just confirmed `local` already reflects
      // everything through `frontierTs`, i.e. through this exact manifest's `nextSeqno - 1` — so a
      // LATER tick that finds genuinely new segments only needs to pull the ones past this point,
      // not redo the whole history. Never move it BACKWARD (a later, larger correlation always wins).
      if (this.appliedSeqnoValue < manifest.nextSeqno - 1) this.appliedSeqnoValue = manifest.nextSeqno - 1;
      return false;
    }

    const round = await this.#materializeRound(manifest);
    // Authoritative ts: the FINAL manifest revision `#materializeRound` actually caught up to (it may
    // have re-read a fresher manifest mid-round on a GC race) — NOT a max derived from the applied
    // rows themselves. Mirrors `object-doc-store.ts`'s own documented divergence note: a snapshot's
    // dump excludes tombstones, so if the round's boundary commit was a delete with no tail beyond
    // it, a row-derived max could trail the true frontier. Reading it straight from the manifest we
    // just caught up to sidesteps that entirely and keeps `appliedMaxTs` — the value `tick()`'s own
    // "nothing new" check and `waitFor()` both trust — always exactly accurate.
    const newMaxTs = BigInt(round.manifest.frontierTs);

    if (round.documents.length === 0 && round.indexUpdates.length === 0) {
      // The manifest's frontier advanced but this round applied nothing new (can only happen if a
      // GC-race refresh mid-round landed us exactly back at a fully-caught-up state) — advance both
      // cursors without an invalidation call (nothing to invalidate). Safe to advance appliedSeqno
      // here too: an empty round means `#materializeRound` didn't skip delivering anything to a sink.
      this.appliedSeqnoValue = round.appliedSeqno;
      this.appliedMaxTsValue = newMaxTs;
      this.#wakeSatisfiedWaiters();
      return true;
    }

    const inv = this.#buildInvalidation(round.documents, round.indexUpdates, newMaxTs);
    await this.onInvalidation(inv);
    // Advance BOTH cursors together, ONLY after onInvalidation resolves — mirrors the fleet tailer's
    // single-`wm`-advanced-after-sink discipline. If onInvalidation throws, this line never runs and
    // BOTH appliedSeqnoValue/appliedMaxTsValue stay put: the next tick re-reads the same manifest
    // state, `#materializeRound` re-pulls the identical segments/snapshot from the still-unadvanced
    // appliedSeqnoValue, re-applies them via idempotent `write(..., "Overwrite")`, and rebuilds the
    // SAME invalidation to redeliver — no missed range, at the cost of a redundant (harmless) re-pull.
    this.appliedSeqnoValue = round.appliedSeqno;
    this.appliedMaxTsValue = newMaxTs;
    this.#wakeSatisfiedWaiters();
    return true;
  }

  /**
   * Pulls + applies everything between `this.appliedSeqnoValue` and `manifest`'s frontier, mutating
   * `local` as it goes (idempotent — a segment/snapshot already reflected in `local` is a safe
   * no-op re-`Overwrite`), and returns every row applied THIS round (for `#buildInvalidation`), the
   * final manifest revision actually reached, and the seqno cursor the round advanced to.
   *
   * Deliberately does NOT mutate `this.appliedSeqnoValue` — only `#tickOnce` may do that, and only
   * AFTER its `onInvalidation` sink resolves (see that method's doc). This method runs entirely
   * against a LOCAL `appliedSeqno` variable seeded from the instance field, so a caller that discards
   * this round's result (sink threw) leaves the instance cursor exactly where it started, and a retry
   * re-runs this same method from the same starting point — re-applying idempotently and rebuilding
   * the identical returned batch.
   *
   * Mirrors `object-doc-store.ts`'s `materializeTo` — same snapshot-restore-then-replay-tail shape —
   * with one addition `materializeTo` doesn't need: a MISSING segment (`objectStore.get` returns
   * `null`) means a lagging replica lost a race against `gc()`, which only ever deletes a segment
   * once a NEWER snapshot supersedes it. The safe recovery is therefore always available: re-read the
   * manifest (it must now reference a snapshot covering the missing seqno, or GC could not have
   * deleted it) and restart the round against that fresher manifest — looping rather than recursing,
   * so partial progress already applied (and already reflected in the local `appliedSeqno`) is never
   * discarded, and the accumulated `documents`/`indexUpdates` carry across the restart intact.
   */
  async #materializeRound(
    initialManifest: Manifest,
  ): Promise<{ documents: DocumentLogEntry[]; indexUpdates: IndexWrite[]; manifest: Manifest; appliedSeqno: number }> {
    const documents: DocumentLogEntry[] = [];
    const indexUpdates: IndexWrite[] = [];
    let manifest = initialManifest;
    let appliedSeqno = this.appliedSeqnoValue;
    let missingSegmentRetries = 0;

    for (;;) {
      // `>` (not `>=`, Finding 3, whole-branch review): when `snapshotSegBase === appliedSeqno` the
      // replica has already applied THROUGH the snapshot base — re-restoring the whole snapshot would
      // be a redundant (if idempotent) full restore instead of just replaying the tail. Also narrows
      // Finding 1's blast radius to rounds that actually jump the replica forward past the snapshot.
      if (
        manifest.snapshotTs !== undefined &&
        manifest.snapshotSegBase !== undefined &&
        manifest.snapshotSegBase > appliedSeqno
      ) {
        const snap = await readSnapshot(this.objectStore, this.shard, manifest.snapshotTs);
        if (snap === null) {
          throw new Error(
            `objectstore-substrate: replica tailer for shard '${this.shard}' — missing snapshot ` +
              `'${manifest.snapshotTs}' referenced by the manifest (torn state)`,
          );
        }

        // Finding 1 (CRITICAL, whole-branch review): `write(..., "Overwrite")` is an OVERLAY
        // (INSERT OR REPLACE), never a replace-all, and `dumpCurrentState` (the snapshot's own
        // source) EXCLUDES tombstones — so the snapshot alone cannot express "this doc was deleted
        // in the range this restore jumps over." Left unhandled, a doc the replica still has LIVE
        // that the snapshot silently dropped stays phantom-live on the replica forever, and
        // `#buildInvalidation` (deriving `writtenDocs` from `snap.documents`, which never mentions
        // it) would emit no invalidation for it either.
        //
        // Fix: diff the replica's OWN current live docs against the snapshot's live-doc set and
        // APPEND a tombstone for anything the snapshot dropped, at the snapshot's own frontier ts
        // (>= every existing replica revision, since the replica is BEHIND the snapshot whenever
        // this branch runs) — append-only, so a concurrent MVCC read against `local` never sees rows
        // physically disappear mid-restore. Do NOT truncate the store to fake a "fresh" restore.
        const snapshotIds = new Set(snap.documents.map((d) => this.#docKey(d.id)));
        const replicaState = await this.local.dumpCurrentState();
        const deleted = replicaState.documents.filter((d) => !snapshotIds.has(this.#docKey(d.id)));
        if (deleted.length > 0) {
          const frontierTs = BigInt(snap.frontierTs);
          const tombstones: DocumentLogEntry[] = deleted.map((d) => ({
            ts: frontierTs,
            id: d.id,
            value: null,
            prev_ts: d.ts,
          }));
          await this.local.write(tombstones, [], "Overwrite");
          // Fold the tombstones into this round's `documents` too — NOT just applied to `local` —
          // so `#buildInvalidation`'s `writtenDocs` covers the deletion and a `db.get(id)`
          // subscription on the deleted doc actually re-runs.
          documents.push(...tombstones);
        }

        await this.local.write(snap.documents, snap.indexUpdates, "Overwrite");
        documents.push(...snap.documents);
        indexUpdates.push(...snap.indexUpdates);
        appliedSeqno = manifest.snapshotSegBase;
      }

      let missedSegment = false;
      for (const seqno of manifest.segments) {
        if (seqno <= appliedSeqno) continue; // already applied (or covered by the snapshot just restored)
        const entry = await this.objectStore.get(segmentKey(this.shard, seqno));
        if (entry === null) {
          // Raced GC — fall back to the snapshot path against a FRESH manifest read and restart.
          // Bounded (Finding 4, whole-branch review): the shipped strongly-consistent adapters
          // (fs/S3) converge in one or two restarts; this cap turns a hypothetically
          // eventually-consistent store's non-convergence into a loud error, not an infinite spin.
          if (++missingSegmentRetries > MAX_MISSING_SEGMENT_RETRIES) {
            throw new Error(
              `objectstore-substrate: replica tailer for shard '${this.shard}' — missing segment ` +
                `'${segmentKey(this.shard, seqno)}' did not resolve via snapshot fallback after ` +
                `${MAX_MISSING_SEGMENT_RETRIES} retries`,
            );
          }
          const refreshed = await readManifest(this.objectStore, this.shard);
          if (refreshed === null) {
            throw new Error(
              `objectstore-substrate: replica tailer for shard '${this.shard}' — manifest disappeared mid-round`,
            );
          }
          manifest = refreshed.manifest;
          missedSegment = true;
          break; // restart the outer loop against `manifest` (re-checks the snapshot-fallback condition)
        }
        const payload = decodeSegment(entry.body);
        await this.local.write(payload.documents, payload.indexUpdates, "Overwrite");
        documents.push(...payload.documents);
        indexUpdates.push(...payload.indexUpdates);
        appliedSeqno = seqno;
      }
      if (!missedSegment) return { documents, indexUpdates, manifest, appliedSeqno };
    }
  }

  /** `${tableId}|${internalIdHex}` — the doc-identity key both `#buildInvalidation`'s dedupe and
   *  `#materializeRound`'s snapshot-restore diff (Finding 1) use to compare doc ids across two
   *  differently-sourced document sets (segment/snapshot rows vs. `dumpCurrentState`'s rows). */
  #docKey(id: InternalDocumentId): string {
    return `${encodeStorageTableId(id.tableNumber)}|${internalIdToHex(id.internalId)}`;
  }

  /** Builds the round's `AppliedInvalidation` — mirrors the fleet tailer's derivation
   *  (`replica-tailer.ts` ~:476-488): `writtenDocs` DISTINCT-deduped by `(tableId, internalId)` from
   *  the applied documents, `writtenKeys` straight from the applied index writes, `writtenTables`
   *  DISTINCT across both sources. */
  #buildInvalidation(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    newMaxTs: bigint,
  ): AppliedInvalidation {
    const tables = new Set<string>();
    const seenDocs = new Set<string>();
    const writtenDocs: Array<{ tableId: string; internalId: Uint8Array }> = [];
    for (const d of documents) {
      const tableId = encodeStorageTableId(d.id.tableNumber);
      tables.add(tableId);
      const dedupeKey = this.#docKey(d.id);
      if (seenDocs.has(dedupeKey)) continue;
      seenDocs.add(dedupeKey);
      writtenDocs.push({ tableId, internalId: d.id.internalId });
    }

    const writtenKeys = indexUpdates.map((w) => ({ indexId: w.update.indexId, key: w.update.key }));
    for (const w of indexUpdates) {
      if (w.update.value.type === "NonClustered") tables.add(encodeStorageTableId(w.update.value.docId.tableNumber));
    }

    return { newMaxTs, writtenTables: [...tables], writtenKeys, writtenDocs };
  }
}
