/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */

/**
 * Typed routing rejections (M1). The router never silently serves partial/wrong data — a request it
 * cannot pin to exactly ONE owning shard-DO is rejected LOUDLY with a coded 400, the same discipline
 * the engine's kernel shard guards use (`ForbiddenOperationError` names the table/field/fix). These
 * codes cross the wire as `{ error: { code, message } }` so a client can branch on `code`.
 */

/** A `.shardBy` mutation reached the router without its shard-key value in the args. Mirrors the
 *  engine kernel's "declares a shard but does not carry it" guard, enforced at the edge so a sharded
 *  write is never mis-routed to the `"default"` DO (where it would land on the wrong data). */
export const SHARD_KEY_REQUIRED = "SHARD_KEY_REQUIRED";

/** A request explicitly asked to span multiple shard-DOs (a fan-out flag, or a multi-valued shard
 *  key). M1 supports only shard-SCOPED operations — a cross-shard query/mutation is a hard non-goal
 *  (§2.1: reactive cross-shard is refused; a non-reactive `fanOut` read lands in M2). Rejected here
 *  rather than fanned out and merged, so no caller ever receives a silently-partial result. */
export const CROSS_SHARD_UNSUPPORTED = "CROSS_SHARD_UNSUPPORTED";

/** An EXPLICIT region hint (`?region=` / `X-Helipod-Region`) was supplied but is not one of
 *  Cloudflare's 11 `locationHint` region codes. Rejected LOUDLY at the edge rather than passed to
 *  `get(id, { locationHint })`: a bad hint would place the shard-DO in an unintended data center
 *  PERMANENTLY (a DO is single-homed and pinned on its first `get()`), so we refuse it up front and
 *  name the fix, exactly the same discipline the shard guards use. */
export const INVALID_REGION_HINT = "INVALID_REGION_HINT";

/** A `fanOut` request hit a deployment with no enumerable shard set — routing mode "key" (the
 *  default) addresses a new DO per key value with no directory, and Cloudflare has no DO-listing API,
 *  so "all shards" is undefined. fanOut requires a fixed-shard-count deployment (mode "hash"). */
export const FANOUT_REQUIRES_FIXED_SHARDS = "FANOUT_REQUIRES_FIXED_SHARDS";

/** A request asked to `fanOut` AND named a shard key. You either target one shard (a shard key) OR
 *  fan out across all shards, never both. */
export const FANOUT_WITH_SHARD_KEY = "FANOUT_WITH_SHARD_KEY";

/** A `fanOut` was requested on the WebSocket `/api/sync` upgrade. fanOut is a non-reactive one-shot
 *  read (fanning invalidation across every shard reactively is out of scope) — it works only over
 *  the one-shot `POST /api/run` path. */
export const FANOUT_NOT_SUBSCRIBABLE = "FANOUT_NOT_SUBSCRIBABLE";

/** A `fanOut` request's target is not a resolved `query` — a mutation (sharded or not), an action,
 *  or a function whose type could not be classified at all (no `loaded` module set at resolve time,
 *  an unparseable/non-`POST /api/run` request, or an unknown `path`). fanOut is READ-ONLY: fanning a
 *  mutation or action out to every shard-DO would multiply ONE logical write into N commits/side
 *  effects, one per shard. An unclassifiable target fails CLOSED under this same code — a request
 *  that cannot be PROVEN to name a query is never fanned out on the assumption that it might be one. */
export const FANOUT_NOT_A_QUERY = "FANOUT_NOT_A_QUERY";

export type ShardRoutingErrorCode =
  | typeof SHARD_KEY_REQUIRED
  | typeof CROSS_SHARD_UNSUPPORTED
  | typeof INVALID_REGION_HINT
  | typeof FANOUT_REQUIRES_FIXED_SHARDS
  | typeof FANOUT_WITH_SHARD_KEY
  | typeof FANOUT_NOT_SUBSCRIBABLE
  | typeof FANOUT_NOT_A_QUERY;

export interface ShardRoutingErrorBody {
  error: { code: ShardRoutingErrorCode; message: string };
}

export function routingError(code: ShardRoutingErrorCode, message: string): ShardRoutingErrorBody {
  return { error: { code, message } };
}
