import { describe, it, expect } from "vitest";
import { computeBackoff } from "../src/backoff";

describe("computeBackoff", () => {
  it("grows exponentially and applies 50–100% jitter", () => {
    const o = { initialBackoffMs: 250, base: 2 };
    // rng=0 → 50% of raw; rng=1 → 100% of raw. raw(attempts) = initialBackoffMs * base^(attempts+1).
    expect(computeBackoff(1, () => 0, o)).toBe(Math.round(250 * 2 ** 2 * 0.5)); // 500
    expect(computeBackoff(1, () => 1, o)).toBe(250 * 2 ** 2);                    // 1000
    expect(computeBackoff(2, () => 1, o)).toBe(250 * 2 ** 3);                    // 2000
  });
  it("is monotonic in attempts for a fixed rng", () => {
    const o = { initialBackoffMs: 250, base: 2 };
    expect(computeBackoff(3, () => 0.5, o)).toBeGreaterThan(computeBackoff(2, () => 0.5, o));
  });
});
