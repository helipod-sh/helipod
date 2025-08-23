/**
 * End-to-end: function ARGUMENT validation, enforced through the REAL dev server.
 *
 * Argument validation (a call whose args don't match the function's `args` validator throws
 * ArgumentValidationError) is enforced in the executor and proven there by unit tests. This
 * proves the WHOLE path works through the shipped `stackbase dev` server (real startDevServer +
 * loadProject, real HTTP), the "test through the shipped entrypoint" rule:
 *
 *   POST /api/run with well-typed args -> commits, read-back shows the row.
 *   POST /api/run with a wrong-typed arg -> 400 with an ARGUMENT_VALIDATION code, and the row is
 *     NOT persisted — the transaction never ran.
 */
import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { loadProject, startDevServer } from "../src/index";

const schema = defineSchema({ notes: defineTable({ body: v.string() }) });

const appModule = {
  add: mutation({
    args: { body: v.string() },
    handler: (ctx: any, { body }: { body: string }) => (ctx.db as any).insert("notes", { body }), // eslint-disable-line @typescript-eslint/no-explicit-any
  }),
  list: query<Record<string, never>, string[]>({
    handler: async (ctx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
      (await (ctx.db.query("notes", "by_creation") as any).collect()).map((d: { body: string }) => d.body),
  }),
};

describe("argument validation — end-to-end through the real dev server", () => {
  it("commits a well-typed call and rejects a wrong-typed one with ARGUMENT_VALIDATION", async () => {
    const project = loadProject({ schema, modules: { app: appModule } });
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
    });
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });

    try {
      // 1. Well-typed args commit.
      const ok = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:add", args: { body: "hello" } }),
      });
      expect(ok.status).toBe(200);

      const afterOk = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:list", args: {} }),
      });
      expect(((await afterOk.json()) as { value: string[] }).value).toEqual(["hello"]);

      // 2. Wrong-typed arg is rejected with ARGUMENT_VALIDATION; nothing persisted.
      const bad = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:add", args: { body: 123 } }),
      });
      expect(bad.status).toBe(400);
      const badBody = (await bad.json()) as { error: string; code: string };
      expect(badBody.code).toBe("ARGUMENT_VALIDATION");
      expect(badBody.error).toMatch(/do not match validator/);

      const afterBad = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:list", args: {} }),
      });
      // Still exactly the one valid row — the rejected call never ran.
      expect(((await afterBad.json()) as { value: string[] }).value).toEqual(["hello"]);
    } finally {
      await server.close();
    }
  });
});
