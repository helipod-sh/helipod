// Documented divergence from Convex: Helipod identity is a plain STRING token (resolved by the
// app's auth component and surfaced to user code only via a context provider — there is no bare
// `ctx.identity` on a plain UDF ctx), NOT Convex's stateless JWT-claims object. `withIdentity`
// therefore takes a string, not a claims object. This file is the executable record of that
// divergence: it composes the `identityProbe` test component (`ctx.probe.get()` reads
// `cctx.identity`) rather than asserting a fake/direct `ctx.identity`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHelipod, type TestHelipod } from "../../src";
import { me, identityProbe } from "../fixtures/whoami";
import * as httpFixture from "../fixtures/http";
import { defineSchema } from "@helipod/values";
import { action, mutation } from "@helipod/executor";

// Local (test-only) probes composing the SAME `identityProbe` component fixture from a
// mutation/action ctx, so we can assert identity threading through every function kind without
// touching the shared fixtures (`whoami.ts`'s `identityProbe` already exposes both `context` (used
// here by `meMutation`) and `buildAction` (used by `meAction`) variants — see its own comment).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const meMutation = mutation(async (ctx: any) => ctx.probe.get());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const meAction = action(async (ctx: any) => ctx.probe.get());
// An action nesting BOTH a `ctx.runQuery` (into the fixture's `whoami:me`) and a `ctx.runMutation`
// (into this file's own `probes:meMutation`) — proves the outer action's ambient identity survives
// into a fresh nested top-level run, for both nested kinds.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const meViaNestedRuns = action(async (ctx: any) => ({
  viaRunQuery: await ctx.runQuery("whoami:me", {}),
  viaRunMutation: await ctx.runMutation("probes:meMutation", {}),
}));

describe("conformance — identity", () => {
  let t: TestHelipod;

  beforeEach(async () => {
    t = await createTestHelipod({
      modules: {
        "whoami.ts": { me },
        "probes.ts": { meMutation, meAction, meViaNestedRuns },
        "http.ts": httpFixture,
        "schema.ts": { default: defineSchema({}) },
      },
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

  it("a mutation-side probe reads the ambient identity, same as a query", async () => {
    const asTok = t.withIdentity("mut-tok");
    expect(await asTok.mutation("probes:meMutation", {})).toBe("mut-tok");
  });

  it("the buildAction probe variant sees the ambient identity when invoked as an action", async () => {
    const asTok = t.withIdentity("action-tok");
    expect(await asTok.action("probes:meAction", {})).toBe("action-tok");
  });

  it("a nested ctx.runQuery/ctx.runMutation call under an ambient identity still sees that identity", async () => {
    const asTok = t.withIdentity("nested-tok");
    expect(await asTok.action("probes:meViaNestedRuns", {})).toEqual({
      viaRunQuery: "nested-tok",
      viaRunMutation: "nested-tok",
    });
  });

  it("t.fetch threads a view's withIdentity token into an httpAction's ctx, taking precedence over any Authorization header", async () => {
    const asTok = t.withIdentity("http-tok");
    const res = await asTok.fetch(new Request("http://t/whoami", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identity: "http-tok" });

    // Precedence: the view's identity wins even when the raw request carries its own bearer token.
    const withHeader = await asTok.fetch(
      new Request("http://t/whoami", { method: "GET", headers: { authorization: "Bearer header-tok" } }),
    );
    expect(await withHeader.json()).toEqual({ identity: "http-tok" });

    // The base (no-identity) view falls back to the request's own Authorization header.
    const headerOnly = await t.fetch(
      new Request("http://t/whoami", { method: "GET", headers: { authorization: "Bearer header-tok" } }),
    );
    expect(await headerOnly.json()).toEqual({ identity: "header-tok" });
  });
});
