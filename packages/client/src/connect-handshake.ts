/**
 * The `Connect` resume handshake's pure computation (verdict §(c) event 6, §(e)) — `held` (every
 * durable `(clientId, seq)` still awaiting a verdict) and `ackedThrough` (the contiguous
 * settled-prefix per clientId, for server-side retention pruning), plus the wire message itself.
 *
 * Extracted from `client.ts` (T3) so a SECOND caller with no `HelipodClient` can send the SAME
 * handshake shape — the headless drain (`headless-drain.ts`, the Background Sync seam). A Service
 * Worker has no live in-memory `MutationLog`, only the durable `OutboxStorage` rows, so
 * {@link outboxHeldFromStore} computes `held` straight from those instead of a live
 * `PendingMutation` log ({@link outboxHeldFromLog}, `HelipodClient`'s own source). Both feed the
 * SAME {@link outboxAckedThrough}/{@link buildConnectMessage} — the wire shape is identical either
 * way, only the source of `held` differs.
 */
import type { ClientMessage, ClientMutationRef } from "@helipod/sync";
import type { PendingMutation } from "./mutation-log";
import type { OutboxEntry } from "./outbox-storage";

/** A durable entry is `held` (presented to the server for classification) while it's genuinely
 *  unsettled: `unsent` (queued, never sent), `inflight` (sent, no response — outcome unknowable on
 *  a dropped connection), or `parked` (closed with the S4 swap armed, awaiting a future drain).
 *  Presenting `unsent`/`inflight` too is harmless — the server classifies them `unknown` and the
 *  caller (re)sends them; only `completed`/`failed` (a settled fate) are never held. */
const HELD_STATUSES: ReadonlySet<string> = new Set(["unsent", "inflight", "parked"]);

/** `held` from a LIVE `HelipodClient`'s in-memory log — every entry with a recorded `(clientId,
 *  seq)` whose status is still unsettled. */
export function outboxHeldFromLog(entries: Iterable<PendingMutation>): ClientMutationRef[] {
  const refs: ClientMutationRef[] = [];
  for (const e of entries) {
    if (e.clientId !== undefined && e.seq !== undefined && HELD_STATUSES.has(e.status.type)) {
      refs.push({ clientId: e.clientId, seq: e.seq });
    }
  }
  return refs;
}

/** `held` from a store-only host (the headless drain — no live log, only persisted rows) — the same
 *  three statuses, read straight off the persisted `OutboxEntry.status` (identical strings, identical
 *  meaning, to the live `PendingMutation.status.type` above). */
export function outboxHeldFromStore(entries: Iterable<OutboxEntry>): ClientMutationRef[] {
  const refs: ClientMutationRef[] = [];
  for (const e of entries) {
    if (HELD_STATUSES.has(e.status)) refs.push({ clientId: e.clientId, seq: e.seq });
  }
  return refs;
}

/** The highest CONTIGUOUS settled-prefix seq per clientId (verdict §(c) Retention / spec decision
 *  3). Under the FIFO one-unacked-chunk drain a seq can never settle past an unsettled earlier one,
 *  so for each clientId the settled prefix is exactly `(lowest still-held seq) - 1`; a clientId
 *  whose lowest held seq is 0 has acked nothing and is omitted. */
export function outboxAckedThrough(held: ClientMutationRef[]): ClientMutationRef[] {
  const lowestHeld = new Map<string, number>();
  for (const ref of held) {
    const cur = lowestHeld.get(ref.clientId);
    if (cur === undefined || ref.seq < cur) lowestHeld.set(ref.clientId, ref.seq);
  }
  const acked: ClientMutationRef[] = [];
  for (const [clientId, minSeq] of lowestHeld) {
    if (minSeq > 0) acked.push({ clientId, seq: minSeq - 1 });
  }
  return acked;
}

/** Build the `Connect` resume handshake wire message. `sessionId` is a fresh per-connect id (the
 *  server routes the handshake by the transport-level session, so this field is only
 *  informational); `clientId` is likewise informational server-side — `handleConnect` classifies
 *  purely off each `held`/`ackedThrough` entry's OWN `clientId`/`seq` pair, never the top-level
 *  field — so a caller whose held set spans several prior tab-sessions' clientIds (the headless
 *  drain) can safely omit it. */
export function buildConnectMessage(sessionId: string, clientId: string | undefined, held: ClientMutationRef[]): Extract<ClientMessage, { type: "Connect" }> {
  return {
    type: "Connect",
    sessionId,
    ...(clientId !== undefined ? { clientId } : {}),
    held,
    ackedThrough: outboxAckedThrough(held),
    // DLR Stage 2a: advertise by-id diff support. The server records this on any `Connect` (even a
    // resume-handshake one) and sends `QueryDiff` only to a session that advertised it.
    supportsQueryDiff: true,
  };
}
