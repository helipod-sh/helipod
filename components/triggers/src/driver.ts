import type { Driver, DriverContext, LogChange } from "@stackbase/component";
import type { JSONValue } from "@stackbase/values";
import { validateHandlers, ensureCursor } from "./boot";

export interface TriggerConfig {
  /** App fn path — an internal (`_`-prefixed) mutation or action; see `./boot.ts`'s `validateHandlers`. */
  handler: string;
  /** Max changes per handler invocation. Default `DEFAULT_BATCH_SIZE` (64). */
  batchSize?: number;
  /** Start at log ts 0 (replay every existing revision) instead of the tip. Default `false`. */
  fromStart?: boolean;
  /** Circuit-breaker threshold: deliveries allowed per `BREAKER_WINDOW_MS`. Default `DEFAULT_MAX_DELIVERIES_PER_WINDOW` (1000). */
  maxDeliveriesPerWindow?: number;
}

export type TriggersOpts = Record<string, TriggerConfig>;

/** Design spec D2 default. */
export const DEFAULT_BATCH_SIZE = 64;
/** Design spec D2: "~1MB serialized — full docs travel in the args; cut the batch early when exceeded." Approximated via `JSON.stringify(...).length` (UTF-16 code units, not exact bytes) — a ballpark budget, not an exact enforcement. */
export const BYTE_BUDGET = 1_000_000;
/** Design spec D2 default (the circuit breaker). */
export const DEFAULT_MAX_DELIVERIES_PER_WINDOW = 1000;
/** Design spec D2: the breaker's fixed window size. */
export const BREAKER_WINDOW_MS = 10_000;
/**
 * The driver's ONLY periodic timer — everything else is reactive. Backstops an external
 * `triggers:resume` call with no accompanying watched-table write to react to (see `start()`'s
 * `onCommit` filter for why resume isn't wired reactively) by re-`wakeAll()`ing on this cadence;
 * also a general defense-in-depth re-check, mirroring `@stackbase/scheduler`'s `SWEEP_MS`. A
 * test drives this deterministically via `__tick()` (no `name`) rather than waiting on this timer
 * — see `TriggersDriver`'s doc comment.
 */
export const BEAT_MS = 30_000;

/**
 * A `triggersDriver()` also exposes:
 *  - `__tick(name?)`: a deterministic test seam for one pass of trigger `name` (or every
 *    configured trigger, awaited together, if omitted) — no real timers. Calling it with no
 *    `name` is also the deterministic stand-in for "the periodic beat fired" (`BEAT_MS`,
 *    `armBeat` below) — both do exactly `wakeAll()`, so a test never needs to wait out the real
 *    30s timer to prove a resumed trigger gets picked back up.
 *  - `__wake(name?)`: the same fire-and-forget signal `DriverContext.onCommit`/a retry timer use
 *    internally, exposed so a test can simulate one landing at a precise moment.
 */
export interface TriggersDriver extends Driver {
  __tick: (name?: string) => Promise<void>;
  __wake: (name?: string) => void;
}

/**
 * `@stackbase/triggers`' driver — one independent event loop PER configured trigger (design spec
 * D2), not a single shared loop: each trigger name gets its own `running`/`pendingWake`/`inFlight`
 * coalescing state (mirroring `@stackbase/scheduler`'s `schedulerDriver` shape, but keyed by
 * name), so a slow handler on trigger A can never head-of-line-block trigger B's independent
 * backlog — they're just separate promise chains woken by the same commit fan-out.
 *
 * Two wake sources per trigger, no fixed-interval polling:
 *  - **Reactive**: `DriverContext.onCommit` fires `wake(name)` for every trigger `name` whose
 *    OWN watched table appears in the commit's `tables` — and for EVERY trigger when
 *    `"triggers/cursors"` itself is touched (an external `triggers:resume` call, which any
 *    trigger's paused state could be waiting on).
 *  - **Timer**: a failed delivery arms a single retry timer for that trigger, per
 *    `computeBackoff` (`@stackbase/scheduler`) — see `_recordFailure`'s doc comment (`./modules.ts`)
 *    for why the delay itself is in-memory, not persisted.
 *
 * Each trigger's attempt (`runOnePass`) loops internally — draining quiet-table progress and
 * full matched batches alike — until `cursorTs` reaches the bound captured at the START of that
 * attempt (`targetBound`), a delivery fails, or the breaker/max-failures pauses it; `runPass`
 * wraps that in an outer `do..while(pendingWake)` (scheduler's exact shape) so a wake landing
 * mid-drain gets one more FULL attempt (a fresh `targetBound` peek included) rather than being
 * silently dropped. This is the precise, non-spinning inference the T1 handoff calls for:
 * `readLog` exposes no explicit "did the scan hit its limit" flag, so rather than guess from
 * `changes.length` alone, each attempt just keeps asking "is there more, up to where I started?"
 * (bounded, since that target can never move against a trigger's own writes — see `runPass`'s
 * doc comment) until the answer is unambiguously "no."
 */
