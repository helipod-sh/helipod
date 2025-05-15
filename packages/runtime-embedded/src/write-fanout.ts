/**
 * The transactor→sync fan-out seam (scale-seam #4). A committed `OplogDelta` is published as
 * a fully-serializable payload to a swappable `EmbeddedWriteFanoutAdapter`. At Tier 0 the
 * adapter is in-memory; swap it for BroadcastChannel / Redis / Queues and the SAME fan-out
 * spans many processes — with no change to app code. Each fan-out tags its `originId` so a
 * subscriber can ignore its own writes (avoiding a self-loop across processes).
 */
import type { SerializedKeyRange } from "@stackbase/index-key-codec";
import type { OplogDelta, WriteFanout } from "@stackbase/transactor";

export interface EmbeddedWriteFanoutPayload {
  commitTs: number;
  tables: string[];
  ranges: SerializedKeyRange[];
  originId: string;
}

export type FanoutListener = (payload: EmbeddedWriteFanoutPayload) => void;

export interface EmbeddedWriteFanoutAdapter {
  publish(payload: EmbeddedWriteFanoutPayload): void;
  subscribe(listener: FanoutListener): () => void;
}

/** The default Tier 0 adapter: an in-process channel (also records what it published). */
export class InMemoryWriteFanoutAdapter implements EmbeddedWriteFanoutAdapter {
  private readonly listeners = new Set<FanoutListener>();
  readonly published: EmbeddedWriteFanoutPayload[] = [];

  publish(payload: EmbeddedWriteFanoutPayload): void {
    this.published.push(payload);
    for (const listener of this.listeners) listener(payload);
  }

  subscribe(listener: FanoutListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Implements the transactor's `WriteFanout` over a swappable adapter. */
export class EmbeddedWriteFanout implements WriteFanout {
  constructor(
    private readonly adapter: EmbeddedWriteFanoutAdapter,
    private readonly originId: string,
  ) {}

  publish(delta: OplogDelta): void {
    this.adapter.publish({
      commitTs: Number(delta.commitTs),
      tables: delta.writtenTables,
      ranges: delta.writtenRanges,
      originId: this.originId,
    });
  }

  /** Subscribe to deltas from OTHER origins (ignores our own — the Tier 2 self-loop guard). */
  subscribe(listener: FanoutListener): () => void {
    return this.adapter.subscribe((payload) => {
      if (payload.originId !== this.originId) listener(payload);
    });
  }
}
