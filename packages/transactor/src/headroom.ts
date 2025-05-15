/**
 * Per-transaction resource limits ("headroom"). Bounds how much a single mutation can
 * read or write so a runaway function can't exhaust the engine. Tripping a limit throws
 * {@link HeadroomExceededError}, which (unlike a conflict) is NOT retried.
 */
export interface HeadroomLimits {
  maxReads: number;
  maxWrites: number;
}

export const DEFAULT_HEADROOM: HeadroomLimits = {
  maxReads: 4096,
  maxWrites: 4096,
};

export class HeadroomExceededError extends Error {
  override readonly name = "HeadroomExceededError";
  constructor(
    readonly kind: "reads" | "writes",
    readonly limit: number,
  ) {
    super(`transaction exceeded ${kind} limit (${limit})`);
  }
}

export class HeadroomTracker {
  private reads = 0;
  private writes = 0;

  constructor(private readonly limits: HeadroomLimits) {}

  countRead(): void {
    this.reads += 1;
    if (this.reads > this.limits.maxReads) throw new HeadroomExceededError("reads", this.limits.maxReads);
  }

  countWrite(): void {
    this.writes += 1;
    if (this.writes > this.limits.maxWrites) throw new HeadroomExceededError("writes", this.limits.maxWrites);
  }

  snapshot(): { reads: number; writes: number } {
    return { reads: this.reads, writes: this.writes };
  }
}
