/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */

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

export type ShardRoutingErrorCode = typeof SHARD_KEY_REQUIRED | typeof CROSS_SHARD_UNSUPPORTED;

export interface ShardRoutingErrorBody {
  error: { code: ShardRoutingErrorCode; message: string };
}

export function routingError(code: ShardRoutingErrorCode, message: string): ShardRoutingErrorBody {
  return { error: { code, message } };
}
