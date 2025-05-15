/**
 * A deterministic PRNG (mulberry32). Queries/mutations get one of these seeded from the
 * transaction so re-running a function (OCC replay, reactive recompute) yields identical
 * randomness — a hard requirement for determinism.
 */
export interface SeededRandom {
  /** Next float in [0, 1). */
  next(): number;
}

export function createSeededRandom(seed: number): SeededRandom {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
