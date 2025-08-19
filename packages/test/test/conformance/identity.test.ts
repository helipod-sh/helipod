// Documented divergence from Convex: Stackbase identity is a plain STRING token (resolved by the
// app's auth component and surfaced to user code only via a context provider — there is no bare
// `ctx.identity` on a plain UDF ctx), NOT Convex's stateless JWT-claims object. `withIdentity`
// therefore takes a string, not a claims object. This file is the executable record of that
// divergence: it composes the `identityProbe` test component (`ctx.probe.get()` reads
// `cctx.identity`) rather than asserting a fake/direct `ctx.identity`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { me, identityProbe } from "../fixtures/whoami";
import { defineSchema } from "@stackbase/values";

describe("conformance — identity", () => {
  let t: TestStackbase;

  beforeEach(async () => {
    t = await createTestStackbase({
      modules: { "whoami.ts": { me }, "schema.ts": { default: defineSchema({}) } },
      components: [identityProbe],
    });
  });

  afterEach(async () => {
    await t.close();
  });

  it("t.withIdentity(token) makes the probe read that string token", async () => {
    const asTokenA = t.withIdentity("tokenA");
    expect(await asTokenA.query("whoami:me", {})).toBe("tokenA");
  });

  it("the base view (no withIdentity) reads null", async () => {
    expect(await t.query("whoami:me", {})).toBeNull();
  });

  it("two identities on the same backend are independent, and the base view stays null", async () => {
    const asA = t.withIdentity("A");
    const asB = t.withIdentity("B");

    expect(await asA.query("whoami:me", {})).toBe("A");
    expect(await asB.query("whoami:me", {})).toBe("B");
    // Re-checking A after reading B confirms neither view's identity leaked into the other.
    expect(await asA.query("whoami:me", {})).toBe("A");
    expect(await t.query("whoami:me", {})).toBeNull();
  });
});
