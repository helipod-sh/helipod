/**
 * M2c global reactivity: the poll → diff → `notifyWrites` mechanism.
 *
 * The DO's own MVCC oracle only sees writes routed through that DO's shard — it has no visibility
 * into writes another shard (or another DO entirely) makes to a GLOBAL (D1-backed) table. Global
 * tables are instead invalidated by polling D1's per-table version counters (Task 1's
 * `D1DocStore.readVersions`) and diffing against the last-seen version per table.
 *
 * `tick()` is the deterministic test seam — like the object-store tailer's `__pump`, it performs
 * exactly one poll-diff-notify pass with no timer/alarm involved. The alarm cadence that calls
 * `tick()` on a schedule is Task 6, not this file.
 *
 * Key semantic: **first-seen a table records its baseline version and does NOT invalidate.** A
 * subscription's initial query result is already delivered synchronously at subscribe time, so the
 * poller only needs to catch changes that happen AFTER that — not the version the table happened to
 * be at when the poller first noticed it. A subscribe landing between a write and the poller's
 * baseline read still observes current data at subscribe time, so this can't miss an update.
 *
 * This poller must NOT touch the MVCC oracle or `observeTimestamp` — it only ever calls
 * `notifyWrites` with an empty `ranges` (table-level invalidation only; global tables have no
 * range-precise read-set tracking), `global: true`, and a harmless placeholder `commitTs: 0`.
 *
 * M2c Critical fix (whole-branch review): a global invalidation's `commitTs` used to be sourced from
 * a wall-clock/counter clock (`now`) and fed straight into `SyncProtocolHandler`'s shared per-session
 * `version.ts` — the client-facing LOCAL-ts frontier. Global reactivity has its own clock (D1's
 * `_global_versions` counter); mixing the two on one shared scalar silently corrupted local
 * optimistic-update gating and local reconnect-resume for any session with both a local and a global
 * subscription. The fix: `commitTs` on a global invalidation is now WRITE-ONLY NOISE (`0`,
 * unconditionally) — `SyncProtocolHandler` never reads it for a `global: true` invalidation (see
 * `WriteInvalidation.global`'s doc in `@helipod/sync`), so the `now` clock this poller used to need
 * exists nowhere anymore and has been removed from {@link GlobalReactivityDeps} entirely.
 */

export interface GlobalReactivityDeps {
  /** Task 1: `D1DocStore.readVersions` — current per-table version counters. */
  readVersions(tables: string[]): Promise<Record<string, number>>;
  /** Task 4: `SubscriptionManager.subscribedGlobalTables()` — global tables with a live subscriber. */
  subscribedGlobalTables(): string[];
  /** `SyncProtocolHandler.notifyWrites` (or a narrowed facade over it). */
  notifyWrites(inv: { tables: string[]; ranges: never[]; commitTs: number; global: true }): Promise<void>;
}

export class GlobalReactivityPoller {
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly deps: GlobalReactivityDeps) {}

  /**
   * One poll-diff-notify pass. No-op (does not even call `readVersions`) when no global table has a
   * live subscriber.
   */
  async tick(): Promise<void> {
    const tables = this.deps.subscribedGlobalTables();

    // A table that lost all subscribers forgets its last-seen version, so a later re-subscribe
    // re-baselines instead of possibly firing a spurious invalidation for a gap it never observed.
    // Done BEFORE the zero-tables early return below: otherwise, if every global table loses its
    // last subscriber at once, this loop would never run (tick() would keep no-op'ing forever while
    // `tables` stays empty) and a stale `lastSeen` entry would linger to wrongly fire on resubscribe.
    for (const t of [...this.lastSeen.keys()]) if (!tables.includes(t)) this.lastSeen.delete(t);

    if (tables.length === 0) return;

    const versions = await this.deps.readVersions(tables);
    for (const t of tables) {
      const v = versions[t] ?? 0;
      const prev = this.lastSeen.get(t);
      if (prev === undefined) {
        // First sight of this table: record the baseline, don't invalidate (see file header).
        this.lastSeen.set(t, v);
        continue;
      }
      if (v > prev) {
        this.lastSeen.set(t, v);
        // M2c Critical fix: `commitTs: 0` is a harmless placeholder — a `global: true` invalidation
        // never has its `commitTs` read by `SyncProtocolHandler` (see this file's header doc + the
        // `WriteInvalidation.global` doc in `@helipod/sync`), so there is no clock to source here.
        await this.deps.notifyWrites({ tables: [t], ranges: [], commitTs: 0, global: true });
      }
    }
  }
}
