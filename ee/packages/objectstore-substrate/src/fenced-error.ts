/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Thrown when `ObjectStoreDocStore`'s manifest CAS loses the race — this writer's cached etag no
 * longer matches the shard's `s{shard}/manifest` object, meaning some other committer's write
 * already advanced it. The manifest CAS IS the fence for this substrate (design record §4/§7):
 * unlike `@stackbase/fleet`'s Postgres-epoch fence (`FencedError` on a zero-row epoch-predicated
 * UPDATE, see `ee/packages/fleet/src/fenced-error.ts`), here the fence is the object store's own
 * conditional-write primitive (`CasConflict` on `casPut`) rather than a database row.
 *
 * This package deliberately does NOT import `@stackbase/fleet`'s `FencedError` — the object-storage
 * substrate is an ALTERNATIVE single-shard store to fleet's Postgres store, not a consumer of it, and
 * the whole-arc plan keeps this package leaf-dependency-free of `ee/packages/fleet`. A later
 * multi-shard/failover slice over this substrate is expected to unify the two error types (or at
 * least their self-demote handling) once fleet-style writer promotion/relinquish lands here too.
 *
 * Same retry contract as fleet's: the transactor only OCC-retries `OccConflictError`. `FencedError`
 * is any other error as far as the transactor is concerned, so it propagates uncaught and is NEVER
 * retried — a fenced writer must stop (its cached manifest state is stale), not blindly resend the
 * same commit against a manifest that has already moved on.
 */
export class FencedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FencedError";
  }
}