export function triggersDriver(opts: TriggersOpts): TriggersDriver {
  let ctx: DriverContext;
  let stopped = false;

  const names = Object.keys(opts);
  const running = new Map<string, boolean>();
  const pendingWake = new Map<string, boolean>();
  const inFlight = new Map<string, Promise<void>>();
  const retryTimers = new Map<string, number>();
  /** In-memory only (design spec D2: "window state need not persist") — a fixed 10s window per trigger. */
  const breakerWindows = new Map<string, { windowStart: number; count: number }>();
  /** In-memory backoff gate: a trigger with a pending retry timer skips dispatch until the timer's `atMs` — see the module doc comment for why this delay isn't persisted. */
  const nextAttemptAt = new Map<string, number>();

  function wakeAll(): void {
    for (const name of names) wake(name);
  }

  function wake(name: string): void {
    if (stopped) return;
    iterate(name).catch((e: unknown) => {
      console.error(`[triggers] driver iteration for "${name}" failed:`, e);
    });
  }

  function iterate(name: string): Promise<void> {
    if (running.get(name)) {
      // Mirrors `@stackbase/scheduler`'s coalescing (see its `driver.ts` for the full rationale):
      // a wake landing mid-pass sets a bit the in-flight pass checks before releasing `running`,
      // so it loops for one more fresh pass instead of a stale re-arm stranding new work.
      pendingWake.set(name, true);
      return inFlight.get(name) ?? Promise.resolve();
    }
    running.set(name, true);
    const pass = runPass(name).finally(() => {
      running.set(name, false);
      inFlight.delete(name);
      // Closes a residual micro-window (mirrors `@stackbase/scheduler`'s `iterate()`): a wake can
      // land between `runPass`'s own internal `do..while(pendingWake)` loop (below) making its
      // final check and THIS `finally` running. Without this, that wake would set `pendingWake`
      // but nothing would ever consume it.
      if (pendingWake.get(name)) {
        pendingWake.set(name, false);
        void wake(name);
      }
    });
    inFlight.set(name, pass);
    return pass;
  }

  /**
   * Loops `runOnePass` until an attempt completes with no wake pending — a wake that arrives
   * mid-drain (a real external write to `name`'s watched table landing while this pass is
   * mid-`readLog`, or a concurrent caller's own `iterate(name)` call coalescing into this one) sets
   * `pendingWake`, and this loop re-runs `runOnePass` (with a FRESH `targetBound` peek) instead of
   * returning with a stale view. Mirrors `@stackbase/scheduler`'s `runPass` shape exactly — this
   * is now safe to do (see `start()`'s `onCommit` filter): `pendingWake` can only be set here by a
   * GENUINE external event, never by this trigger's own routine cursor-bookkeeping writes (those
   * no longer reactively wake anything, precisely to avoid this loop chasing its own tail).
   */
  async function runPass(name: string): Promise<void> {
    let iterations = 0;
    do {
      pendingWake.set(name, false);
      await runOnePass(name);
      // Defensive cap: real cascades here are bounded (each iteration only fires from a genuine
      // NEW external wake), but a runaway is a bug we'd rather surface loudly than spin forever on.
      if (++iterations > 1000) {
        console.error(`[triggers] "${name}": runPass exceeded 1000 iterations — bailing (possible bug).`);
        return;
      }
    } while (pendingWake.get(name));
  }

  /** Drains trigger `name` up to the log bound captured ONCE at the start of THIS attempt (`targetBound` below) — see `runPass`'s doc comment for why a live-refreshed bound would self-perpetuate. */
  async function runOnePass(name: string): Promise<void> {
    const cfg = opts[name]!;
    const waitUntil = nextAttemptAt.get(name);
    if (waitUntil !== undefined && ctx.now() < waitUntil) return; // still backing off — the retry timer will wake us

    // Peeked BEFORE `ensureCursor` — deliberately, not after — so a brand-new trigger's OWN
    // `_initCursor` insert (a write) can never land inside the very range this same pass is about
    // to consider "unscanned." The `limit: 0` "peek the bound, don't scan" idiom (see
    // `DriverContext.readLog`'s doc comment) is an O(1) read, so capturing this target costs
    // nothing extra; `ensureCursor` reuses this exact value (`tipIfNew`) rather than peeking
    // again — see its doc comment (`./boot.ts`) for the self-chasing loop this specifically avoids.
    const { maxScannedTs: targetBound } = await ctx.readLog({ afterTs: 0, tables: [], limit: 0 });

    const cursor = await ensureCursor(ctx, name, cfg.fromStart === true, targetBound);
    let cursorTs = cursor.cursorTs;
    if (cursor.state !== "running") return; // paused — nothing to do until `triggers:resume`

    const batchSize = cfg.batchSize ?? DEFAULT_BATCH_SIZE;
    const maxPerWindow = cfg.maxDeliveriesPerWindow ?? DEFAULT_MAX_DELIVERIES_PER_WINDOW;

    while (cursorTs < targetBound) {
      const { changes, maxScannedTs } = await ctx.readLog({ afterTs: cursorTs, tables: [name], limit: batchSize });

      if (changes.length === 0) {
        if (maxScannedTs <= cursorTs) break; // defensive — the `while` guard above should already prevent this
        await ctx.runFunction("triggers:_advanceCursor", { name, newCursorTs: maxScannedTs, expectedPrev: cursorTs });
        cursorTs = maxScannedTs;
        continue; // more of the (quiet) log, up to `targetBound`, may remain beyond this call's own limit
      }

      const { batch, advanceTs } = cutToByteBudget(changes, maxScannedTs);

      // `ctx.now()` read FRESH per delivery (not hoisted above the loop) so the breaker's 10s
      // window is measured against real elapsed time across a long-running drain, not a single
      // stale timestamp from when this pass started.
      if (recordDeliveryAndCheckBreaker(name, ctx.now(), maxPerWindow)) {
        await ctx.runFunction("triggers:_pause", { name, reason: "circuit-breaker" });
        console.error(
          `[triggers] "${name}" paused: circuit breaker tripped (> ${maxPerWindow} deliveries within ${BREAKER_WINDOW_MS}ms) — a self-recursive or runaway handler, most likely.`,
        );
        return;
      }

      try {
        // `LogChange[]` isn't structurally a `JSONValue` (it's a concrete interface, not an index
        // signature) even though every field IS JSON-safe — same bridging cast
        // `@stackbase/scheduler`'s driver uses for a job's arbitrary `result.value` (see its
        // `driver.ts`).
        await ctx.runFunction(cfg.handler, { changes: batch } as unknown as JSONValue);
      } catch (e) {
        const result = (await ctx.runFunction("triggers:_recordFailure", { name, error: String(e) })) as {
          paused: boolean;
          retryDelayMs: number;
        };
        if (result.paused) {
          console.error(`[triggers] "${name}" paused after ${MAX_FAILURES_LOG_HINT} consecutive failures: ${String(e)}`);
          nextAttemptAt.delete(name);
        } else {
          const retryAt = ctx.now() + result.retryDelayMs;
          nextAttemptAt.set(name, retryAt);
          armRetryTimer(name, retryAt);
        }
        return; // same cursorTs — the exact same batch (by changeId) redelivers next attempt
      }

      await ctx.runFunction("triggers:_advanceCursor", { name, newCursorTs: advanceTs, expectedPrev: cursorTs });
      cursorTs = advanceTs;
      nextAttemptAt.delete(name); // a successful delivery clears any stale backoff gate
      // loop again — `advanceTs` may be < `maxScannedTs` (a byte-budget cut), or there may simply
      // be more beyond what this one `readLog` call scanned.
    }
  }

  function armRetryTimer(name: string, atMs: number): void {
    const existing = retryTimers.get(name);
    if (existing !== undefined) ctx.clearTimer(existing);
    const handle = ctx.setTimer(atMs, () => wake(name));
    retryTimers.set(name, handle);
  }

  function recordDeliveryAndCheckBreaker(name: string, now: number, maxPerWindow: number): boolean {
    let w = breakerWindows.get(name);
    if (!w || now - w.windowStart >= BREAKER_WINDOW_MS) {
      w = { windowStart: now, count: 0 };
      breakerWindows.set(name, w);
    }
    w.count++;
    return w.count > maxPerWindow;
  }

  let unsubscribeCommit: (() => void) | null = null;
  let beatTimer: number | null = null;

  // The driver's periodic backstop — the ONLY thing an external `triggers:resume` call relies on
  // to be noticed (see `start()`'s `onCommit` filter below for why resume ISN'T wired reactively).
  // Re-arms itself after every fire, mirroring `@stackbase/scheduler`'s `armSweep`/`sweepOnce`.
  function armBeat(): void {
    if (stopped) return;
    if (beatTimer !== null) ctx.clearTimer(beatTimer);
    // `backstopMs` (not `BEAT_MS` raw): the beat is a pure backstop poll, never next-work — the call
    // site is how a driver declares that, so a host where every wake costs a cold start can stretch
    // it. The documented cost there: an external `triggers:resume` is noticed on the STRETCHED
    // cadence, not within ~30s.
    beatTimer = ctx.setTimer(ctx.now() + ctx.backstopMs(BEAT_MS), () => {
      wakeAll();
      armBeat();
    });
  }

  return {
    name: "triggers",
    start(c) {
      ctx = c;
      validateHandlers(ctx, opts); // fail-fast — see ./boot.ts for why this can't be a literal boot step
      unsubscribeCommit = ctx.onCommit((inv) => {
        // Deliberately NOT waking on `"triggers/cursors"` writes here (unlike
        // `@stackbase/scheduler`'s onCommit filter, which DOES react to its own control-table
        // writes): `triggers:_advanceCursor`/`_recordFailure`/`_pause` are THEMSELVES commits to
        // `triggers/cursors`, so reacting to them would make a trigger's own routine cursor
        // bookkeeping re-wake itself forever, one tick at a time — see this file's `runPass` doc
        // comment for the full mechanics. An external `triggers:resume` call (the only reason to
        // care about a `triggers/cursors` write from OUTSIDE this loop) is instead picked up by
        // the periodic beat (`armBeat` below) — eventual, not instant, but resume is an infrequent
        // operator action, not a latency-sensitive path.
        for (const name of names) if (inv.tables.includes(name)) wake(name);
      });
      wakeAll(); // pick up any backlog since the last run (a restart, or a resume that landed while stopped)
      armBeat();
    },
    stop() {
      stopped = true;
      unsubscribeCommit?.();
      unsubscribeCommit = null;
      if (beatTimer !== null) {
        ctx.clearTimer(beatTimer);
        beatTimer = null;
      }
      for (const handle of retryTimers.values()) ctx.clearTimer(handle);
      retryTimers.clear();
    },
    __tick: async (name?: string) => {
      if (name !== undefined) {
        await iterate(name);
        return;
      }
      await Promise.all(names.map((n) => iterate(n)));
    },
    __wake: (name?: string) => {
      if (name !== undefined) wake(name);
      else wakeAll();
    },
  };
}

