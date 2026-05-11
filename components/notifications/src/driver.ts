import type { Driver, DriverContext } from "@stackbase/component";
import type { JSONValue } from "@stackbase/values";
import type { NotificationsConfig } from "./config";
import { compact, deliverOutbound } from "./render";
import type { QueuedMessage } from "./modules";
import { NotificationSendError } from "./provider";

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
 * and `_markResult` leaves the row `"sending"` and it is NEVER re-swept by the normal peek — it is
 * instead recovered by `_reclaimStuck` (N2), a wall-clock lease sweep run at the top of every pass that
 * requeues a row stuck past `config.reclaimLeaseMs`, counting an attempt so a perpetually-crashing row
 * still dead-letters eventually. `_claimForSend`'s exact `status==="queued"` check under single-writer
 * OCC is the authoritative once-only guard; the provider `Idempotency-Key` is auto-derived from the
 * row id (`msg:<_id>`) as defense-in-depth for a retry/resend of the same row. N2: a retryable failed
 * send (per `NotificationSendError.retryable`, default true for a plain `Error`) goes back to `queued`
 * with a jittered exponential backoff (`nextAttemptAt`) until `config.retry.maxAttempts`, then
 * dead-letters to `failed`; a non-retryable failure dead-letters immediately. Fleet multi-driver
 * claim/lease remains out of scope (this driver is single-node). The action-mode `sendNow` drains
 * through the SAME `_claimForSend`/`_markResult` guard, so driver-vs-inline delivery of a `sendNow` row
 * is mutually exclusive (whichever claims first delivers; the other skips).
 */
