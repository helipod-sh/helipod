/**
 * S4 — `DeliveryPolicy`. Routes transport lifecycle events (v1: only *close*) into log
 * transitions. The v1 policy is verdict §(c) event 6 verbatim: at close, NO optimistic layer of
 * any kind survives into a new session (the ts-gate is only sound over a feed whose ts is
 * monotone for THIS client, and a reconnect's resubscribe baseline arrives with the fresh
 * session's ts — carrying a completed layer across would replay it on top of its own echo).
 *
 *  - `unsent`   → **retained** (never hit the wire; safe to (re)send on reconnect — T6).
 *  - `inflight` → the promise **rejects** with `MutationUndeliveredError` and its layer **drops**
 *                 (outcome genuinely unknowable — no server dedup exists; a blind resend would
 *                 double-apply) — UNLESS the S4 swap is `armed` AND this entry's durable append
 *                 has already committed, in which case it **parks** instead (Task 2): the promise
 *                 stays PENDING (a future drain resolves it under its recorded `(clientId, seq)`),
 *                 while its layer still drops (the no-layer-crosses-a-session rule is unchanged).
 *  - `completed`→ already resolved at `MutationResponse` (D3); its layer **drops** too.
 *  - `parked`   → already parked by an earlier close, with no drain yet built to resend it
 *                 (T2's honest boundary — T4 owns the drain): left exactly as is.
 */
import type { PendingMutation } from "./mutation-log";

/**
 * Rejection for a mutation whose outcome is unknowable because the transport dropped before its
 * `MutationResponse` arrived. Typed so apps can distinguish "the server rejected this" (a plain
 * `Error` from the handler) from "we never learned what happened" (retry is unsafe — there is no
 * server-side dedup yet). The message deliberately contains "connection closed".
 */
export class MutationUndeliveredError extends Error {
  constructor(message = "mutation outcome unknown: the connection closed before a response arrived") {
    super(message);
    this.name = "MutationUndeliveredError";
  }
}

/** How each pending entry is disposed when the session closes. */
export interface CloseDisposition {
  /** `inflight`-and-NOT-parked request ids — their promises reject with `MutationUndeliveredError`. */
  reject: string[];
  /** request ids whose optimistic layers drop (`inflight` [rejected or parked] + `completed`). */
  drop: string[];
  /** `unsent` (or already-`parked`) request ids — retained in the log; `unsent` for a reconnect
   *  flush (T6), `parked` because there is no drain yet to hand them to (T2's honest boundary). */
  retain: string[];
  /** `inflight` request ids whose durable append had already committed, closed while the S4 swap
   *  is armed — Task 2's park swap. Included in `drop` too (the layer still drops); listed here
   *  separately so the caller knows NOT to reject their promise and NOT to remove them from the
   *  log (unlike every other id in `drop`). */
  park: string[];
}

/** The S4 swap's capability flag — true only once a `ConnectAck` has proven server-side receipt
 *  dedup exists for THIS session (verdict §(d) "S4 swap, feature-detected"; T3 sets it via
 *  `client.ts#setOutboxArmed`). Defaults `false`: a client with no outbox, a fresh/pre-handshake
 *  session, or an old server all get today's fail-fast, byte-for-byte. */
export interface CloseDispositionOptions {
  armed?: boolean;
}

/** Compute the close disposition for the current log (verdict §(c) event 6, extended by Task 2's
 *  park swap). `closeDisposition(entries)` with no second argument is BYTE-IDENTICAL to the
 *  pre-Task-2 behavior — `armed` defaults `false`, and an entry's `durable` flag is irrelevant
 *  when unarmed, so every existing call site (and every entry that never touched an outbox, whose
 *  `durable` is always falsy) is unaffected. */
export function closeDisposition(entries: Iterable<PendingMutation>, opts: CloseDispositionOptions = {}): CloseDisposition {
  const armed = opts.armed ?? false;
  const reject: string[] = [];
  const drop: string[] = [];
  const retain: string[] = [];
  const park: string[] = [];
  for (const e of entries) {
    switch (e.status.type) {
      case "unsent":
        retain.push(e.requestId);
        break;
      case "parked":
        // Already parked by an earlier close; no drain exists yet to hand it to — stays put.
        retain.push(e.requestId);
        break;
      case "inflight":
        if (armed && e.durable) {
          park.push(e.requestId);
          drop.push(e.requestId);
        } else {
          reject.push(e.requestId);
          drop.push(e.requestId);
        }
        break;
      case "completed":
        drop.push(e.requestId);
        break;
    }
  }
  return { reject, drop, retain, park };
}
