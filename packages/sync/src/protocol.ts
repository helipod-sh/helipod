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

export interface QueryRequest {
  queryId: number;
  udfPath: string;
  args: JSONValue;
}

export type ClientMessage =
  | { type: "Connect"; sessionId: string }
  | { type: "ModifyQuerySet"; add: QueryRequest[]; remove: number[] }
  | { type: "Mutation"; requestId: string; udfPath: string; args: JSONValue }
  | { type: "Action"; requestId: string; udfPath: string; args: JSONValue }
  | { type: "EphemeralPublish"; topic: string; event: JSONValue }
  | { type: "SetAuth"; token: string | null }
  | { type: "SetAdminAuth"; key: string };

export type StateModification =
  | { type: "QueryUpdated"; queryId: number; value: JSONValue }
  | { type: "QueryFailed"; queryId: number; error: string }
  | { type: "QueryRemoved"; queryId: number };

export type ServerMessage =
  | { type: "Transition"; startVersion: StateVersion; endVersion: StateVersion; modifications: StateModification[] }
  // `ts` (W1) carries the mutation's commitTs — the wire-level ack an optimistic-update gate
  // consumes to know when it is safe to drop a client-side pending layer (never on the ack
  // alone: the gate waits until the session's OWN reactive feed has observed this ts too).
  // Optional, not because it is sometimes skippable, but because the server omits it on the
  // one path where sending it would be a lie — see the send-site invariant check at
  // handler.ts's `handleMutation`. Additive: old clients that don't know the field ignore it.
  | { type: "MutationResponse"; requestId: string; success: true; value: JSONValue; ts?: number }
  | { type: "MutationResponse"; requestId: string; success: false; error: string }
  | { type: "ActionResponse"; requestId: string; success: true; value: JSONValue }
  | { type: "ActionResponse"; requestId: string; success: false; error: string }
  | { type: "Broadcast"; topic: string; event: JSONValue }
  | { type: "FatalError"; message: string }
  | { type: "Ping" };

export function parseClientMessage(raw: string): ClientMessage {
  return JSON.parse(raw) as ClientMessage;
}

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
