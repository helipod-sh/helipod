/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `startReplicaReactiveTailer` (Tier 3 Slice 8, Task 8.1, design record §7/§8) — extracts the
 * reactive-tailer wiring the Slice-5 cross-node E2E (`test/cross-node-reactivity.e2e.test.ts`) built
 * inline into a reusable production helper: a caller (typically `stackbase serve --replica`'s boot
 * path, Task 8.2) hands over a REPLICA-side runtime + its materialized `local` store + the bucket,
 * and this helper drives the runtime's reactive fan-out from the writer's committed segments, and
 * publishes the replica's consumer watermark (so the writer's `gcDriver`, Slice 7, never reclaims a
 * segment this replica hasn't tailed yet).
 *
 * The sink mirrors the Slice-5 E2E's `invalidationSink` — itself mirroring the shipped fleet
 * `invalidationSink` (`ee/packages/fleet/src/node.ts` ~:1358) — byte-for-byte:
 *   1. `runtime.observeTimestamp(inv.newMaxTs)` — BEFORE fanning ranges into the sync handler, so the
 *      query oracle's re-run actually reads the newly-applied rows.
 *   2. Convert the round's raw `writtenKeys`/`writtenDocs` into point ranges via the canonical
 *      `keyToPointRange`/`docKeyToPointRange` (`@stackbase/id-codec`, Task 8.1's other half of this
 *      extraction).
 *   3. `await runtime.handler.notifyWrites(...)` — the live-subscription re-run/re-push path.
 *   4. `runtime.notifyExternalCommit(...)` — wakes any driver `onCommit` listener (e.g. a composed
 *      component's own reactive hook) on this replica process.
 * The sink is REACTIVITY ONLY — it does NOT publish the consumer watermark. `ObjectStoreReplicaTailer`
 * advances `appliedSeqno` only AFTER `onInvalidation` resolves (the Slice-5 redelivery-safety
 * discipline: if the sink throws, the next tick must redeliver the identical round), so reading
 * `tailer.appliedSeqno` FROM INSIDE the sink observes the PRE-advance value (`-1` on the very first
 * round) — one round stale, and permanently stuck-stale for a replica that goes idle after its last
 * commit (no further tick ever republishes the true position). Under-reporting is GC-safe (a stale-low
 * watermark only makes `gc()` over-retain), but stuck-stale defeats the watermark's whole purpose for a
 * mostly-idle replica. Instead, THIS HELPER owns its own poll loop (`#pump`, below): each pass calls
 * `tailer.tick()` (which drives the sink above AND THEN advances `appliedSeqno`), and only afterward —
 * if `appliedSeqno` actually advanced — publishes the accurate POST-advance value. A `__pump()` test
 * seam (mirroring `gc-driver.ts`'s `__tick`) drives one round deterministically, awaiting completion
 * and propagating errors, for tests that don't want to wait on a real timer.
 *
 * `ReplicaReactiveRuntime` is a deliberately NARROW structural type — only the three members this
 * sink actually calls — rather than an import of `@stackbase/runtime-embedded`'s `EmbeddedRuntime`.
 * `objectstore-substrate` must not take a dependency on `runtime-embedded` just for this helper's
 * type signature; the real `EmbeddedRuntime` already satisfies this shape structurally, so the CLI's
 * boot path (Task 8.2) can pass one straight through with no adapter.
 */
import type { ObjectStore } from "@stackbase/objectstore";
import type { SqliteDocStore } from "@stackbase/docstore-sqlite";
import type { SerializedKeyRange } from "@stackbase/index-key-codec";
import { keyToPointRange, docKeyToPointRange } from "@stackbase/id-codec";
import { ObjectStoreReplicaTailer, type AppliedInvalidation } from "./replica-tailer";
import { publishConsumerWatermark } from "./consumers";

/** The shape a runtime's reactive tier must expose for this sink to drive it — satisfied
 *  structurally by `@stackbase/runtime-embedded`'s `EmbeddedRuntime` (see module doc). */
export interface ReplicaReactiveRuntime {
  /** Advances the runtime's own observed timestamp so a re-run oracle sees rows through `ts`. */
  observeTimestamp(ts: bigint): void;
  handler: {
    /** Re-runs/re-pushes every live subscription whose recorded read set intersects `ranges`. */
    notifyWrites(inv: { tables: string[]; ranges: SerializedKeyRange[]; commitTs: number }): Promise<void>;
  };
  /** Wakes any driver `onCommit` listener composed into this runtime. */
  notifyExternalCommit(inv: { tables: string[]; ranges: SerializedKeyRange[]; commitTs: number }): void;
}

export interface StartReplicaReactiveTailerOptions {
  /** The replica-side runtime whose reactive tier this helper drives. */
  runtime: ReplicaReactiveRuntime;
  objectStore: ObjectStore;
  shard: string;
  /** The SAME `local` the replica's runtime/store reads from — the tailer applies the writer's
   *  segments directly onto it. */
  local: SqliteDocStore;
  /** This replica's consumer-watermark identity (shard-scoped key `s{shard}/consumers/{id}`, Slice
   *  5 Task 5.2) — a per-process id the caller mints. */
  consumerId: string;
  /** Wall-clock poll interval, ms. Default (`ObjectStoreReplicaTailer`'s own default): 1000. */
  pollMs?: number;
}

/** Returned by `startReplicaReactiveTailer` — see that function's doc. */
export interface ReplicaReactiveTailerHandle {
  /** Halts this helper's own poll loop (idempotent, no re-arm after). Does NOT deregister the
   *  consumer watermark (`removeConsumer` is a boot-path/shutdown concern for the caller, not this
   *  helper — see Task 8.2). Defensively also calls `tailer.stop()`, though this helper never calls
   *  `tailer.start()` itself (no self-timer of the tailer's own to clear). */
  stop(): Promise<void>;
  /** Test/introspection seam mirroring `gc-driver.ts`'s `__tick`: runs exactly one
   *  `tailer.tick()` + the conditional watermark publish, awaiting real completion and propagating
   *  any error (unlike the timer path, which swallows + logs + re-arms). Lets a test drive
   *  deterministic rounds without waiting on a real timer. */
  __pump(): Promise<void>;
}

/**
 * Builds an `ObjectStoreReplicaTailer` over `opts.local`/`opts.objectStore`/`opts.shard` whose
 * `onInvalidation` sink drives `opts.runtime`'s reactive fan-out, then arms this helper's OWN poll
 * loop (see the module doc for why the watermark publish must live HERE, post-`tick()`, rather than
 * inside the sink). `stop()` halts the loop.
 */
export function startReplicaReactiveTailer(opts: StartReplicaReactiveTailerOptions): ReplicaReactiveTailerHandle {
  const { runtime, objectStore, shard, local, consumerId, pollMs } = opts;
  const interval = pollMs ?? 1000;

  const onInvalidation = async (inv: AppliedInvalidation): Promise<void> => {
    runtime.observeTimestamp(inv.newMaxTs);
    const ranges: SerializedKeyRange[] = [
      ...inv.writtenKeys.map((k) => keyToPointRange(k.indexId, k.key)),
      ...inv.writtenDocs.map((d) => docKeyToPointRange(d.tableId, d.internalId)),
    ];
    const commitTs = Number(inv.newMaxTs);
    await runtime.handler.notifyWrites({ tables: inv.writtenTables, ranges, commitTs });
    runtime.notifyExternalCommit({ tables: inv.writtenTables, ranges, commitTs });
  };

  const tailer = new ObjectStoreReplicaTailer({ objectStore, shard, local, onInvalidation, pollMs });

  // The last `appliedSeqno` this helper has itself published, so an idle/no-op tick (nothing new)
  // never issues a redundant bucket write. `-1` matches the tailer's own "not yet correlated"
  // sentinel, so a tick that only opportunistically correlates the cursor (see
  // `ObjectStoreReplicaTailer#tickOnce`'s "nothing new" branch) without genuinely advancing past `-1`
  // still correctly skips the publish.
  let lastPublishedSeqno = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Set by `stop()` BEFORE clearing the timer — guards every re-entry point against resurrecting a
  // timer after `stop()`, mirroring `gc-driver.ts`'s same `stopped` guard.
  let stopped = false;

  // One round: tick the tailer (drives the reactivity sink AND advances `appliedSeqno`), then publish
  // the watermark ONLY if it actually advanced since our last publish — the accurate POST-advance
  // value, never the stale pre-tick one.
  async function pump(): Promise<void> {
    // The single guarded chokepoint for BOTH drive paths (the timer's `wake()` and the `__pump()` test
    // seam): once `stop()` has run, a round already in flight or a manual `__pump()` is a no-op — the
    // replica has been halted and must not apply/publish further.
    if (stopped) return;
    await tailer.tick();
    if (tailer.appliedSeqno !== lastPublishedSeqno) {
      await publishConsumerWatermark(objectStore, shard, consumerId, { appliedSeqno: tailer.appliedSeqno });
      lastPublishedSeqno = tailer.appliedSeqno;
    }
  }

  function armTimer(): void {
    if (stopped) return;
    timer = setTimeout(wake, interval);
  }

  // The timer entry point: fire-and-forget — swallow + log any error (a transient object-store blip
  // shouldn't kill the replica's tailing loop) and always re-arm afterward, success or failure,
  // mirroring `gc-driver.ts`'s `wake()`.
  function wake(): void {
    if (stopped) return;
    pump()
      .catch((e: unknown) => {
        console.error(`objectstore-substrate: replica reactive tailer wiring pump failed for shard '${shard}'`, e);
      })
      .finally(() => {
        armTimer();
      });
  }

  armTimer();

  return {
    async stop(): Promise<void> {
      // Set BEFORE tearing anything down — see the `stopped` doc comment above.
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      tailer.stop();
    },
    __pump: pump,
  };
}
