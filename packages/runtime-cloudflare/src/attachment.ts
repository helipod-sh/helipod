/**
 * The 16 KB WebSocket attachment — a hibernated socket's DURABLE state (§3 of the Slice-3 spec).
 *
 * DECISION 2 (locked): the attachment stores the subscription DEFINITION, never the read-set. Each
 * sub is `{ udfPath, args, sinceTs?, fingerprint? }` — the RECIPE to re-derive the read-set by
 * re-running the query on revival, NOT the (potentially large, index-range) read-set itself. This is
 * what makes 16 KB realistic (a function path + small args + two short resume tokens per sub) and it
 * maps EXACTLY onto the shipped subscription-resume path: replaying a `Subscribe` carrying the
 * persisted `sinceTs`/`fingerprint` lets an unchanged query answer with a tiny `QueryUnchanged`
 * instead of a full re-send — the reconnect-resume mechanism doubles as the hibernation-rehydrate
 * mechanism for free.
 *
 * OVERFLOW (§3.3): cap subscriptions per socket (`MAX_SUBSCRIPTIONS_PER_SOCKET`). A subscribe past
 * the cap is a clean client-visible rejection, never a silent truncation. Cap-only for Slice 3 (the
 * SQLite spill is a documented deferred follow-on); a `serializeAttachment` throw degrades (the sub
 * still works this turn; the client's normal reconnect-resume re-establishes it next hibernation).
 */

/** One persisted subscription — the recipe to re-derive the read-set, not the read-set. Mirrors a
 *  `QueryRequest` (the `ModifyQuerySet.add` entry) so replay is a verbatim re-add. */
export interface PersistedSub {
  /** The client's numeric subscription id (`QueryRequest.queryId`). */
  queryId: number;
  /** `path:name` of the subscribed query. */
  udfPath: string;
  /** The subscribe args (JSON). Kept small; the cap bounds the total. */
  args: unknown;
  /** DLR Stage 3 resume token, IF the client supplied it on its (resume) subscribe: the client's
   *  `maxObservedTs` — replayed so an unchanged query re-runs to `QueryUnchanged`, not a full send. */
  sinceTs?: number;
  /** The client's last-known server-minted fingerprint (`QueryRequest.resultHash`), IF supplied.
   *  Making rehydrate ALWAYS carry this (a full → `QueryUnchanged` win even for a fresh subscribe)
   *  needs the DO to capture the server-minted fingerprint off OUTBOUND frames — a deferred
   *  optimization; rehydrate is correct without it (a full re-send). */
  resultHash?: string;
}

/** Per-socket durable state. `connectionId` is the stable session id minted at upgrade; `identity`
 *  is the verified bearer to replay to `handler.setAuth` on revival; `subs` is keyed by the client's
 *  subscription id. */
export interface HelipodSocketAttachment {
  connectionId: string;
  identity: string | null;
  subs: Record<string, PersistedSub>;
}

/**
 * The subscription cap per socket (§3.3, Lunora's `MAX_SUBSCRIPTIONS_PER_SOCKET`). A socket that
 * exceeds it is rejected/closed rather than silently truncated — a clean client-visible error whose
 * normal reconnect re-establishes within the cap. 128 is generous for a real UI (a screen rarely
 * holds more than a few dozen live queries) while keeping the attachment comfortably under 16 KB even
 * with moderate args.
 */
export const MAX_SUBSCRIPTIONS_PER_SOCKET = 128;

/** A fresh attachment for a just-upgraded socket. */
export function newAttachment(connectionId: string): HelipodSocketAttachment {
  return { connectionId, identity: null, subs: {} };
}

/** Read a socket's attachment back after (a possible) hibernation, tolerating an absent/garbled one
 *  (returns `null` — the caller loud-logs and treats the socket as un-rehydratable, closing it). */
export function readAttachment(raw: unknown): HelipodSocketAttachment | null {
  if (raw === null || typeof raw !== "object") return null;
  const a = raw as Partial<HelipodSocketAttachment>;
  if (typeof a.connectionId !== "string") return null;
  return {
    connectionId: a.connectionId,
    identity: typeof a.identity === "string" ? a.identity : null,
    subs: a.subs && typeof a.subs === "object" ? (a.subs as Record<string, PersistedSub>) : {},
  };
}

/** Throw a typed cap error the DO turns into a client-visible close. */
export class TooManySubscriptionsError extends Error {
  readonly code = "TOO_MANY_SUBSCRIPTIONS";
  constructor(cap: number) {
    super(
      `[runtime-cloudflare] a socket may hold at most ${cap} live subscriptions (the DO hibernation ` +
        `attachment is capped at 16 KB); close some before subscribing more`,
    );
    this.name = "TooManySubscriptionsError";
  }
}

/** True if adding one more sub would exceed the cap (an existing subId re-subscribe is not new). */
export function wouldExceedCap(att: HelipodSocketAttachment, subId: string): boolean {
  if (subId in att.subs) return false;
  return Object.keys(att.subs).length >= MAX_SUBSCRIPTIONS_PER_SOCKET;
}
