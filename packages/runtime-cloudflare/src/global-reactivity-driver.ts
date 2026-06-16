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
 * (`ctx.setTimer`/`ctx.clearTimer`, a `stopped`-guarded `wake()`/`armTimer()` pair, a `__tick` test
 * seam) — EXCEPT cadence: unlike the reaper, this driver's re-arm is a plain `intervalMs`, never
 * routed through `ctx.backstopMs` (see `armTimer`'s doc — global reactivity is latency-sensitive, and
 * `backstopMs` on Cloudflare floors at 15 minutes, tuned for the reaper's idle-cost tradeoff, not this
 * driver's). The one addition this driver needs beyond `DriverContext`'s existing surface is
 * `notifyWrites`/`subscribedGlobalTables`/`onGlobalSubscribe` (added to `DriverContext` alongside this
 * file; all three are plain delegations to the already-constructed `SyncProtocolHandler`, so no
 * chicken-and-egg problem the way a boot-layer-constructed poller reaching for `runtime.handler` would
 * have — see `runtime.ts`'s `driverCtx` construction).
 *
 * M2c review fix: `start()` also registers `ctx.onGlobalSubscribe?.(() => armIfIdle())` — arming the
 * timer (if currently idle) the moment a NEW subscription with a global-table read set registers.
 * Without this, a busy DO (open local-table subscriptions/mutations, so it never hibernates) that
 * ticks with zero global subscribers disarms — and nothing but a full DO reconstruction would ever
 * re-arm it, since re-arm otherwise happens ONLY in the tick's own `finally`. A later `.global()`
 * subscribe on that SAME live instance (a `ModifyQuerySet`, no constructor re-run) would then be
 * delivered its initial result but never reactively invalidated again — silent reactivity death. A
 * genuinely idle/hibernated DO still heals via the existing bootstrap force-arm on reconstruction;
 * this fix specifically covers the live/busy-DO late-subscribe path that force-arm can't reach.
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
   * rehydrate" hook: by the time it FIRES (`intervalMs` out — rehydrate is synchronous local work,
   * done long before then), `subscribedGlobalTables()` correctly reflects reality, and
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
    // Fix 2 (M2c review): deliberately NOT routed through `ctx.backstopMs`. `backstopMs` is a host's
    // knob for stretching a PURE backstop cadence (nothing locally signals "there's next work" — see
    // the storage reaper) to cut cold-wake cost; on Cloudflare it floors at 900_000ms (15min), tuned
    // for that idle-reaper case. Global reactivity is latency-sensitive (a foreign D1 write should
    // show up in low seconds, not up to 15 minutes later), so its cadence is the plain `intervalMs`
    // unconditionally — a host stretching `backstopMs` for its OTHER drivers must not silently stretch
    // this one too.
    timer = ctx.setTimer(ctx.now() + intervalMs, wake);
  }

  /**
   * M2c review fix: arm the timer ONLY if nothing is currently armed — the `onGlobalSubscribe`
   * callback. Guarding on `timer !== null` (rather than unconditionally force-arming on every
   * subscribe) is what keeps repeated global subscribes from stacking/resetting timers: if a wake is
   * already pending, it already covers this newly-registered subscription (subscriptions registered
   * between "now" and the pending wake are picked up by that same wake's `tick()`, which re-reads
   * `subscribedGlobalTables()` fresh), so there's nothing to do. Only a driver that had genuinely gone
   * idle (`timer === null` — the busy-DO-late-subscribe case this hook exists for) gets a fresh arm.
   */
  function armIfIdle(): void {
    if (stopped || timer !== null) return;
    armTimer({ force: true });
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
      // M2c review fix: arm on a late global subscribe (see the module doc + `armIfIdle`'s doc above).
      // Optional on `DriverContext` — a bespoke fake that predates this fix simply never heals the
      // busy-DO-late-subscribe path, same as before.
      c.onGlobalSubscribe?.(() => armIfIdle());
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
