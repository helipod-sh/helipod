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
 *                 double-apply).
 *  - `completed`→ already resolved at `MutationResponse` (D3); its layer **drops** too.
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
  /** `inflight` request ids — their promises reject with `MutationUndeliveredError`. */
  reject: string[];
  /** request ids whose optimistic layers drop (`inflight` + `completed`). */
  drop: string[];
  /** `unsent` request ids — retained in the log for a reconnect flush. */
  retain: string[];
}

/** Compute the close disposition for the current log (verdict §(c) event 6). */
export function closeDisposition(entries: Iterable<PendingMutation>): CloseDisposition {
  const reject: string[] = [];
  const drop: string[] = [];
  const retain: string[] = [];
  for (const e of entries) {
    switch (e.status.type) {
      case "unsent":
        retain.push(e.requestId);
        break;
      case "inflight":
        reject.push(e.requestId);
        drop.push(e.requestId);
        break;
      case "completed":
        drop.push(e.requestId);
        break;
    }
  }
  return { reject, drop, retain };
}
