/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Cross-process commit propagation for a Postgres-backed fleet (scale-seam #4, multi-process
 * variant): the in-memory `EmbeddedWriteFanoutAdapter` only fans a commit out within ONE process.
 * `NotifyingFanoutAdapter` (writer side) wraps it so every publish ALSO does
 * `pg_notify('stackbase_commits', …)`; each follower's `ReplicaTailer` (`replica-tailer.ts`)
 * LISTENs for that channel (plus a wall-clock poll fallback, since NOTIFY delivery is not
 * guaranteed while a listener connection is reconnecting) and, on each wake, verbatim-applies the
 * primary's MVCC log onto its local replica and derives what to invalidate from that same batch —
 * no in-process `OplogDelta` ever crosses a process boundary.
 *
 * The `CommitChannelClient` seam below (the LISTEN/NOTIFY + parameterized-query slice of
 * `NodePgClient`) is shared by both the writer-side adapter here and the follower-side
 * `ReplicaTailer`. The slice-1 `CommitTailer` (which derived-only, never applied to a replica)
 * was removed in slice 2 once `ReplicaTailer` subsumed it.
 */
import type { PgQuerier } from "@stackbase/docstore-postgres";
import type { EmbeddedWriteFanoutAdapter, EmbeddedWriteFanoutPayload, FanoutListener } from "@stackbase/runtime-embedded";

/** Exported (not just module-private) so other in-package NOTIFY senders — e.g. `node.ts`'s
 *  `FrontierMonitor` notify-on-advance (T3.5) — target the exact same channel a `ReplicaTailer`
 *  LISTENs on, without re-typing the literal a third time. */
export const COMMIT_CHANNEL = "stackbase_commits";

/**
 * The narrow slice of `NodePgClient` this module (and `ReplicaTailer`) depends on (LISTEN/NOTIFY
 * plus a plain parameterized query) — kept as a structural interface, matching the `PgClient` seam's
 * own philosophy of never tying engine/fleet logic to a concrete driver class. A `NodePgClient`
 * instance satisfies this; so does any test double that implements the same shape.
 */
export interface CommitChannelClient extends PgQuerier {
  /** LISTEN on `channel`; returns a closer. Rejecting (e.g. no LISTEN support) is tolerated by
   *  `ReplicaTailer.start()`, which falls back to poll-only. */
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
