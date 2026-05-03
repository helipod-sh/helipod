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
 * review C1): the cached cursor is then untrustworthy. `putImmutable` is KEEP-FIRST on every adapter
 * (fs/memory/s3 — s3 via a create-only `IfNoneMatch: "*"` conditional PUT, Tier 3 Slice 4 review), so a
 * reused segment seqno can never overwrite a durable, manifest-referenced segment written by someone
 * else — it silently no-ops and the writer's OWN manifest CAS fails separately on its stale etag. Poison
 * is therefore not a corruption guard against overwriting live data (there is no such hazard left); it's
 * the correct response to an untrustworthy cached cursor after any CAS failure. Recovery = re-open
 * (re-bootstrap).
 *
 * OWNERSHIP (Tier 3 Slice 4, Task 4.2): `open()` only MATERIALIZES — it bootstraps `local` from the
 * bucket (snapshot + tail replay) but claims NO ownership. A writer must additionally `acquire()`
 * before it may commit; a replica (Slice 5) opens without ever acquiring. `acquire({writerId,
 * leaseTtlMs, now})` re-reads the manifest fresh, refuses if a DIFFERENT writer's lease is still live,
 * else catches this instance's local store up to the manifest frontier (`materializeTo` — the same
 * primitive `open()` bootstraps with) and CAS-bumps `epoch` to claim the lease — the epoch bump is
 * what fences any prior owner's cached etag. `heartbeat({now, leaseTtlMs})` CAS-renews
 * `leaseExpiresAt` alone (epoch/writerId unchanged); ANY heartbeat CAS failure means a challenger
 * fenced this instance — it poisons and throws `FencedError`. `commitWriteBatch` now REQUIRES a held
 * lease (throws before the poisoned check if `acquire()` was never called) and additionally asserts
 * its cached epoch still matches the held epoch before every CAS — defense in depth against serving a
 * commit after having been silently fenced.
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
 * - **Fence/failure paths are exercised at the substrate level only on `objectstore-fs`** (keep-first
 *   `putImmutable`, same as every adapter now — `objectstore-s3` was fixed to keep-first too, Tier 3
 *   Slice 4 review, closing the overwrite hazard this note used to describe). The `objectstore-s3`
 *   package's OWN conformance suite (run against real MinIO under `STACKBASE_OBJECTSTORE_S3=1`) proves
 *   the keep-first invariant on S3 directly; a MinIO-gated fence/failure variant AT THIS SUBSTRATE LEVEL
 *   (as opposed to a bare adapter conformance check) is still a nice-to-have for the failover slice, not
 *   a correctness gap — the adapter-level guarantee is what the fence's safety actually rests on.
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
import { readConsumerWatermarks } from "./consumers";
import { applySnapshotState } from "./apply-snapshot";

/** Exported (Tier 3 Slice 5, Task 5.1) so `replica-tailer.ts` can pull the SAME segment objects this
 *  class's own commit/`materializeTo` path writes/reads, without duplicating the key format. */
