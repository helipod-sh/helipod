/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */

/** Toolchain smoke: confirms the vitest-pool-workers project boots real workerd and the shard-DO
 *  binding resolves. If this fails, the real-workerd gate is unavailable in this environment (fall
 *  back to the deploy-ready rig — see ./README). */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("workerd toolchain smoke", () => {
  it("exposes the shard-DO binding", () => {
    expect(typeof (env as { STACKBASE_DO?: { idFromName?: unknown } }).STACKBASE_DO?.idFromName).toBe("function");
  });
});
