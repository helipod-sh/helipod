/**
 * Fleet B4, Task 4 — `HELIPOD_GROUP_COMMIT` env parsing (`groupCommitEnabled`, mirrors
 * `fleetMultiWriterEnabled`'s shape) and the pure `flushesPerSec` derivation (`deriveFlushesPerSec`)
 * `startFleetNode`'s health closure uses. Both are pure — no Postgres/fleet node needed; the
 * `runtimeOptions.groupCommit` threading through `prepareFleetNode` and the full `/api/health` shape
 * are covered by `packages/cli`'s `group-commit-config.test.ts`/`group-commit-health.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { groupCommitEnabled, deriveFlushesPerSec } from "../src/node";

describe("groupCommitEnabled", () => {
  const ENV_KEY = "HELIPOD_GROUP_COMMIT";
  const saved = process.env[ENV_KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("true for 1 / true / yes, case-insensitive", () => {
    for (const v of ["1", "true", "True", "TRUE", "yes", "YES"]) {
      process.env[ENV_KEY] = v;
      expect(groupCommitEnabled()).toBe(true);
    }
  });

  it("false for unset/blank/anything else — default OFF", () => {
    delete process.env[ENV_KEY];
    expect(groupCommitEnabled()).toBe(false);
    for (const v of ["", "0", "false", "no", "on", "garbage"]) {
      process.env[ENV_KEY] = v;
      expect(groupCommitEnabled()).toBe(false);
    }
  });
});

describe("deriveFlushesPerSec", () => {
  it("no prior sample (null prevReadMs) — reports 0", () => {
    expect(deriveFlushesPerSec(null, 0, 1000, 5)).toBe(0);
  });

  it("a positive flushCount delta over elapsed time — reports the rate", () => {
    // 10 flushes over 2000ms = 5/sec.
    expect(deriveFlushesPerSec(0, 0, 2000, 10)).toBe(5);
  });

  it("zero delta (flag off, or genuinely idle) — reports 0", () => {
    expect(deriveFlushesPerSec(0, 4, 1000, 4)).toBe(0);
  });

  it("clock hasn't advanced (or moved backward) — reports 0, not a division artifact", () => {
    expect(deriveFlushesPerSec(1000, 4, 1000, 9)).toBe(0);
    expect(deriveFlushesPerSec(1000, 4, 500, 9)).toBe(0);
  });

  it("never negative even if flushCount somehow appears to decrease (e.g. a counter reset)", () => {
    expect(deriveFlushesPerSec(0, 10, 1000, 4)).toBe(0);
  });
});