export function segmentKey(shard: string, seqno: number): string {
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
  /** The next free segment seqno for THIS process — advanced by one on every successful commit CAS
   *  (dense in the common case), AND durably burned forward by one extra on every successful
   *  TAKEOVER `acquire()` (Task 4.6, superseding the earlier in-process-only skip-one of Task 4.5 —
   *  see `acquire()`'s doc) to fence out the seqno the immediate predecessor may have orphaned. The
   *  burn lives in the DURABLE `manifest.nextSeqno` itself (not just this in-process field) so it
   *  survives across a CHAIN of stalled takeovers with no successful commit in between — see
   *  `acquire()`. Non-dense-by-one-per-takeover is expected and harmless: never read as `[0..n]` —
   *  `materializeTo`/GC always iterate the manifest's own explicit `segments`/`nextSeqno` fields. */
  private nextSeqno: number;
  /** Set when a post-CAS local apply fails: the commit is durable but the local materialization is
   *  inconsistent, so further commits are refused until the store is re-opened (re-bootstrapped). */
  private poisoned = false;
  /** The lease this instance currently holds (Tier 3 Slice 4), or `null` if it has never
   *  `acquire()`'d (or was fenced — see `heartbeat`/`commitWriteBatch`). `commitWriteBatch` refuses to
   *  run without this set; `epoch` is the CAS-bumped value `acquire()` claimed, checked against
   *  `this.cached.manifest.epoch` before every commit as a defense-in-depth fence check. */
  private held: { epoch: number; writerId: string } | null = null;
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
   * BOOTSTRAP (materialize) the local store — via `materializeTo`, see its doc for the snapshot +
   * tail-replay algorithm. This claims NO ownership (Tier 3 Slice 4): a writer must additionally
   * `acquire()` before it may commit; a replica (Slice 5) opens without ever acquiring. A fresh
   * (empty) bucket bootstraps to an empty local store; a bucket with prior commits reconstructs the
   * IDENTICAL current state either way.
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

    // Construct with `nextSeqno: 0` (a fresh `local` has applied nothing yet) and let `materializeTo`
    // do the actual bootstrap work — the SAME primitive `acquire()` uses to catch a re-acquiring
    // instance up to the manifest frontier (Tier 3 Slice 4, Task 4.2 — factored out for that reuse).
    const store = new ObjectStoreDocStore(objectStore, shard, local, cached, 0);
    await store.materializeTo(cached.manifest);
    return store;
  }

  /**
   * Materialize `this.local`/`this.nextSeqno` up to `manifest`'s frontier by applying whatever this
   * instance hasn't already applied: if `manifest` references a snapshot this instance hasn't yet
   * covered (`snapshotSegBase` at or beyond `this.nextSeqno`), restore it first
   * (`write(..., "Overwrite")` of its current-state dump), then replay every remaining referenced
   * segment in order via the same explicit-ts `write(..., "Overwrite")` path — the identical primitive
   * a post-CAS commit applies with, and the one a replica tailer would use (design record §7).
   *
   * Two callers: `open()` on a brand-new instance (`this.nextSeqno === 0`, so this is a full
   * bootstrap — snapshot-if-any + every segment), and `acquire()` on an ALREADY-materialized instance
   * that may be behind the CURRENT manifest (a re-acquiring/challenging writer) — in that case
   * skipping already-applied segments (and skipping a snapshot restore if this instance is already
   * past its `segBase`) matters both for correctness (never double-apply, though `Overwrite` is
   * idempotent) and so a challenger that's only slightly behind doesn't needlessly re-read a snapshot
   * object. Restoring the snapshot when we're behind it is also what makes catch-up correct even if
   * the fencing owner's `gc()` has since deleted the pre-snapshot segments we'd otherwise be missing.
   *
   * Not gated on `runExclusive` itself — both callers already hold it.
   */
  private async materializeTo(manifest: Manifest): Promise<void> {
    let appliedThrough = this.nextSeqno - 1; // highest seqno already applied locally (-1 if none)

    if (manifest.snapshotTs !== undefined && manifest.snapshotSegBase !== undefined && manifest.snapshotSegBase > appliedThrough) {
      const snap = await readSnapshot(this.objectStore, this.shard, manifest.snapshotTs);
      if (snap === null) {
        throw new Error(
          `objectstore-substrate: missing snapshot '${manifest.snapshotTs}' referenced by manifest for shard '${this.shard}' (torn state)`,
        );
      }
      // TOMBSTONE-CORRECT RESTORE (Slice 5 re-review fix): this instance's `local` may be NON-EMPTY
      // and STALE here — `open()` always calls this against a fresh, empty local (safe either way),
      // but `acquire()`'s takeover catch-up calls it against an ALREADY-OPEN, possibly-behind writer
      // instance. A snapshot's own `dumpCurrentState` source excludes tombstones, so applying
      // `snap.documents` alone (an overlay `write(..., "Overwrite")`, never a replace-all) cannot
      // express "this doc was deleted in the range this restore jumps over" — a doc `local` still
      // has LIVE that the snapshot silently dropped would otherwise stay phantom-live and could be
      // RE-COMMITTED by this writer, permanently undoing the delete in the durable log. The shared
      // `applySnapshotState` helper (also used by the replica tailer's `#materializeRound` — see its
      // doc for the full diff+tombstone rationale) diffs+tombstones before applying. On the common
      // fresh-`open()` path `local` is empty, so the diff is a no-op — byte-identical to before this
      // fix. This method has no invalidation sink to feed (the writer's own transactor/tailer own
      // reactivity, not catch-up), so the returned `deletedDocs` are ignored here.
      //
      // BENIGN DIVERGENCE (whole-branch review, Minor #2, carried from the original open()): `dumpCurrentState`
      // (and so this restore) excludes tombstones, so if `snap.frontierTs` is itself a DELETE's ts and
      // there's no tail beyond this snapshot, the restored `documents` table has no row AT that ts — the
      // local store's `maxTimestamp()` (`MAX(ts) FROM documents`) then TRAILS `manifest.frontierTs`. This
      // is SAFE for commit-ts correctness: `commitWriteBatch`'s floor is `max(tsCounter, localMax)` and
      // `tsCounter == frontierTs` here, so no ts is ever reused or regressed. But it means
      // `DocStore.maxTimestamp()`'s "highest committed timestamp" contract can diverge post-restore — a
      // consumer needing the AUTHORITATIVE frontier must read the manifest (`frontierTs`), not call
      // `local.maxTimestamp()`. Not fixed here (seeding a fake tombstone row just to keep `maxTimestamp()`
      // honest is worse than documenting the divergence).
      await applySnapshotState(this.local, snap, BigInt(snap.frontierTs));
      appliedThrough = manifest.snapshotSegBase;
    }

    for (const seqno of manifest.segments) {
      if (seqno <= appliedThrough) continue; // already applied (or covered by the snapshot just restored)
      const entry = await this.objectStore.get(segmentKey(this.shard, seqno));
      if (entry === null) {
        throw new Error(`objectstore-substrate: missing segment '${segmentKey(this.shard, seqno)}' referenced by manifest for shard '${this.shard}'`);
      }
      const payload = decodeSegment(entry.body);
      await this.local.write(payload.documents, payload.indexUpdates, "Overwrite");
      appliedThrough = seqno;
    }

    // Read the explicit `nextSeqno` cursor (whole-branch review, Task 3.3 fix) — NEVER derive it from
    // `segments` via `Math.max(...)`: once `snapshot()` trims `segments` to the post-snapshot tail, a
    // snapshot-covers-everything bootstrap (empty tail) would otherwise compute 0 instead of the true
    // cursor, and even pre-trim, `Math.max(...segments)` argument-spreads the WHOLE array onto the
    // call stack and throws `RangeError: Maximum call stack size exceeded` past ~100k segments.
    this.nextSeqno = manifest.nextSeqno;
  }

  /**
   * Claim ownership of this shard for `opts.writerId` (Tier 3 Slice 4, Task 4.2) — the manifest CAS
   * IS the fence: a successful acquire bumps `epoch`, which invalidates any prior owner's cached
   * etag, so its next `commitWriteBatch`/`heartbeat` fails loudly (`FencedError` + poison).
   *
   * Re-reads the manifest FRESH (not `this.cached` — this instance may be stale or may never have
   * committed before). If the lease is currently LIVE and held by a DIFFERENT writer
   * (`now <= leaseExpiresAt`), refuses: `{acquired: false, heldBy, expiresAt}` — this is what
   * prevents two live writers ping-ponging (a heartbeating owner's lease never expires). Otherwise
   * (unowned, or the current lease is EXPIRED, or `opts.writerId` already owns it and is re-claiming)
   * catches this instance's local store up to the just-read manifest via `materializeTo` — REQUIRED so
   * a challenger that was behind (or a fresh instance that only `open()`'d) is fully materialized to
   * the manifest's frontier BEFORE it starts committing under the claimed lease — then CAS-bumps
   * `epoch` and stamps `writerId`/`leaseExpiresAt`.
   *
   * A `CasConflict` (lost the acquire race to a concurrent challenger) re-reads and returns
   * `{acquired: false, ...}` — the caller may retry. Any OTHER `casManifest` failure is ambiguous
   * (may have landed despite throwing — same lost-response concern as the commit path's C1 fix) and
   * poisons this instance exactly like a commit/heartbeat CAS failure does (global constraint: lease
   * CAS failures poison like commit CAS failures).
   */
  async acquire(
    opts: { writerId: string; leaseTtlMs: number; now: number },
  ): Promise<{ acquired: true } | { acquired: false; heldBy: string; expiresAt: number }> {
    return this.runExclusive(async () => {
      const fresh = await readManifest(this.objectStore, this.shard);
      if (fresh === null) {
        throw new Error(`objectstore-substrate: acquire() found no manifest for shard '${this.shard}' — open() must initialize it first`);
      }
      const { manifest, etag } = fresh;

      if (manifest.writerId !== "" && opts.now <= Number(manifest.leaseExpiresAt) && manifest.writerId !== opts.writerId) {
        return { acquired: false as const, heldBy: manifest.writerId, expiresAt: Number(manifest.leaseExpiresAt) };
      }

      await this.materializeTo(manifest);

      // DURABLE-BURN-ON-ACQUIRE (Task 4.6, superseding Task 4.5's in-process-only skip-one — see the
      // re-review that found it insufficient): a predecessor we're about to fence may have
      // `putImmutable`'d a segment at EXACTLY `manifest.nextSeqno` (its in-flight commit's object PUT)
      // and then stalled/crashed BEFORE its own `casManifest` — that segment is a durable but
      // UNREFERENCED orphan, never covered by `materializeTo` above (it only replays
      // `manifest.segments`). Because `commitWriteBatch` writes EXACTLY ONE segment per flush (the
      // invariant documented at its `putImmutable` call site below), a fenced writer can have orphaned
      // AT MOST ONE seqno — the one it would have referenced next. If a taking-over writer's first
      // commit reused that same seqno, its `putImmutable` would silently no-op (keep-first) against
      // the orphan's bytes while its manifest CAS still succeeds (referencing a segment that holds the
      // OLD writer's data, not the new writer's) — an acknowledged write silently lost.
      //
      // Task 4.5's original fix only advanced THIS PROCESS's in-memory `nextSeqno`, leaving the
      // DURABLE `manifest.nextSeqno` untouched — correct for exactly one stalled predecessor, but a
      // CHAIN of ≥2 writers that each stall BEFORE their own commit CAS (a correlated object-store
      // outage — precisely the failover trigger) each re-read the SAME unmoved durable cursor and
      // recompute the SAME target seqno, so generation N+2 can collide with generation N+1's orphan.
      // The fix: fold the burn into THIS claim CAS so it moves the DURABLE cursor on EVERY takeover,
      // not just this process's view of it — `manifest.nextSeqno` becomes a monotone cursor advanced
      // by BOTH a successful commit AND every takeover-acquire, so no live writer ever targets a seqno
      // a prior generation may have written, no matter how many generations stalled in a row.
      //
      // GATED on `manifest.epoch > 0` (the PRE-bump value just read, i.e. "has anyone EVER held this
      // shard's lease before"): a commit can only exist/stall if someone previously held the lease
      // (`commitWriteBatch` requires `this.held`, which only ever comes from a prior successful
      // `acquire()`), so on the FIRST-EVER acquire of a brand-new manifest (`epoch === 0`, `nextSeqno
      // === 0`) there is provably no predecessor and nothing to burn — every commit lands densely
      // from `seg/0`, matching every pre-Slice-4.5 test's assumption. Every acquire AFTER that first
      // one (a genuine takeover OR the same writer's own re-acquire, e.g. after a poisoning event) DID
      // have a predecessor that could have stalled mid-commit, so it always burns — regardless of
      // whether `opts.writerId` matches the previous owner, since a crash-and-restart can resume under
      // the identical writerId.
      const burn = manifest.epoch > 0;
      const next: Manifest = {
        ...manifest,
        epoch: manifest.epoch + 1,
        writerId: opts.writerId,
        leaseExpiresAt: String(opts.now + opts.leaseTtlMs),
        nextSeqno: burn ? manifest.nextSeqno + 1 : manifest.nextSeqno,
      };
      try {
        const { etag: newEtag } = await casManifest(this.objectStore, this.shard, next, etag);
        this.cached = { manifest: next, etag: newEtag };
        this.held = { epoch: next.epoch, writerId: opts.writerId };
        this.poisoned = false;
        // The durable cursor is already correctly advanced (or not) by `next.nextSeqno` above — just
        // adopt it. Segments become non-dense by one integer per takeover (harmless: bootstrap/GC
        // iterate the explicit `manifest.segments` array and read `manifest.nextSeqno` directly, never
        // assume `[0..n]` density — see `materializeTo`'s doc).
        this.nextSeqno = next.nextSeqno;
        return { acquired: true as const };
      } catch (e) {
        if (!isCasConflict(e)) {
          this.poisoned = true;
          throw e;
        }
        // A lost acquire race (CasConflict) is an EXPECTED, retryable outcome — a concurrent
        // challenger simply won first. Do NOT poison: `this.held`/`this.cached` are untouched (this
        // instance never claimed anything), so it remains exactly as usable as before the attempt.
        const reread = await readManifest(this.objectStore, this.shard);
        if (reread === null) throw e;
        return { acquired: false as const, heldBy: reread.manifest.writerId, expiresAt: Number(reread.manifest.leaseExpiresAt) };
      }
    });
  }

  /**
   * Renew the currently-held lease's `leaseExpiresAt` (Tier 3 Slice 4, Task 4.2) — `epoch`/`writerId`
   * are carried forward UNCHANGED (a heartbeat is not a re-claim). Requires `this.held` (throws a
   * clear error if `acquire()` was never called) and refuses on an already-`poisoned` instance.
   *
   * ANY `casManifest` failure means the manifest moved out from under this instance — a challenger
   * bumped `epoch` (fenced us) or is mid-fence — so this ALWAYS poisons and throws `FencedError`,
   * unlike the commit path's CasConflict-vs-ambiguous-error distinction: a heartbeat's whole job is to
   * detect exactly this condition, so there is no "retry" case to special-case.
   */
  async heartbeat(opts: { now: number; leaseTtlMs: number }): Promise<void> {
    return this.runExclusive(async () => {
      // Both branches below throw `FencedError`, not a bare `Error`: the heartbeat driver is only
      // ever started AFTER a successful `acquire()`, so seeing `held === null` or `poisoned` DURING
      // operation means ownership was already lost by some other path — most commonly `commitWriteBatch`'s
      // own CAS-fail branch, which sets `poisoned = true; held = null` and throws `FencedError` to the
      // TRANSACTOR, never to this heartbeat. If heartbeat instead threw a plain `Error` here, the
      // heartbeat driver (which only treats `instanceof FencedError` as terminal) would misclassify a
      // commit-path fence as a transient heartbeat hiccup and re-arm forever — a zombie node that
      // rejects every write but never calls `onFenced`/stops. See the Slice 6 Task 6.2 review finding.
      if (this.held === null) {
        throw new FencedError(
          `heartbeat on a store with no held lease for shard '${this.shard}' — ownership is lost (never acquired or already fenced)`,
        );
      }
      if (this.poisoned) {
        throw new FencedError(
          `heartbeat on a poisoned store for shard '${this.shard}' (fenced or a prior apply failed) — ownership is lost`,
        );
      }
      const next: Manifest = { ...this.cached.manifest, leaseExpiresAt: String(opts.now + opts.leaseTtlMs) };
      try {
        const { etag } = await casManifest(this.objectStore, this.shard, next, this.cached.etag);
        this.cached = { manifest: next, etag };
      } catch (e) {
        this.poisoned = true;
        this.held = null;
        throw new FencedError(
          `heartbeat fenced: manifest for shard '${this.shard}' moved (stale etag) — this writer is no longer current and is now poisoned ` +
            `(re-acquire to continue). Cause: ${(e as Error)?.message ?? String(e)}`,
        );
      }
    });
  }

  /** Voluntarily give up the held lease WITHOUT touching the bucket — the lease simply expires on its
   *  own at `leaseExpiresAt` (Tier 3 Slice 4, Task 4.2). After this, `commitWriteBatch` refuses until
   *  a fresh `acquire()`. IN-PROCESS ONLY: a challenger's `acquire()` still has to wait out the full
   *  remaining TTL, since nothing in the bucket changed. See `relinquish()` — the graceful-shutdown
   *  variant that ALSO clears the lease in the bucket itself, so a challenger can take over
   *  immediately instead of waiting for expiry (Tier 3 Slice 6, Task 6.5). */
  release(): void {
    this.held = null;
  }

  /**
   * Graceful-shutdown variant of `release()` (Tier 3 Slice 6, Task 6.5): best-effort CAS the manifest
   * to clear the lease (`writerId: "", leaseExpiresAt: "0"`) so a challenger's very next `acquire()`
   * — even at `now: 0` — sees an unowned/already-expired lease and takes over IMMEDIATELY, instead of
   * having to wait out this writer's full remaining `leaseTtlMs`. This closes the production gap the
   * Task 6.4 review found: every graceful rolling-deploy stop/start pair otherwise ate a full-TTL
   * write outage.
   *
   * Deliberately best-effort: a CAS failure here means either (a) we were already fenced — someone
   * else owns the shard now, which is exactly the state we wanted anyway, or (b) a transient blip —
   * the lease still expires naturally, falling back to the pre-6.5 behavior. Neither case should
   * block or fail a clean shutdown, so any CAS error is swallowed. Does NOT bump `epoch` — clearing
   * `writerId`/`leaseExpiresAt` is sufficient for a challenger's refusal check to pass trivially; the
   * challenger's own `acquire()` bumps `epoch` and fences any stale in-process state on ITS claim, the
   * same as an expiry-based takeover always has. Does NOT poison on a swallowed CAS failure — this is
   * a clean voluntary exit, not a fence.
   *
   * Runs under `runExclusive` (serializes with commits/heartbeat/acquire, same as every other
   * lease/commit operation on this instance). A no-op if this instance never held the lease
   * (`this.held === null` — already fenced, or `acquire()` was never called): nothing to relinquish.
   * Always demotes `this.held` to `null` at the end, regardless of the CAS outcome.
   */
  async relinquish(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.held === null) return; // nothing held — already fenced, or never acquired
      const next: Manifest = { ...this.cached.manifest, writerId: "", leaseExpiresAt: "0" };
      try {
        const { etag } = await casManifest(this.objectStore, this.shard, next, this.cached.etag);
        this.cached = { manifest: next, etag };
      } catch {
        // Swallowed by design — see doc comment above: a clean shutdown must never throw, and a CAS
        // failure here is either "someone already fenced us" (fine) or "transient" (falls back to
        // natural TTL expiry).
      }
      this.held = null;
    });
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
      // Tier 3 Slice 4, Task 4.2: commits REQUIRE a held lease — checked BEFORE the poisoned check
      // (and before the empty-batch no-op) so a caller can never commit, not even a no-op, without
      // having `acquire()`'d first.
      if (this.held === null) {
        throw new Error(`ObjectStoreDocStore for shard '${this.shard}': not the lease owner — call acquire() before committing`);
      }
      // Empty batch is a no-op (matches SqliteDocStore.commitWriteBatch) — never write an empty segment.
      if (units.length === 0) return [];
      if (this.poisoned) {
        throw new Error(
          `ObjectStoreDocStore for shard '${this.shard}' is poisoned (a prior post-commit local apply failed); it must be re-opened before further use`,
        );
      }
      // Defense in depth (Task 4.2): the cached manifest's epoch must still match the epoch this
      // instance claimed via `acquire()`. It can only diverge if another `acquire()` on this SAME
      // instance somehow changed `this.held` without updating `this.cached` to match (not possible in
      // the current code paths) OR — the real case — a bug elsewhere let a commit slip through after a
      // fence that `casManifest` itself hasn't yet been given the chance to reject. Either way, a
      // divergence here means we can no longer trust our own bookkeeping enough to attempt the CAS.
      if (this.cached.manifest.epoch !== this.held.epoch) {
        this.poisoned = true;
        throw new FencedError(
          `commit fenced: shard '${this.shard}' cached epoch (${this.cached.manifest.epoch}) diverges from the held lease epoch ` +
            `(${this.held.epoch}) — this writer was fenced by another acquirer and is now poisoned (re-acquire to continue)`,
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
      // INVARIANT (load-bearing for `acquire()`'s durable-burn-on-acquire fence, Task 4.6/4.5): this
      // flush writes EXACTLY ONE segment (one `putImmutable`, one `seqno`). That is what bounds a
      // fenced-mid-commit writer to AT MOST ONE orphaned seqno per takeover — the one it would have
      // referenced here — which is what makes "burn exactly one seqno per takeover" airtight for
      // arbitrarily long chains of stalled generations. A future change to batch a flush across
      // MULTIPLE segments (multiple `putImmutable`s / multiple seqnos per `commitWriteBatch` call)
      // would let a mid-flush crash orphan more than one, and MUST revisit `acquire()`'s burn
      // accordingly. Group commit (multiple `CommitUnit`s coalesced into this one call) is fine as-is
      // — it's still one segment.
      await this.objectStore.putImmutable(segmentKey(this.shard, seqno), encodeSegment(payload));

      // Spread `this.cached.manifest` FIRST so `snapshotTs`/`snapshotSegBase` (Task 3.2) and
      // `writerId`/`leaseExpiresAt` (Task 4.2 — a commit is not a lease renewal, only `heartbeat` is)
      // carry forward untouched — then override the fields this commit actually advances. `epoch` is
      // set EXPLICITLY from `this.held.epoch` (equal to `this.cached.manifest.epoch` per the assert
      // above, but explicit here as the defense-in-depth belt to that assert's suspenders) rather than
      // left to the spread, so this commit can never accidentally carry a stale epoch forward.
      const next: Manifest = {
        ...this.cached.manifest,
        epoch: this.held.epoch,
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
        // instance would reuse `seqno` against a stale cursor.
        //
        // CORRECTED (Tier 3 Slice 4, Task 4.2 review): `putImmutable` is KEEP-FIRST on every adapter,
        // including S3 (via a create-only `IfNoneMatch: "*"` conditional PUT — see `objectstore-s3`'s
        // `putImmutable`). So this just-PUT `seg/${seqno}` can NEVER overwrite a live, manifest-
        // referenced segment written by whoever actually holds the frontier at that seqno — if a
        // concurrent/challenging writer already committed a DIFFERENT segment at this seqno, our PUT is
        // silently dropped (their bytes win) and OUR manifest CAS below still fails on its own stale
        // etag. The durable log is therefore safe FROM THAT DIRECTION by construction; poisoning here is
        // not a corruption guard against overwrite (there is no such hazard for `seg/${seqno}` itself)
        // but simply the correct response to an untrustworthy cursor after ANY CAS failure — the
        // instance must be RE-OPENED (re-bootstrapped from the true manifest), which resyncs
        // `cached`/`nextSeqno`.
        //
        // REVERSE DIRECTION (whole-branch review, Finding 1, Task 4.5, robustified Task 4.6): the
        // just-PUT `seg/${seqno}` is NOT simply "an unreferenced orphan of our own, harmless to leave
        // behind" — if THIS writer is in fact the one being fenced right now (a challenger's
        // `acquire()` just won), that orphan sits at exactly the seqno the challenger's manifest still
        // points at as `nextSeqno`. Keep-first means the challenger's own first commit could otherwise
        // reuse this seqno, have ITS `putImmutable` silently no-op against OUR bytes, and CAS a
        // manifest that references a segment holding OUR (failed) data instead of theirs — an
        // acknowledged write lost. What makes this safe, even across a CHAIN of such stalled
        // generations, is `acquire()`'s durable-burn-on-acquire fence (see its doc comment): every
        // takeover durably advances `manifest.nextSeqno` past the seqno a just-fenced predecessor could
        // have dirtied, so no later generation ever reuses this key. Reclaiming the orphan itself is
        // still GC's concern, not a correctness one.
        this.poisoned = true;
        if (isCasConflict(e)) {
          // Symmetric with `heartbeat()`'s fence path (Finding 2, whole-branch review, Task 4.5): a
          // confirmed fence (not merely an ambiguous error) means this instance is definitively no
          // longer the lease owner — clear `held` too, not just `poisoned`, so the asymmetry can't
          // become a latent trap if some future code path ever checked `held` before `poisoned`.
          // Harmless today (`poisoned` alone already blocks every further commit).
          this.held = null;
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
   * Reclaim durable objects the CURRENT manifest's snapshot (and every registered consumer's
   * watermark) has superseded: every segment with `seqno <= min(snapshotSegBase, W_min)` (where
   * `W_min` is the SLOWEST published `s{shard}/consumers/{id}` watermark's `appliedSeqno` — `+Infinity` when
   * no consumers are registered, so the floor collapses back to plain `snapshotSegBase`, byte-for-
   * byte the Slice 3 behavior) and every snapshot object except the current one (`snapshotTs`) — the
   * newest snapshot is always kept regardless of `W_min` (a replica re-materializing after falling
   * behind the tail restores the NEWEST snapshot via `materializeTo`'s fallback path, never an older
   * one, so keeping only the newest is correct independent of any watermark).
   *
   * The watermark floor is the Tier 3 Slice 5, Task 5.2 addition (closing the Slice 3/4 GC-under-
   * replicas deferral): a lagging replica's `ObjectStoreReplicaTailer` publishes its own
   * `appliedSeqno` via `publishConsumerWatermark`; as long as it hasn't fallen behind
   * `snapshotSegBase` itself (its own snapshot-fallback backstop covers that case — see
   * `replica-tailer.ts`), `gc()` here will never delete a segment `(W_min, snapshotSegBase]` that
   * replica still needs to tail.
   *
   * Runs under `runExclusive` — it must not race a concurrent commit/snapshot/acquire on THIS
   * instance. Never touches the manifest itself or `this.cached`/`nextSeqno` (beyond adopting a
   * freshly re-read manifest when the epoch check below passes) — GC is purely subtractive over
   * objects the manifest (and consumers) no longer need.
   *
   * PERFORMANCE NOTE (whole-branch review, Minor #4): because it runs under `runExclusive`, `gc()`
   * blocks `commitWriteBatch`/`snapshot()` on this instance for the ENTIRE list+delete sweep (now
   * also a `consumers/` list+get sweep) — fine for a manual, occasional, single-node call, but revisit
   * the locking granularity if GC's cadence ever needs to tighten.
   *
   * GC-FENCING (Tier 3 Slice 7, Task 7.1 — closes the Slice-4/5/6 deferral above): `gc()` used to
   * trust `this.cached.manifest` — a snapshot pointer that can be ARBITRARILY STALE the instant a
   * challenger fences this writer (bumps `epoch`) without this instance having attempted a
   * commit/heartbeat since. A stale writer's cached `snapshotTs` then names an OLD snapshot, and the
   * pre-Slice-7 "delete every `snap/*` except my cached `snapshotTs`" predicate would delete the NEW
   * owner's live snapshot — sinking that owner's next bootstrap. Fixed by two changes, in order:
   *   1. `this.held === null` (never an owner — a replica, or an already-demoted/fenced writer) is a
   *      harmless no-op: never GC.
   *   2. RE-READ the manifest fresh (never trust `this.cached`) and compare its `epoch` against
   *      `this.held.epoch`. A mismatch means a challenger's `acquire()` landed since we last knew —
   *      we've been fenced RIGHT NOW, even though nothing told us yet — so we poison + demote and
   *      delete NOTHING. Only once the epoch matches do we adopt the fresh manifest as current truth
   *      and compute the delete floor/keepSnap FROM IT (never from a value read before this check).
   * This closes the TOCTOU window at the READ side, but a fence could still land in the gap BETWEEN
   * this re-read and the deletes below (the sweep isn't atomic with the epoch check) — so the delete
   * PREDICATES themselves must independently tolerate a same-gap fence:
   *   - Segments: `seqno <= floor` (unchanged) — a new owner's commits only ever land at HIGHER
   *     seqnos than the frontier this floor was computed from, so this predicate can never reach one.
   *   - Snapshots: **`BigInt(ts) < BigInt(keepSnap)`** (strictly older), not "every snapshot except
   *     keepSnap" — a new owner racing a snapshot into the gap produces a `ts` NEWER than our
   *     `keepSnap` (ts's are monotone `frontierTs` values), which `<` by construction never matches.
   *     `keepSnap` itself is also never deleted (not `<` itself). Compared as `bigint`, not string —
   *     ts's are decimal-string bigints, and a naive string compare orders `"9"` after `"10"`.
   * Together: a fenced/stale writer's `gc()` deletes nothing (the epoch check catches the common case,
   * and the TOCTOU-safe predicates catch the rest), while the happy-path owner's behavior is unchanged
   * (its own re-read always matches its own held epoch).
   */
  async gc(): Promise<{ deletedSegments: number; deletedSnapshots: number }> {
    return this.runExclusive(async () => {
      if (this.poisoned) {
        throw new Error(
          `ObjectStoreDocStore for shard '${this.shard}' is poisoned (a prior post-commit local apply failed); it must be re-opened before further use`,
        );
      }
      if (this.held === null) {
        return { deletedSegments: 0, deletedSnapshots: 0 }; // not an owner (replica, or already fenced) — never GC
      }

      // RE-READ (never trust `this.cached` — it may be arbitrarily stale if we've been fenced since
      // our last commit/heartbeat). The shard's manifest must exist by now (this instance itself
      // `open()`'d/`acquire()`'d it).
      const fresh = await readManifest(this.objectStore, this.shard);
      if (fresh === null) {
        throw new Error(`objectstore-substrate: gc() found no manifest for shard '${this.shard}' — open() must initialize it first`);
      }
      if (fresh.manifest.epoch !== this.held.epoch) {
        // Fenced: a challenger's acquire() landed since we last knew. Poison + demote, delete
        // NOTHING — the fresh manifest's snapshot/segments belong to whoever holds the epoch now.
        this.poisoned = true;
        this.held = null;
        return { deletedSegments: 0, deletedSnapshots: 0 };
      }
      this.cached = fresh; // adopt current truth — safe, epoch matches what we hold

      if (fresh.manifest.snapshotTs === undefined) {
        return { deletedSegments: 0, deletedSnapshots: 0 }; // no snapshot yet — nothing to GC
      }
      const segBase = fresh.manifest.snapshotSegBase!;
      const keepSnap = fresh.manifest.snapshotTs!;
      const keepSnapBig = BigInt(keepSnap);

      const watermarks = await readConsumerWatermarks(this.objectStore, this.shard);
      const wMin = watermarks.length > 0 ? Math.min(...watermarks.map((w) => w.appliedSeqno)) : Number.POSITIVE_INFINITY;
      const floor = Math.min(segBase, wMin);

      const segPrefix = `s${this.shard}/seg/`;
      const segKeys = await this.objectStore.list(segPrefix);
      let deletedSegments = 0;
      for (const key of segKeys) {
        const suffix = key.slice(key.lastIndexOf("/") + 1);
        const seqno = Number(suffix);
        // Defensive: skip any key whose suffix doesn't parse to an integer — never delete an
        // object we don't understand. NEVER delete seqno > floor (a live segment bootstrap or a
        // still-tailing replica may still need it); the predicate below is deliberately `<=`,
        // never anything looser.
        if (!Number.isInteger(seqno)) continue;
        if (seqno <= floor) {
          await this.objectStore.delete(key);
          deletedSegments++;
        }
      }

      const snapPrefix = `s${this.shard}/snap/`;
      const snapKeys = await this.objectStore.list(snapPrefix);
      let deletedSnapshots = 0;
      for (const key of snapKeys) {
        const ts = key.slice(key.lastIndexOf("/") + 1);
        // Defensive parity with the segment loop above: never touch an object whose suffix isn't a
        // valid decimal-bigint ts — a malformed `snap/*` key is unreachable (only `writeSnapshot`
        // writes them, always with a numeric frontierTs), but a bare `BigInt(ts)` throw here would
        // wedge snapshot reclamation past that key on every swallow-driven sweep, so skip it.
        if (!/^\d+$/.test(ts)) continue;
        // Strictly older than keepSnap (TOCTOU-safe — see the doc comment above): NEVER delete
        // keepSnap itself or anything >= it (a `>=` snapshot can only belong to a new owner that
        // raced ahead of us in the gap between the epoch re-read above and this sweep).
        if (BigInt(ts) < keepSnapBig) {
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

  /** The materialized current state (Slice 5 — migration export). Delegates to the local SQLite
   *  store, which already holds the full materialized image the object log reduces to — the same
   *  source `snapshot()` dumps from. */
  dumpCurrentState(): Promise<{ documents: DocumentLogEntry[]; indexUpdates: IndexWrite[] }> {
    return this.local.dumpCurrentState();
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
