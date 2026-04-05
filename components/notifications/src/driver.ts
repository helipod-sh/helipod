import type { Driver, DriverContext } from "@stackbase/component";
import type { JSONValue } from "@stackbase/values";
import type { NotificationsConfig } from "./config";
import { compact, deliverOutbound } from "./render";
import type { QueuedMessage } from "./modules";

/** `notificationsDriver()` exposes `__tick` — a deterministic test seam: one drain pass, awaiting
 *  its real completion, errors propagating (unlike the timer/onCommit path, which swallows+logs).
 *  Mirrors `SchedulerDriver.__tick` / `receiptsReaper.__tick`. */
export interface NotificationsDriver extends Driver {
  __tick: () => Promise<void>;
}

/**
 * The queued-send driver — delivers `status:"queued"` email/SMS `messages` rows via the configured
 * provider OUTSIDE any transaction, via `queued → sending → sent`/`failed`. Two wake sources (the
 * scheduler/reaper pattern): the commit fan-out (`onCommit`, any `notifications/*` write) and a
 * wall-clock timer at `driverIntervalMs`. A single in-process `running` flag serializes passes so a
 * commit racing the timer can't double-dispatch the same row; a wake landing mid-pass sets
 * `pendingWake` so the pass loops once more with a fresh peek instead of stranding a just-enqueued
 * row. `stopped` (set before teardown) prevents any settling pass from re-arming after `stop()`.
 *
 * Crash-safety (single-node): each row is CLAIMED (`_claimForSend`, `queued → sending`, its own txn)
 * BEFORE `provider.send`; `_peekQueued` never returns `"sending"`, so a crash between send-returns
 * and `_markResult` leaves the row `"sending"` and it is NEVER re-swept → no double-send. A stuck
 * `"sending"` row is terminal in N1 (recovery/reclaim is N2 — do NOT auto-retry). `_claimForSend`'s
 * exact `status==="queued"` check under single-writer OCC is the authoritative once-only guard; the
 * provider `Idempotency-Key` is auto-derived from the row id (`msg:<_id>`) as defense-in-depth for
 * any future (N2) resend. N1 boundary: a failed provider send is TERMINAL (`failed`); retries and
 * fleet multi-driver claim/lease are N2 (this driver is single-node). The action-mode `sendNow`
 * drains through the SAME `_claimForSend`/`_markResult` guard, so driver-vs-inline delivery of a
 * `sendNow` row is mutually exclusive (whichever claims first delivers; the other skips).
 */
export function notificationsDriver(config: NotificationsConfig): NotificationsDriver {
  let ctx: DriverContext;
  let running = false;
  let pendingWake = false;
  let timer: number | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let unsubscribeCommit: (() => void) | null = null;

  function wake(): void {
    if (stopped) return;
    iterate().catch((e: unknown) => console.error("[notifications] driver iteration failed:", e));
  }

  function iterate(): Promise<void> {
    if (running) { pendingWake = true; return inFlight ?? Promise.resolve(); }
    running = true;
    const pass = runPass().finally(() => {
      running = false;
      inFlight = null;
      if (pendingWake) void wake();
    });
    inFlight = pass;
    return pass;
  }

  async function runPass(): Promise<void> {
    do {
      pendingWake = false;
      const queued = (await ctx.runFunction("notifications:_peekQueued", {})) as QueuedMessage[];
      for (const m of queued) {
        // Per-message isolation (the scheduler driver's discipline): a `_claimForSend`/`_markResult`
        // failure for THIS row must not strand its batch siblings — log and move on; the row waits
        // for the next wake. (If it was delivered but `_markResult` threw, it stays "sending" —
        // terminal in N1, reclaim is N2.)
        try {
          // Claim BEFORE the network call (queued → sending). Lost the claim (another pass/driver, or
          // already finalized) → skip. This is what makes a crash mid-send non-re-sweepable.
          const claimed = (await ctx.runFunction("notifications:_claimForSend", { messageId: m._id })) as boolean;
          if (!claimed) continue;
          let ok = false;
          let providerMessageId: string | undefined;
          let error: string | undefined;
          try {
            // Auto-derive the provider Idempotency-Key from the stable row id (defense-in-depth: an N2
            // retry of the same row reuses it, so a supporting provider dedups). Independent of the
            // caller's optional `sendReceipts` idempotencyKey.
            const res = await deliverOutbound(config, { channel: m.channel, to: m.to, payload: m.payload, idempotencyKey: `msg:${m._id}` });
            ok = true;
            providerMessageId = res.providerMessageId;
          } catch (e) {
            error = String(e);
          }
          // `providerMessageId`/`error` may be undefined. `runFunction`'s arg codec (`jsonToConvex`)
          // REJECTS an undefined-valued key (it does NOT drop it) — so strip them with `compact` before
          // the call, exactly as the insert path does; `_markResult` reads the absent keys as undefined.
          await ctx.runFunction("notifications:_markResult", compact({ messageId: m._id, ok, providerMessageId, error }) as unknown as JSONValue);
        } catch (e) {
          console.error(`[notifications] driver: message ${m._id} failed mid-pass:`, e);
        }
      }
    } while (pendingWake);
    armTimer();
  }

  function armTimer(): void {
    if (stopped) return;
    if (timer !== null) { ctx.clearTimer(timer); timer = null; }
    timer = ctx.setTimer(ctx.now() + config.driverIntervalMs, wake);
  }

  return {
    name: "notifications",
    start(c) {
      ctx = c;
      unsubscribeCommit = c.onCommit((inv) => { if (inv.tables.some((t) => t.startsWith("notifications/"))) wake(); });
      wake();
      armTimer();
    },
    stop() {
      stopped = true;
      unsubscribeCommit?.();
      unsubscribeCommit = null;
      if (timer !== null) { ctx.clearTimer(timer); timer = null; }
    },
    __tick: () => iterate(),
  };
}
