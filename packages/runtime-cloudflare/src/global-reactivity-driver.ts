/**
 * M2c Task 6: wires `GlobalReactivityPoller` (Task 5's pure poll -> diff -> `notifyWrites`
 * mechanism) onto the DO's alarm/wake seam as a `Driver` — the hibernation-safe cadence.
 *
 * Design decision (Task 6 Step 1): registered as a `Driver` composed into `createEmbeddedRuntime`'s
 * `drivers: [...]` array, using `DriverContext.setTimer`/`clearTimer` for cadence (rides the SAME
 * `wakeHost`/`fireDueTimers()` alarm every other driver on a DO uses — scheduler, triggers, the
 * storage reaper) rather than a free-running `setTimeout`/`setInterval` chain (the shape
 * `startReplicaReactiveTailer` uses for a long-lived Node/Bun process, which is explicitly the WRONG
 * shape here: a DO with idle-but-open WebSocket subscriptions can hibernate, and a free timer would
 * keep it artificially alive). This mirrors `@stackbase/storage`'s `storageReaper` almost exactly
 * (`ctx.setTimer`/`ctx.clearTimer`/`ctx.backstopMs`, a `stopped`-guarded `wake()`/`armTimer()` pair,
 * a `__tick` test seam) — the one addition this driver needs beyond `DriverContext`'s existing
 * surface is `notifyWrites`/`subscribedGlobalTables` (added to `DriverContext` alongside this file;
 * both are plain delegations to the already-constructed `SyncProtocolHandler`, so no chicken-and-egg
 * problem the way a boot-layer-constructed poller reaching for `runtime.handler` would have — see
 * `runtime.ts`'s `driverCtx` construction).
 *
 * `readVersions` is NOT threaded through `DriverContext` — unlike `notifyWrites`/
 * `subscribedGlobalTables`, it comes from the `D1DocStore` (`globalStore`), which the CALLER
 * (`bootDurableObjectRuntime`) already holds as a local variable BEFORE `createEmbeddedRuntime` is
 * even invoked (see `boot.ts`). Threading it onto `DriverContext` too would only add an unused
 * general-purpose hook every other host/test fake would need to reason about; closing over it
 * directly at construction time (`globalReactivityPollerDriver(globalStore.readVersions.bind(...))`)
 * is the smaller diff.
 */
import type { Driver, DriverContext } from "@stackbase/component";
import { GlobalReactivityPoller, type GlobalReactivityDeps } from "./global-reactivity-poller";

/** Default poll cadence — see the M2c spec / Task 6 brief ("~2000ms"). */
export const DEFAULT_GLOBAL_REACTIVITY_POLL_MS = 2000;

export interface GlobalReactivityPollerDriver extends Driver {
  /** Test seam: runs one poll-diff-notify pass and awaits its real completion (no timer/alarm
   *  involved) — mirrors `StorageReaperDriver.__tick`/`SchedulerDriver.__tick`. */
  __tick: () => Promise<void>;
}

/**
 * Build the M2c global-reactivity `Driver`. `readVersions` is `D1DocStore.readVersions` (bound),
 * closed over directly (see the module doc above for why it isn't a `DriverContext` hook).
 */
export function globalReactivityPollerDriver(
  readVersions: GlobalReactivityDeps["readVersions"],
  opts?: { intervalMs?: number },
): GlobalReactivityPollerDriver {
  const intervalMs = opts?.intervalMs ?? DEFAULT_GLOBAL_REACTIVITY_POLL_MS;
  let ctx: DriverContext;
  let poller: GlobalReactivityPoller;
  let timer: number | null = null;
  // Set by `stop()` BEFORE it tears anything down — mirrors `storageReaper`'s guard: an in-flight
  // `tick()` (awaiting `readVersions`/`notifyWrites`) may still be running when `stop()` races in,
  // and its `wake()`'s `.finally(() => armTimer())` must see `stopped` already true so it no-ops
  // instead of resurrecting a timer after `stop()` already returned.
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    await poller.tick();
  }

  /**
   * Re-arm the next wake. `force` (used only by `start()`) arms unconditionally, covering the
   * boot-ordering race a DO's eager-rehydrate-on-wake introduces: this driver's `start()` runs
   * INSIDE `createEmbeddedRuntime`, which resolves and returns from `bootDurableObjectRuntime`
   * BEFORE `StackbaseDurableObject`'s constructor calls `rehydrateAll()` (which replays every
   * hibernated socket's `Subscribe`, populating `subscribedGlobalTables()` for the FIRST time on a
   * post-hibernation wake) — so an unconditional `subscribedGlobalTables().length === 0` gate at
   * `start()` time would see zero subscribers (nothing has rehydrated yet) and never arm anything,
   * even though real subscribers are about to exist a few lines later in the SAME boot sequence.
   * Forcing exactly one bootstrap timer sidesteps this without needing a new "poke me after
   * rehydrate" hook: by the time it FIRES (`intervalMs`/`backstopMs` out — rehydrate is synchronous
   * local work, done long before then), `subscribedGlobalTables()` correctly reflects reality, and
   * every SUBSEQUENT re-arm (from `wake()`'s `.finally`) is the real, subscriber-gated decision —
   * so a genuinely idle DO (no `.global()` subscribers at all) still settles back to nothing armed
   * after this one bootstrap check, and can hibernate.
   */
  function armTimer(opts2?: { force?: boolean }): void {
    if (stopped) return;
    if (timer !== null) {
      ctx.clearTimer(timer);
      timer = null;
    }
    if (!opts2?.force && (ctx.subscribedGlobalTables?.() ?? []).length === 0) return;
    // A pure backstop poll (no "next work" signal exists locally for a foreign write to a D1 table
    // another node made) — `backstopMs` is the call site that declares that, letting a host stretch
    // it (e.g. to reduce cold-wake cost) without this driver knowing or caring.
    timer = ctx.setTimer(ctx.now() + ctx.backstopMs(intervalMs), wake);
  }

  function wake(): void {
    if (stopped) return;
    tick()
      .catch((e: unknown) => {
        console.error("[runtime-cloudflare] global reactivity poller: tick failed:", e);
      })
      .finally(() => {
        armTimer();
      });
  }

  return {
    name: "global-reactivity-poller",
    start(c) {
      ctx = c;
      if (!c.notifyWrites || !c.subscribedGlobalTables) {
        // Defensive: every real host wires these (see `runtime.ts`'s `driverCtx`), but a bespoke
        // `DriverContext` fake that predates M2c would otherwise fail confusingly deep inside the
        // first tick.
        throw new Error(
          "global-reactivity-poller driver requires a DriverContext with notifyWrites + subscribedGlobalTables (M2c)",
        );
      }
      const notifyWrites = c.notifyWrites;
      const subscribedGlobalTables = c.subscribedGlobalTables;
      poller = new GlobalReactivityPoller({
        readVersions,
        subscribedGlobalTables,
        notifyWrites,
        now: () => c.now(),
      });
      armTimer({ force: true });
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        ctx.clearTimer(timer);
        timer = null;
      }
    },
    __tick: () => tick(),
  };
}