export function notificationsDriver(config: NotificationsConfig): NotificationsDriver {
  // Only run the digest flush when a category actually configures `digest` — a config-gate (not a
  // string-matched try/catch) that also skips the digest module entirely for a digest-less or a bare
  // test composition (`makeSendModules`-only, no `makeDigestModules`), so the driver never depends on
  // the digest module being present unless the app opted into digest.
  const hasDigest = Object.values(config.categories).some((c) => c.digest !== undefined);
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
    let earliestDeferredAt: number | null = null;
    // A row this PASS already SUCCESSFULLY claimed (and is therefore about to deliver) is never
    // reattempted again within the SAME pass, even if `_markResult` requeues it with an
    // already-elapsed `nextAttemptAt` (e.g. `retry.initialBackoffMs: 0`, or a backoff shorter than
    // this pass's own wall-clock stride). Without this, `_markResult`'s own commit re-fires `onCommit`
    // (it touches `notifications/*`) synchronously mid-await, setting `pendingWake` and causing the
    // `do…while` below to immediately re-peek and re-claim the just-requeued row — cascading every
    // retry of a message into ONE external wake instead of one attempt per wake. Only marked AFTER a
    // successful claim (not on every `peek.ready` sighting) — a row whose claim this pass LOSES (e.g.
    // another concurrent claimant, or a test harness racing a simulated crash) must remain eligible for
    // a later same-pass reprocessing (a `_reclaimStuck` requeue included), or it would wedge un-marked
    // FOREVER until the next external wake.
    const attemptedThisPass = new Set<string>();
    do {
      pendingWake = false;
      await ctx.runFunction("notifications:_reclaimStuck", {});
      // N4 digest flush — PER-GROUP ISOLATION: peek the due `(recipient, category)` groups, then flush
      // each in its OWN transaction (`_flushGroup`) inside a `try/catch`. A poison group (an app
      // `digestTemplate` that throws) can ONLY fail its own group — it can never abort this pass and
      // wedge delivery of every OTHER queued notification (incl. critical auth OTPs) on the node. A
      // flush's `recordSend` writes a queued `messages` row this same pass's peek/deliver loop then
      // picks up. Config-gated (`hasDigest`) so a digest-less/bare composition never calls the module.
      if (hasDigest) {
        const dnow = ctx.now();
        const due = (await ctx.runFunction("notifications:_peekDueGroups", { now: dnow })) as Array<{ recipientKey: string; category: string }>;
        for (const g of due) {
          try {
            await ctx.runFunction("notifications:_flushGroup", { recipientKey: g.recipientKey, category: g.category, now: dnow });
          } catch (e) {
            console.error(`[notifications] driver: digest flush for ${g.recipientKey}/${g.category} failed (isolated):`, e);
          }
        }
      }
      const now = ctx.now();
      const peek = (await ctx.runFunction("notifications:_peekQueued", { now })) as { ready: QueuedMessage[]; earliestDeferredAt: number | null };
      earliestDeferredAt = peek.earliestDeferredAt;
      for (const m of peek.ready) {
        if (attemptedThisPass.has(m._id)) continue;
        // Per-message isolation (the scheduler driver's discipline): a `_claimForSend`/`_markResult`
        // failure for THIS row must not strand its batch siblings — log and move on; the row waits
        // for the next wake. (If it was delivered but `_markResult` threw, it stays "sending" —
        // recovered by the next pass's `_reclaimStuck` once the lease expires.)
        try {
          // Claim BEFORE the network call (queued → sending). Lost the claim (another pass/driver, or
          // already finalized) → skip WITHOUT marking attempted — see the Set's doc comment above.
          const claimed = (await ctx.runFunction("notifications:_claimForSend", { messageId: m._id })) as boolean;
          if (!claimed) continue;
          attemptedThisPass.add(m._id); // claimed — about to deliver; guard against a same-pass re-entry
          let ok = false;
          let providerMessageId: string | undefined;
          let providerName: string | undefined;
          let error: string | undefined;
          let retryable: boolean | undefined;
          try {
            // Auto-derive the provider Idempotency-Key from the stable row id (defense-in-depth: a
            // retry of the same row reuses it, so a supporting provider dedups). Independent of the
            // caller's optional `sendReceipts` idempotencyKey. `deliverOutbound` walks the channel's
            // ordered [provider, ...fallbacks] list itself — this attempt's `retryable` verdict (used
            // only in the catch below) is already the OR across every provider it tried.
            const res = await deliverOutbound(config, { channel: m.channel, to: m.to, payload: m.payload, tokens: m.tokens, idempotencyKey: `msg:${m._id}` });
            ok = true;
            providerMessageId = res.providerMessageId;
            providerName = res.providerName;
            if (res.invalidTokens?.length) {
              await ctx.runFunction("notifications:_pruneInvalidPushTokens", { tokens: res.invalidTokens });
            }
          } catch (e) {
            error = String(e);
            retryable = e instanceof NotificationSendError ? e.retryable : true; // plain Error → retryable
          }
          // `providerMessageId`/`providerName`/`error`/`retryable` may be undefined. `runFunction`'s
          // arg codec (`jsonToConvex`) REJECTS an undefined-valued key (it does NOT drop it) — so strip
          // them with `compact` before the call, exactly as the insert path does; `_markResult` reads
          // the absent keys as undefined.
          await ctx.runFunction("notifications:_markResult", compact({ messageId: m._id, ok, providerMessageId, providerName, error, retryable }) as unknown as JSONValue);
        } catch (e) {
          console.error(`[notifications] driver: message ${m._id} failed mid-pass:`, e);
        }
      }
    } while (pendingWake);
    armTimer(earliestDeferredAt);
  }

  function armTimer(earliestDeferredAt: number | null = null): void {
    if (stopped) return;
    if (timer !== null) { ctx.clearTimer(timer); timer = null; }
    // Wake at the interval, OR sooner if a backed-off row becomes eligible before then.
    const intervalAt = ctx.now() + config.driverIntervalMs;
    const at = earliestDeferredAt !== null && earliestDeferredAt < intervalAt ? earliestDeferredAt : intervalAt;
    timer = ctx.setTimer(at, wake);
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
