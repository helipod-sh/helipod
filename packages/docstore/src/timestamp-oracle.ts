import type { TimestampOracle } from "./types";

/**
 * The Tier 0 timestamp oracle: a simple in-memory monotonic counter. One instance per
 * shard. At Tier 2 a shard's committer owns its oracle; `observeTimestamp` lets a node
 * advance its clock past timestamps it learns from the change stream.
 */
export class MonotonicTimestampOracle implements TimestampOracle {
  private current: bigint;

  constructor(start: bigint = 0n) {
    this.current = start;
  }

  getCurrentTimestamp(): bigint {
    return this.current;
  }

  allocateTimestamp(): bigint {
    this.current += 1n;
    return this.current;
  }

  observeTimestamp(ts: bigint): void {
    if (ts > this.current) this.current = ts;
  }
}
