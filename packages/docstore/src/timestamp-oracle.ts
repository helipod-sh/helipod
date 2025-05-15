import type { TimestampOracle } from "./types";

/**
 * The Tier 0 timestamp oracle: a simple in-memory monotonic counter. One instance per
 * shard. At Tier 2 a shard's committer owns its oracle; `observeTimestamp` lets a node
 * advance its clock past timestamps it learns from the change stream.
 */
export class MonotonicTimestampOracle implements TimestampOracle {
  private current: bigint; // last allocated (possibly in-flight)
  private lastCommitted: bigint; // last fully applied

  constructor(start: bigint = 0n) {
    this.current = start;
    this.lastCommitted = start;
  }

  getCurrentTimestamp(): bigint {
    return this.current;
  }

  getLastCommittedTimestamp(): bigint {
    return this.lastCommitted;
  }

  allocateTimestamp(): bigint {
    this.current += 1n;
    return this.current;
  }

  publishCommitted(ts: bigint): void {
    if (ts > this.lastCommitted) this.lastCommitted = ts;
  }

  observeTimestamp(ts: bigint): void {
    if (ts > this.current) this.current = ts;
    if (ts > this.lastCommitted) this.lastCommitted = ts;
  }
}
