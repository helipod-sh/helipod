/**
 * The reactive sync protocol — the client↔server message catalog and the version model.
 *
 * State is **version-bracketed**: every `Transition` advances `startVersion → endVersion`,
 * and a client applies one only if its `startVersion` matches the client's current version.
 * A missed frame leaves a gap the client detects and resyncs from — so dropping a frame
 * (backpressure) degrades to a resync, never to silent divergence. The `ServerMessage` union
 * is versioned-by-shape and deliberately extensible (e.g. the non-commit `Broadcast` kind for
 * the ephemeral path) so the wire can later gain a binary delta encoding.
 */
import type { JSONValue } from "@stackbase/values";
import type { Change } from "./change";

export interface StateVersion {
  /** Bumped when the set of subscribed queries changes. */
  querySet: number;
  /** The latest commit timestamp reflected (0 = none). */
  ts: number;
}

export const INITIAL_VERSION: StateVersion = { querySet: 0, ts: 0 };

export function versionsEqual(a: StateVersion, b: StateVersion): boolean {
  return a.querySet === b.querySet && a.ts === b.ts;
}

export function compareStateVersion(a: StateVersion, b: StateVersion): -1 | 0 | 1 {
  if (a.querySet !== b.querySet) return a.querySet < b.querySet ? -1 : 1;
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return 0;
}

/** Two brackets are contiguous when the next starts exactly where the previous ended. */
export function isContiguous(prevEnd: StateVersion, nextStart: StateVersion): boolean {
  return versionsEqual(prevEnd, nextStart);
}

/**
 * `resultHash` (subscription resume, design 2025-11-28): the client's last-known server-minted
 * fingerprint for this query, echoed back on resubscribe. Present only when the subscription was
 * previously `answered` with a defined value; absent on a first subscribe, a prior `QueryFailed`,
 * or an old client that predates this field — all of which fall through to today's full send.
 */
export interface QueryRequest {
  queryId: number;
  udfPath: string;
  args: JSONValue;
  resultHash?: string;
}

/**
 * The durable per-tab client identity for a resend-safe mutation (Receipted Outbox, verdict §(b)/(e)).
 * `clientId` is minted once per tab-session; `seq` is a per-tab monotone counter. The `(identity,
 * clientId, seq)` triple is the write-once dedup key; `identity` is the session's ambient token,
 * supplied server-side (never trusted from the client). Both fields absent → today's unconditional
 * path, bit-for-bit — a mutation with no `clientId` writes no receipt and reads no classification.
 */
export interface ClientMutationRef {
  clientId: string;
  seq: number;
}

/** One entry of a {@link MutationBatch} — the same shape a standalone `Mutation` carries. */
export interface MutationBatchEntry {
  requestId: string;
  udfPath: string;
  args: JSONValue;
  clientId?: string;
  seq?: number;
}

/**
 * A per-seq verdict as it travels on the wire (`ConnectAck.results`, verdict §(e)). `verdict`
 * distinguishes a replayed success (`applied`), a replayed terminal failure (`failed`), a
 * loudly-disowned pruned/holed seq (`stale`), and a never-seen seq the client must (re)send
 * (`unknown`). `commitTs`/`value`/`valueMissing`/`code` mirror {@link MutationResponse}'s replay shape.
 */
export interface ClientMutationVerdict {
  clientId: string;
  seq: number;
  verdict: "applied" | "failed" | "stale" | "unknown";
  commitTs?: number;
  value?: JSONValue;
  valueMissing?: true;
  code?: string;
}

export type ClientMessage =
  // `Connect` activates from the reserved no-op (verdict §(e)): `clientId`/`held`/`ackedThrough` are
  // the resume handshake — the server classifies `held` into `ConnectAck.results` and prunes
  // `ackedThrough` (the contiguous settled-prefix). Absent → today's no-op Connect, bit-for-bit.
  | { type: "Connect"; sessionId: string; clientId?: string; held?: ClientMutationRef[]; ackedThrough?: ClientMutationRef[]; supportsQueryDiff?: true }
  | { type: "ModifyQuerySet"; add: QueryRequest[]; remove: number[] }
  | { type: "Mutation"; requestId: string; udfPath: string; args: JSONValue; clientId?: string; seq?: number }
  // `MutationBatch` (verdict §(e)): the offline drain's chunk shape — the server applies `entries`
  // SEQUENTIALLY and replies with one `MutationResponse` per entry it settles (chunk semantics). A
  // mid-batch TERMINAL failure (deterministic app error, coded verdict) records + responds and
  // CONTINUES to the next entry; a TRANSIENT failure (retryable/infra) responds that entry's
  // failure and STOPS the drain — later entries get no response, so a causally-dependent unit can
  // never apply after an earlier transient failure (the FIFO drain obligation). See
  // `SyncProtocolHandler.processMutation`'s doc comment for the full classification rule.
  | { type: "MutationBatch"; entries: MutationBatchEntry[] }
  | { type: "Action"; requestId: string; udfPath: string; args: JSONValue }
  | { type: "EphemeralPublish"; topic: string; event: JSONValue }
  | { type: "SetAuth"; token: string | null }
  | { type: "SetAdminAuth"; key: string };

