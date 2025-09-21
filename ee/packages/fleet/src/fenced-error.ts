/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Thrown when this node's epoch has been superseded by another writer (Fenced Frontier B1, D2/D3).
 * Two sources:
 *
 *   - `LeaseManager.heartbeat(epoch)` finds zero rows matching `(shard_id, epoch)` — some other
 *     node has fenced this one (bumped the epoch, e.g. the D4 wedged-writer eviction path) and
 *     this node's lease is gone even though it never lost its Postgres connection.
 *   - `PostgresDocStore`'s installed commit guard's epoch-predicated `UPDATE` matches zero rows —
 *     a straggler commit that raced a fencer and lost; the whole transaction aborts.
 *
 * Both are DEFINITIVE lease loss — exactly like a dropped connection — and are routed to
 * `LeaseMonitor.fenced()` for immediate exit (bypassing the probe-miss tolerance, which exists
 * only for transient/ambiguous blips; a fenced epoch is never ambiguous).
 */
export class FencedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FencedError";
  }
}
