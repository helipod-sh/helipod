/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * The object-storage writer's lease-heartbeat driver (Tier 3 Slice 6, Task 6.2) — a recurring
 * `Driver` (the same seam `@stackbase/scheduler`/`@stackbase/triggers`/`storageReaper`/
 * `receiptsReaper` run on) that keeps this node's `ObjectStoreDocStore` lease alive by calling
 * `store.heartbeat({now, leaseTtlMs})` on a fixed cadence, so a long-running writer never lets its
 * lease lapse just because nobody happened to commit recently.
 *
 * Mirrors `receiptsReaper`'s (`packages/receipts/src/reaper.ts`) single-timer shape — `start`
 * captures `ctx` and calls `wake()`, `wake()` fires the tick fire-and-forget and (on the SUCCESS/
 * transient-failure paths only, see below) re-arms via `.finally`-equivalent branching, `stop()`
 * sets a `stopped` guard before clearing the timer.
 *
 * THE CRITICAL DIFFERENCE FROM EVERY OTHER DRIVER IN THIS CODEBASE: a heartbeat's `FencedError`
 * does not mean "retry later" — it means this node has DEFINITIVELY LOST the lease (some other
 * writer's `acquire()` already bumped the manifest epoch past this instance's, per
 * `ObjectStoreDocStore.heartbeat`'s doc comment) and `store` is now `poisoned`: every further
 * `commitWriteBatch` on it will throw immediately anyway. Silently re-arming and retrying would
 * just keep failing forever while the caller believes the node is healthy. So on `FencedError` this
 * driver does NOT re-arm — it logs a loud, unambiguous fatal and calls `opts.onFenced?.(e)`, which
 * the CLI wires to trigger graceful node shutdown (a fenced writer MUST stop serving writes, never
 * keep accepting them against a store that will reject every one). Every OTHER error (a transient
 * object-store blip — a timeout, a 5xx, a network blip) is NOT a fence: the lease may still be alive
 * until `leaseExpiresAt` elapses, so this driver logs and re-arms, keeping up the renewal attempts —
 * exactly the resilience `receiptsReaper`'s "one bad pass doesn't kill the reaper" policy embodies,
 * just with the fence case carved out as the one terminal exception.
 */
import type { Driver, DriverContext } from "@stackbase/component";
import { FencedError } from "./fenced-error";

/** The minimal surface this driver needs from `ObjectStoreDocStore` — kept narrow (rather than
 *  importing the whole class as a type) so a test fake doesn't need to construct a real store. */
export interface HeartbeatableStore {
  heartbeat(opts: { now: number; leaseTtlMs: number }): Promise<void>;
}

export interface LeaseHeartbeatDriverOpts {
  /** The lease TTL to renew to on every successful heartbeat — must match the TTL `acquire()` was
   *  called with (the driver does not itself acquire; it only renews an already-held lease). */
  leaseTtlMs: number;
  /** How often to attempt a renewal. Should be comfortably shorter than `leaseTtlMs` (the same
   *  "renew well before expiry" margin every lease-holding system needs) — this driver does not
   *  enforce a ratio; that's the caller's judgment call. */
  heartbeatMs: number;
  /** Called exactly once, synchronously from within `wake()`, the moment a heartbeat surfaces a
   *  `FencedError` — i.e. this node has lost the lease. The CLI wires this to trigger graceful
   *  shutdown (stop serving writes). Optional so a test can omit it. */
  onFenced?: (e: FencedError) => void;
}

/** Test/introspection seam mirroring `ReceiptsReaperDriver`'s `__tick`: runs one heartbeat pass and
 *  awaits its real completion (propagating any error) rather than the timer path's swallow+log. */
export interface LeaseHeartbeatDriver extends Driver {
  __tick: () => Promise<void>;
}

/**
 * Build the lease-heartbeat driver for `store` (Tier 3 Slice 6, Task 6.2). See the module doc above
 * for the full fence-vs-transient-error policy.
 */
export function leaseHeartbeatDriver(store: HeartbeatableStore, opts: LeaseHeartbeatDriverOpts): LeaseHeartbeatDriver {
  const { leaseTtlMs, heartbeatMs, onFenced } = opts;
  // Fail fast rather than silently letting the lease lapse: a beat cadence at or slower than the TTL
  // means a single missed/delayed tick (GC pause, event-loop stall, a slow object-store round trip)
  // can let `leaseExpiresAt` pass with no renewal in flight — exactly the failure this driver exists
  // to prevent. Catch it at construction, not in production telemetry.
  if (heartbeatMs >= leaseTtlMs) {
    throw new Error(
      `objectstore-substrate: leaseHeartbeatDriver requires heartbeatMs (${heartbeatMs}) < leaseTtlMs (${leaseTtlMs}) — ` +
        `a heartbeat cadence at or slower than the lease TTL can let the lease lapse before a renewal ever lands`,
    );
  }
  let ctx: DriverContext;
  let timer: number | null = null;
  // Set the instant a fence is detected (BEFORE calling `onFenced`) OR `stop()` is called — guards
  // every re-entry point (`wake`, `armTimer`) against resurrecting a timer after either terminal
  // condition, mirroring `receiptsReaper`'s `stopped` guard.
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    await store.heartbeat({ now: ctx.now(), leaseTtlMs });
  }

  function armTimer(): void {
    if (stopped) return;
    if (timer !== null) {
      ctx.clearTimer(timer);
      timer = null;
    }
    timer = ctx.setTimer(ctx.now() + heartbeatMs, wake);
  }

  // The timer entry point: fire-and-forget. Unlike `receiptsReaper`'s `wake()` (which
  // unconditionally re-arms in a `.finally`), this one branches on WHY the tick failed: a
  // `FencedError` is terminal (do not re-arm; fire `onFenced`), anything else is transient (log +
  // re-arm, same resilience policy as every other driver in this codebase).
  function wake(): void {
    if (stopped) return;
    tick().then(
      () => {
        armTimer();
      },
      (e: unknown) => {
        if (e instanceof FencedError) {
          // Terminal: this node has lost the lease. Set `stopped` BEFORE calling `onFenced` (same
          // ordering discipline as `stop()` below) so nothing re-arms even if `onFenced` somehow
          // re-enters this driver synchronously.
          stopped = true;
          console.error(
            `[objectstore-substrate] FATAL: lease heartbeat fenced — this node no longer owns its shard's write lease ` +
              `and must stop serving writes. Cause: ${e.message}`,
          );
          // The fence path is terminal/shutdown — a throwing `onFenced` callback must not escape as an
          // unhandled rejection (this whole branch runs inside a fire-and-forget `.then` rejection
          // handler with no caller to catch it). Log the callback's own failure and swallow it; the
          // driver has already done its job (stopped, logged the fence) regardless of what the
          // callback does.
          try {
            onFenced?.(e);
          } catch (callbackError) {
            console.error("[objectstore-substrate] lease heartbeat: onFenced callback threw:", callbackError);
          }
          return;
        }
        // Transient object-store blip — the lease may still be alive until `leaseExpiresAt`. Log and
        // keep trying on the normal cadence.
        console.error("[objectstore-substrate] lease heartbeat: renewal attempt failed (will retry):", e);
        armTimer();
      },
    );
  }

  return {
    name: "leaseHeartbeat",
    start(c) {
      ctx = c;
      // Unlike `receiptsReaper`'s `start()` (which fires an immediate sweep via `wake()`), this
      // driver only ARMS the first timer — the lease was just freshly `acquire()`'d by the caller
      // before this driver starts, so an immediate renewal is redundant; the first heartbeat should
      // land on the normal `heartbeatMs` cadence.
      armTimer();
    },
    stop() {
      // Set BEFORE tearing anything down — see the `stopped` doc comment above.
      stopped = true;
      if (timer !== null) {
        ctx.clearTimer(timer);
        timer = null;
      }
    },
    // Test seam: runs one heartbeat pass and awaits its real completion, letting a `FencedError` (or
    // any other error) propagate to the caller — unlike `wake()`, used by the timer path, which
    // catches and branches instead. Does NOT itself set `stopped`/call `onFenced` on a fence; a test
    // exercising that behavior should drive it through the timer callback captured by a fake
    // `DriverContext.setTimer`, same as `receiptsReaper`'s own tests do for its policy.
    __tick: () => tick(),
  };
}