export type StateModification =
  // `hash` (subscription resume): the server's own fingerprint of `value` — see `hashValue` in
  // handler.ts. Attached at every construction site (subscribe answer AND reactive re-run pushes)
  // so the client's stored hash is always current at disconnect time. Optional only for wire
  // compatibility with a hand-constructed message; the server never omits it.
  | { type: "QueryUpdated"; queryId: number; value: JSONValue; hash?: string }
  | { type: "QueryFailed"; queryId: number; error: string }
  | { type: "QueryRemoved"; queryId: number }
  // Subscription resume: the fresh re-run's hash matched the client-echoed `resultHash` — no
  // `value` to send. Sent ONLY from the subscribe-answer path (`doModifyQuerySet`), never from a
  // reactive re-run push (a push only happens because the read-set was intersected; sending
  // `QueryUnchanged` there is out of scope — see the design doc's Non-goals).
  | { type: "QueryUnchanged"; queryId: number }
  // DLR 2a: an incremental row diff for a DIFFABLE query. `changes` apply to the client's keyed
  // row-map; `checksum` is the server's drift fingerprint of the resulting map (client verifies).
  // A DIFFABLE query's INITIAL answer is a QueryDiff "reset" (add-all over an empty map). Sent only
  // to a session that advertised `supportsQueryDiff` on Connect; RERUN queries use QueryUpdated.
  | { type: "QueryDiff"; queryId: number; changes: Change[]; checksum: string };

export type ServerMessage =
  | { type: "Transition"; startVersion: StateVersion; endVersion: StateVersion; modifications: StateModification[] }
  // `ts` (W1) carries the mutation's commitTs — the wire-level ack an optimistic-update gate
  // consumes to know when it is safe to drop a client-side pending layer (never on the ack
  // alone: the gate waits until the session's OWN reactive feed has observed this ts too).
  // Optional, not because it is sometimes skippable, but because the server omits it on the
  // one path where sending it would be a lie — see the send-site invariant check at
  // handler.ts's `handleMutation`. Additive: old clients that don't know the field ignore it.
  // `replayed`/`valueMissing` (Receipted Outbox, verdict §(e)): a replay-ack for a resent mutation
  // whose verdict was already recorded — NO commit happened on this call; `ts` is the ORIGINAL
  // commitTs (keeps the client optimistic gate sound). `value` is omitted (not sent) when the
  // recorded verdict had no value (the crash-window or 64KB-cap case) — then `valueMissing: true`.
  | { type: "MutationResponse"; requestId: string; success: true; value?: JSONValue; ts?: number; replayed?: true; valueMissing?: true }
  // `code` (verdict §(e)): the terminal verdict code (a recorded `failed` verdict's error code, or
  // `"STALE_CLIENT"`) — the client's coded-vs-codeless retry policy keys off its presence.
  | { type: "MutationResponse"; requestId: string; success: false; error: string; code?: string }
  | { type: "ActionResponse"; requestId: string; success: true; value: JSONValue }
  | { type: "ActionResponse"; requestId: string; success: false; error: string }
  // `ConnectAck` (verdict §(e)): the resume-handshake reply — the capability proof that arms the
  // client's park-and-resend. `known: false` → the server has neither records nor a floor for the
  // presented history (a swept/foreign timeline) → the client resets (`onClientReset`). `deploymentId`
  // hardens the same-timeline proof (verdict §(g) hazard 15). `results` classifies each presented
  // `held` seq. NO `tableNumbers` (rejected — couples client caches to the interim registry).
  | { type: "ConnectAck"; known: boolean; results: ClientMutationVerdict[]; deploymentId: string }
  | { type: "Broadcast"; topic: string; event: JSONValue }
  | { type: "FatalError"; message: string }
  | { type: "Ping" };

export function parseClientMessage(raw: string): ClientMessage {
  return JSON.parse(raw) as ClientMessage;
}

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