/** Referenced only in a log line — kept as a named constant so the message and the real threshold (`MAX_CONSECUTIVE_FAILURES`, `./modules.ts`) can't silently drift; `./modules.ts` isn't imported here to avoid a needless cross-file coupling for one log string. */
const MAX_FAILURES_LOG_HINT = 8;

/**
 * Cuts `changes` (already fully scanned by `readLog`, ascending ts) to fit `BYTE_BUDGET`, WITHOUT
 * ever splitting a ts group — a single commit can touch multiple documents in the same watched
 * table, producing multiple `LogChange`s at the same `ts`; delivering some of a group while
 * excluding the rest and then advancing past that `ts` would silently and permanently skip the
 * excluded ones (the same invariant `readLog`'s own `limit` handling enforces internally — see
 * `runtime.ts`'s `readLog`).
 *
 * Degenerate case: the FIRST ts group alone already exceeds the budget (one huge document, or
 * many documents committed together). Mirrors `readLog`'s own same-ts-group handling: deliver it
 * whole, unbounded — a batch of size 1 that's still too big can't be shrunk further, and
 * indefinitely refusing to deliver it would stall the trigger forever.
 *
 * Returns `advanceTs`: `maxScannedTs` when nothing was cut (the common case — the whole scanned
 * window fit), or the ts of the last INCLUDED change when a cut occurred (never `maxScannedTs`,
 * which would skip the excluded, not-yet-delivered tail).
 */
export function cutToByteBudget(
  changes: readonly LogChange[],
  maxScannedTs: number,
): { batch: LogChange[]; advanceTs: number } {
  let size = 0;
  let cutIndex = changes.length;
  for (let i = 0; i < changes.length; i++) {
    const changeSize = JSON.stringify(changes[i]).length;
    if (i > 0 && size + changeSize > BYTE_BUDGET) {
      cutIndex = i;
      break;
    }
    size += changeSize;
  }
  if (cutIndex === changes.length) return { batch: changes.slice(), advanceTs: maxScannedTs };

  const cutTs = changes[cutIndex]!.ts;
  let groupStart = cutIndex;
  while (groupStart > 0 && changes[groupStart - 1]!.ts === cutTs) groupStart--;

  if (groupStart === 0) {
    // The very first ts group is itself over budget — deliver it whole regardless (see doc comment).
    let groupEnd = 1;
    while (groupEnd < changes.length && changes[groupEnd]!.ts === changes[0]!.ts) groupEnd++;
    return { batch: changes.slice(0, groupEnd), advanceTs: changes[0]!.ts };
  }

  const batch = changes.slice(0, groupStart);
  return { batch, advanceTs: batch[batch.length - 1]!.ts };
}
