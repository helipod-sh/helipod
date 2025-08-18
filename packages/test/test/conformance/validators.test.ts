import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

/**
 * Runtime validation semantics (DIVERGENCE: Stackbase does not runtime-validate — Convex does)
 * ---------------------------------------------------------------------------------------------
 * Convex validates every mutation/query `args` object AND every write against `schema.ts` field
 * validators, rejecting a mismatch before it ever reaches the handler / storage.
 *
 * Stackbase does NOT. Verified against source (`packages/executor/src/{functions,kernel}.ts`,
 * `packages/values/src/{validator,schema}.ts`):
 *
 *   - `mutation()`/`query()` (see `packages/executor/src/functions.ts`) take ONLY a handler.
 *     There is no `{ args: {...}, handler }` surface at all — no args-validator seam exists to
 *     bypass, because it was never built.
 *   - `Validator.check()` (`packages/values/src/validator.ts`) and `defineSchema`'s
 *     `schemaValidation` flag (`packages/values/src/schema.ts`) both EXIST as machinery, but nothing
 *     on the write path (`handleDbInsert`/`handleDbReplace` in `packages/executor/src/kernel.ts`)
 *     ever calls `check()`. `DocumentValidationError`/`ArgumentValidationError` are defined types
 *     that are never thrown by the engine.
 *
 * Net effect: `schema.ts` field types today are a TypeScript-only (compile-time) contract, not a
 * runtime one. A wrong-typed insert SUCCEEDS and the bad value round-trips exactly as written.
 * This is a documented gap (see CLAUDE.md's D5), not a bug for this suite to "fix" — these tests
 * PROVE the non-enforcement so the divergence stays discoverable and doesn't silently regress
 * into either direction unnoticed.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;

describe("conformance — runtime validation semantics (DIVERGENCE from Convex)", () => {
  let t: TestStackbase;

  afterEach(async () => {
    await t.close();
  });

  it("DIVERGES from Convex: a wrong-typed insert (string where v.number()) SUCCEEDS and round-trips the bad value", async () => {
    const schema = defineSchema({
      nums: defineTable({ n: v.number() }),
    });
    const mod = {
      insert: mutation(async (ctx: A, a: A) => ctx.db.insert("nums", a)),
      get: query(async (ctx: A, a: { id: string }) => ctx.db.get(a.id)),
    };
    t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });

    // Convex would reject this at the schema-validation boundary; Stackbase has no such boundary.
    const id = await t.mutation<string>("mod:insert", { n: "not-a-number" });
    const doc = (await t.query("mod:get", { id })) as Record<string, unknown>;
    expect(doc["n"]).toBe("not-a-number");
  });

  it("DIVERGES from Convex: v.union(literal, literal) does not reject a non-member value on write", async () => {
    const schema = defineSchema({
      statuses: defineTable({ status: v.union(v.literal("a"), v.literal("b")) }),
    });
    const mod = {
      insert: mutation(async (ctx: A, a: A) => ctx.db.insert("statuses", a)),
      get: query(async (ctx: A, a: { id: string }) => ctx.db.get(a.id)),
    };
    t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });

    // "c" is not "a" or "b" — Convex would reject; Stackbase accepts and stores it verbatim.
    const id = await t.mutation<string>("mod:insert", { status: "c" });
    const doc = (await t.query("mod:get", { id })) as Record<string, unknown>;
    expect(doc["status"]).toBe("c");
  });

  it("DIVERGES from Convex: a nested-object field accepts a wrong nested type", async () => {
    const schema = defineSchema({
      profiles: defineTable({
        settings: v.object({ retries: v.number() }),
      }),
    });
    const mod = {
      insert: mutation(async (ctx: A, a: A) => ctx.db.insert("profiles", a)),
      get: query(async (ctx: A, a: { id: string }) => ctx.db.get(a.id)),
    };
    t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });

    // `settings.retries` should be a number per schema; write a string instead.
    const id = await t.mutation<string>("mod:insert", { settings: { retries: "lots" } });
    const doc = (await t.query("mod:get", { id })) as Record<string, unknown>;
    expect((doc["settings"] as Record<string, unknown>)["retries"]).toBe("lots");
  });
});
