import { describe, it, expect } from "vitest";
import { createTestHelipod } from "../../src";
import { anyApi } from "@helipod/client";
import * as messages from "../fixtures/messages";
import schema from "../fixtures/schema";

/**
 * Harness self-tests — these exercise `@helipod/test` itself (not an app), proving the
 * properties the rest of the conformance suite silently depends on: every `createTestHelipod()`
 * call is a fully independent backend (own in-memory SQLite `:memory:`, own temp blob dir), and
 * `close()` actually tears everything down rather than leaking timers/handles across instances.
 */
describe("harness — isolation", () => {
  it("two instances do not share data (each is its own SQLite :memory:)", async () => {
    const a = await createTestHelipod({ modules: { "messages.ts": messages, "schema.ts": { default: schema } } });
    const b = await createTestHelipod({ modules: { "messages.ts": messages, "schema.ts": { default: schema } } });
    try {
      await a.mutation("messages:send", { body: "only in a" });
      const rowsA = await a.query<{ body: string }[]>("messages:list", {});
      const rowsB = await b.query<{ body: string }[]>("messages:list", {});
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]!.body).toBe("only in a");
      expect(rowsB).toHaveLength(0); // b never saw a's write — separate backends entirely
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("close() leaves no leak: creating + closing 20 instances completes cleanly", async () => {
    // If `cleanup` failed to stop drivers / close the loopback client / close the underlying
    // SQLite docstore / remove the temp dir, this loop would accumulate open handles across
    // iterations and either hang the process or blow up resource limits (too many open fds/temp
    // dirs) well before reaching 20. Completing at all, within the test's own timeout, is the proof.
    for (let i = 0; i < 20; i++) {
      const t = await createTestHelipod({
        modules: { "messages.ts": messages, "schema.ts": { default: schema } },
      });
      await t.mutation("messages:send", { body: `iter ${i}` });
      await t.close();
    }
  });

  it("a string path and the equivalent anyApi-proxy ref resolve to the SAME function", async () => {
    const t = await createTestHelipod({ modules: { "messages.ts": messages, "schema.ts": { default: schema } } });
    try {
      await t.mutation("messages:send", { body: "via string path" });

      // `anyApi` is the untyped runtime proxy (see `packages/client/src/api.ts`) — cast to `any`
      // here since this test has no generated `Api` type to cast it to.
      const api = anyApi as any;
      const viaString = await t.query<{ body: string }[]>("messages:list", {});
      const viaProxy = await t.query<{ body: string }[]>(api.messages.list, {});
      expect(viaProxy).toEqual(viaString);

      const idViaProxy = await t.mutation<string>(api.messages.send, { body: "via proxy ref" });
      expect(typeof idViaProxy).toBe("string");
      const rows = await t.query<{ body: string }[]>("messages:list", {});
      expect(rows.map((r) => r.body)).toContain("via proxy ref");
    } finally {
      await t.close();
    }
  });

  describe("schema: 'auto'", () => {
    it("resolves the schema from the modules map's schema.ts (default) — a query over its table/index works", async () => {
      // No explicit `schema` option: 'auto' is the default, so `schema.ts` in `modules` is what
      // defines the table/index below (`messages` + its implicit `by_creation` index).
      const t = await createTestHelipod({
        modules: { "messages.ts": messages, "schema.ts": { default: schema } },
      });
      try {
        await t.mutation("messages:send", { body: "auto-schema" });
        const rows = await t.query<{ body: string }[]>("messages:list", {});
        expect(rows).toHaveLength(1);
        expect(rows[0]!.body).toBe("auto-schema");
      } finally {
        await t.close();
      }
    });

    it("rejects a wrong-typed write at runtime — schema validation is enforced", async () => {
      // See `test/conformance/validators.test.ts` for the full enforcement writeup: `Validator.check`
      // is now called on every insert/replace, so a value that doesn't match its schema type is
      // rejected with `DocumentValidationError` rather than round-tripping silently.
      const { mutation } = await import("@helipod/executor");
      const { defineSchema, defineTable, v } = await import("@helipod/values");
      const badSchema = defineSchema({ nums: defineTable({ n: v.number() }) });
      const mod = {
        insert: mutation(async (ctx: any, a: any) => ctx.db.insert("nums", a)),
      };
      const t = await createTestHelipod({ modules: { "mod.ts": mod, "schema.ts": { default: badSchema } } });
      try {
        await expect(t.mutation("mod:insert", { n: "not-a-number" })).rejects.toThrow(/does not match schema/);
      } finally {
        await t.close();
      }
    });
  });
});
