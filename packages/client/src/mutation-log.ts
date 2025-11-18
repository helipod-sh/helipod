/**
 * S1 — the `MutationLog`. One entry per unconfirmed mutation, held in a Map whose iteration order
 * is insertion order — which, because `requestId`s are assigned by a monotonically-incrementing
 * counter (`client.ts`), IS the "requestId order" the reconciler replays surviving updates in
 * (verdict §(c) event 2d). The entry carries the **serializable triple** `(requestId, udfPath,
 * args)` from day one (verdict §(b)'s A1 amendment) so "the log is what a durable outbox later
 * persists" is true instead of aspirational — the durable-offline slice backs S1 with IndexedDB
 * without reshaping this record.
 */
import type { JSONValue } from "@stackbase/values";
import type { OptimisticUpdate } from "./layered-store";

/** A single unconfirmed mutation and its optimistic effect. Verbatim from verdict §(b). */
export interface PendingMutation {
  /** Client-local id; rides the existing wire `requestId` field. Opaque string (kept opaque so a
   *  future durable outbox can choose uuid vs monotone clientSeq without reshaping this record). */
  requestId: string;
  udfPath: string;
  /** `(requestId, udfPath, args)` = the serializable triple. */
  args: JSONValue;
  /** The optimistic update closure. Looked up at replay, never serialized. Absent for a plain
   *  (non-optimistic) mutation — such an entry holds no layer and only tracks in-flight status. */
  update?: OptimisticUpdate;
  /** Fixed at creation — feeds the deterministic `placeholderId()`/`now()` an updater calls (D2);
   *  the SAME seed is reused on every replay so minted ids/timestamps are stable. (T5 consumes it.) */
  seed: { entropy: string; now: number };
  /** Query hashes the updater wrote to on its most recent run — which subscriptions its layer covers. */
  touched: Set<string>;
  status:
    | { type: "unsent" } // queued, never hit the wire — safe to (re)send
    | { type: "inflight" } // sent, no response — outcome unknowable on disconnect
    | { type: "completed"; commitTs: number; completedAt: number } // acked; layer held for the gate
    | { type: "parked" }; // T2: closed with a durable append + the S4 swap armed — awaits a future drain
  /**
   * Durable-outbox identity (verdict §(d), Task 2) — present ONLY when this `StackbaseClient` was
   * constructed with a durable `outbox`; a client without one never sets any of the fields below,
   * so `entriesInOrder()` and the wire `Mutation` shape stay byte-identical to before this task for
   * that path. `clientId`/`seq` ride the wire `Mutation`/`MutationBatchEntry` (`clientId`/`seq`,
   * `@stackbase/sync`'s `protocol.ts`) whenever an outbox is configured — carried for park-safety
   * on every send, not just once the S4 swap is armed (see `client.ts#mutationMessage`).
   */
  clientId?: string;
  seq?: number;
  /** Global position across the WHOLE shared durable queue (every clientId sharing one outbox) —
   *  the drain's FIFO key (T4 consumes it; T2 only assigns it). */
  order?: number;
  /** SHA-256 of the last `SetAuth` token ("anon" for none/empty) — stamped synchronously from a
   *  cache `client.ts#setAuth` computes asynchronously (spec §(k)7: SubtleCrypto is async, enqueue
   *  is sync, so the digest is computed ahead of time and merely read here). */
  identityFingerprint?: string;
  enqueuedAt?: number;
  /** Flips `true` once this entry's `OutboxStorage.append()` has resolved. "Park eligibility
   *  requires durability" (verdict §(d)): `delivery-policy.ts#closeDisposition` only parks an
   *  `inflight` entry when this is `true` — a still-in-flight (unconfirmed) append rejects with
   *  `MutationUndeliveredError` exactly as before this task existed. Always left falsy when no
   *  outbox is configured. */
  durable?: boolean;
}

/** The ordered set of unconfirmed mutations. Insertion order == requestId order (see file doc). */
export class MutationLog {
  private readonly entries = new Map<string, PendingMutation>();

  add(entry: PendingMutation): void {
    this.entries.set(entry.requestId, entry);
  }

  get(requestId: string): PendingMutation | undefined {
    return this.entries.get(requestId);
  }

  delete(requestId: string): boolean {
    return this.entries.delete(requestId);
  }

  /** All entries in requestId (insertion) order — the replay order. */
  entriesInOrder(): PendingMutation[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }
}
