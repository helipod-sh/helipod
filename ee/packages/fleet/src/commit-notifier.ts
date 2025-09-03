/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Cross-process commit propagation for a Postgres-backed fleet (scale-seam #4, multi-process
 * variant): the in-memory `EmbeddedWriteFanoutAdapter` only fans a commit out within ONE process.
 * `NotifyingFanoutAdapter` wraps it so every publish ALSO does `pg_notify('stackbase_commits', …)`,
 * and `CommitTailer` on each follower LISTENs for that channel (plus a wall-clock poll fallback,
 * since NOTIFY delivery is not guaranteed while a listener connection is reconnecting) and derives
 * exactly what changed since its own watermark by reading the `indexes` MVCC log directly —
 * no in-process `OplogDelta` ever crosses a process boundary.
 *
 * `DerivedInvalidation.writtenKeys` carries raw `(indexId, key)` pairs, not point ranges — the
 * conversion into the sync handler's `WriteInvalidation.writtenRanges` shape happens where the
 * handler's range/key-codec types are already in scope (the caller wiring this to
 * `onInvalidation`), not here.
 */
import type { PgQuerier } from "@stackbase/docstore-postgres";
import type { PostgresDocStore } from "@stackbase/docstore-postgres";
import type { EmbeddedWriteFanoutAdapter, EmbeddedWriteFanoutPayload, FanoutListener } from "@stackbase/runtime-embedded";

const COMMIT_CHANNEL = "stackbase_commits";
const DEFAULT_POLL_MS = 1000;

/**
 * The narrow slice of `NodePgClient` this module depends on (LISTEN/NOTIFY plus a plain
 * parameterized query) — kept as a structural interface, matching the `PgClient` seam's own
 * philosophy of never tying engine/fleet logic to a concrete driver class. A `NodePgClient`
 * instance satisfies this; so does any test double that implements the same shape.
 */
export interface CommitChannelClient extends PgQuerier {
  /** LISTEN on `channel`; returns a closer. Rejecting (e.g. no LISTEN support) is tolerated by
   *  `CommitTailer.start()`, which falls back to poll-only. */
  listen(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>>;
  notify(channel: string, payload: string): Promise<void>;
}

/** Writer side: wraps the in-memory adapter; every publish ALSO does
 *  `pg_notify('stackbase_commits', String(commitTs))` so followers wake promptly instead of
 *  waiting out the poll interval. NOTIFY is a latency optimization only — the poll fallback in
 *  `CommitTailer` is the correctness path if it's ever dropped or a listener misses it. */
export class NotifyingFanoutAdapter implements EmbeddedWriteFanoutAdapter {
  constructor(
    private readonly inner: EmbeddedWriteFanoutAdapter,
    private readonly client: CommitChannelClient,
  ) {}

  publish(payload: EmbeddedWriteFanoutPayload): void {
    this.inner.publish(payload);
    // Fire-and-forget: a NOTIFY failure (e.g. transient connection hiccup) must not break the
    // in-process fan-out that just happened above — followers still catch up via the poll loop.
    void this.client.notify(COMMIT_CHANNEL, String(payload.commitTs)).catch(() => {});
  }

  subscribe(listener: FanoutListener): () => void {
    return this.inner.subscribe(listener);
  }
}

/** The raw rows derived from the `indexes` log since the tailer's watermark. Point-range
 *  conversion (`writtenKeys` → `WriteInvalidation.writtenRanges`) is the caller's job. */
export interface DerivedInvalidation {
  newMaxTs: bigint;
  /** DISTINCT `table_id` values touched, as strings (the storage-encoded table id). */
  writtenTables: string[];
  /** Raw written index keys — point invalidation input, NOT yet point ranges. */
  writtenKeys: Array<{ indexId: string; key: Uint8Array }>;
}

export interface CommitTailerOptions {
  /** Wall-clock poll fallback interval, in ms. Default 1000. */
  pollMs?: number;
  /** Invoked once per non-empty derived range, in watermark order. The watermark only advances
   *  after this resolves, so a slow/throwing handler can't cause a range to be skipped. */
  onInvalidation: (inv: DerivedInvalidation) => Promise<void>;
}

/** Sync side: LISTEN `stackbase_commits` + a `pollMs` wall-clock fallback. On every wake, derives
 *  what changed since the in-memory watermark straight from the `indexes` table and hands it to
 *  `onInvalidation`. */
export class CommitTailer {
  private readonly pollMs: number;
  private readonly onInvalidation: (inv: DerivedInvalidation) => Promise<void>;
  private watermark = 0n;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unlisten: (() => Promise<void>) | undefined;
  private stopped = true;
  /** Reentrancy guard: a NOTIFY wake and a poll tick can land back-to-back — only one
   *  derive-and-invalidate walk runs at a time, so `onInvalidation` never sees overlapping ranges. */
  private draining = false;

  constructor(
    private readonly client: CommitChannelClient,
    private readonly store: PostgresDocStore,
    opts: CommitTailerOptions,
  ) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.onInvalidation = opts.onInvalidation;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Seed the watermark to "now" so writes that committed before start() are never redelivered.
    this.watermark = await this.store.maxTimestamp();

    try {
      this.unlisten = await this.client.listen(COMMIT_CHANNEL, () => {
        void this.tick();
      });
    } catch {
      // LISTEN unsupported (e.g. a test double, or a transient connection issue) — the poll
      // loop below is the correctness path regardless, so this is not fatal to start().
      this.unlisten = undefined;
    }

    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.unlisten !== undefined) {
      const unlisten = this.unlisten;
      this.unlisten = undefined;
      await unlisten();
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      const newMaxTs = await this.store.maxTimestamp();
      if (newMaxTs <= this.watermark) return; // spurious wake — nothing new since last derive

      const rows = await this.client.query(
        `SELECT index_id, key, table_id, ts FROM indexes WHERE ts > $1 AND ts <= $2 ORDER BY ts ASC`,
        [this.watermark, newMaxTs],
      );
      if (rows.length === 0) return; // no index rows in range — no-op; watermark stays put

      // `table_id` is NULL on a "Deleted" index entry (see postgres-docstore.ts's `write()`) — skip
      // nulls so a pure-tombstone commit doesn't leak a bogus "null" string into writtenTables.
      const tableIds = new Set<string>();
      for (const r of rows) if (r.table_id !== null) tableIds.add(String(r.table_id));
      const writtenTables = [...tableIds];
      const writtenKeys = rows.map((r) => ({ indexId: String(r.index_id), key: r.key as Uint8Array }));
      await this.onInvalidation({ newMaxTs, writtenTables, writtenKeys });
      // Advance ONLY after onInvalidation resolves — a throwing/slow handler must not cause this
      // range to be silently skipped on the next tick.
      this.watermark = newMaxTs;
    } finally {
      this.draining = false;
    }
  }
}
