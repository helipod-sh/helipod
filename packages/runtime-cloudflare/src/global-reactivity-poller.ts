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
 * range-precise read-set tracking) and a plain monotone `commitTs` (a wall-clock/counter value, not
 * an oracle-issued timestamp).
 */

export interface GlobalReactivityDeps {
  /** Task 1: `D1DocStore.readVersions` — current per-table version counters. */
  readVersions(tables: string[]): Promise<Record<string, number>>;
  /** Task 4: `SubscriptionManager.subscribedGlobalTables()` — global tables with a live subscriber. */
  subscribedGlobalTables(): string[];
  /** `SyncProtocolHandler.notifyWrites` (or a narrowed facade over it). */
  notifyWrites(inv: { tables: string[]; ranges: never[]; commitTs: number }): Promise<void>;
  /** Clock for `commitTs`. Defaults to a monotone in-process counter (never the MVCC oracle). */
  now?(): number;
}

export class GlobalReactivityPoller {
  private readonly lastSeen = new Map<string, number>();
  private seq = 0;

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
        await this.deps.notifyWrites({ tables: [t], ranges: [], commitTs: this.deps.now?.() ?? ++this.seq });
      }
    }
  }
}
