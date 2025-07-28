/**
 * `applyDeploy` — the server-side funnel for `stackbase deploy`: write the pushed tree, reuse
 * loadConvexDir -> push, gate on an additive-schema diff, then atomically swap modules/routes/
 * schema. All validation happens before the first swap, so a rejected deploy leaves the running
 * version fully live — proven here by re-exercising the previously-live function after each
 * rejected apply.
 *
 * Mirrors the fixture pattern of ../test/serve-e2e.test.ts (a real on-disk convex/ dir booted via
 * bootProject) and ../test/cli.test.ts's "hot reload (setModules)" (asserting a swap is live by
 * calling `runtime.run` before/after). `packageApp` (deploy.ts, Task 2) produces the `files` from
 * a real v2 fixture dir so this exercises the real transpile -> apply path, not a hand-built
 * files array.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootProject } from "../src/boot";
import { packageApp } from "../src/deploy";
import { applyDeploy, type DeployDeps } from "../src/deploy-apply";
import { loadConvexDir } from "../src/load-modules";
import { push } from "../src/push-pipeline";
import type { DeploySchema } from "../src/schema-diff";

/** A temp dir NESTED under packages/cli so `@stackbase/*` resolves via its node_modules
 * (Node/Bun module resolution walks up parent directories looking for node_modules). */
function cliDir(): string {
  return resolve(new URL(".", import.meta.url).pathname, "..");
}

function write(dir: string, file: string, content: string): void {
  writeFileSync(join(dir, file), content);
}

/**
 * Independently derive `{schemaJson, tableNumbers}` from a source convex/ dir — used to feed
 * `DeployDeps.current` without going through `AdminApi.getSchema()`, whose declared return type
 * (`SchemaJsonLike`, a narrower shape for the data browser) doesn't carry `documentType` and so
 * isn't assignable to `DeploySchema["schemaJson"]` (a separate wiring concern from applyDeploy
 * itself, which is what this test exercises).
 */
async function schemaOf(dir: string): Promise<{ schemaJson: DeploySchema["schemaJson"]; tableNumbers: Record<string, number> }> {
  const loaded = await loadConvexDir(dir);
  const { project } = push(loaded, []);
  return { schemaJson: project.schemaJson as DeploySchema["schemaJson"], tableNumbers: project.tableNumbers };
}

const SCHEMA_V1 = `
import { v, defineSchema, defineTable } from "@stackbase/values";
export default defineSchema({ items: defineTable({ name: v.string() }) });
`;

const ITEMS_V1 = `
import { query } from "@stackbase/executor";
export const list = query({
  handler: async (ctx) => (await ctx.db.query("items", "by_creation").collect()).map((d) => d.name),
});
`;

// v2: additive — adds an optional field + a mutation.
const SCHEMA_V2 = `
import { v, defineSchema, defineTable } from "@stackbase/values";
export default defineSchema({ items: defineTable({ name: v.string(), note: v.optional(v.string()) }) });
`;

const ITEMS_V2 = `
import { query, mutation } from "@stackbase/executor";
export const list = query({
  handler: async (ctx) => (await ctx.db.query("items", "by_creation").collect()).map((d) => d.name),
});
export const add = mutation({
  handler: (ctx, { name }) => ctx.db.insert("items", { name }),
});
`;

// v3: same additive schema as v2, but a module that throws on import.
const ITEMS_V3_BROKEN = `
import { query, mutation } from "@stackbase/executor";
throw new Error("boom - simulated load failure");
export const list = query({ handler: async () => [] });
export const add = mutation({ handler: () => null });
`;

// v4: destructive — drops the "items" table entirely.
const SCHEMA_V4_DESTRUCTIVE = `
import { defineSchema } from "@stackbase/values";
export default defineSchema({});
`;

describe("applyDeploy — write -> load -> diff -> atomic swap", () => {
  const base = mkdtempSync(join(cliDir(), "tmp-deploy-apply-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("valid additive v2 swaps live; a broken import and a destructive schema are both rejected without swapping", async () => {
    // --- v1: the initially-live project, booted through the real bootProject core. ---
    const v1Dir = join(base, "v1");
    mkdirSync(v1Dir);
    write(v1Dir, "schema.ts", SCHEMA_V1);
    write(v1Dir, "items.ts", ITEMS_V1);

    const { runtime, adminApi, store } = await bootProject({
      convexDir: v1Dir,
      dataPath: join(base, "db.sqlite"),
      adminKey: "k",
    });
    try {
      let liveRoutes: unknown[] = [];
      let liveSchema = await schemaOf(v1Dir);
      const deps: DeployDeps = {
        runtime,
        adminApi,
        setRoutes: (r) => { liveRoutes = r; },
        components: [],
        current: () => liveSchema,
        deployRoot: join(base, "deployRoot"),
      };

      // v1 has no `add` mutation yet.
      await expect(runtime.run("items:add", { name: "nope" })).rejects.toThrow(/unknown function/);

      /* ---------------------------------------------------------------- */
      /* 1. Valid additive v2 -> {ok:true}; the new fn is live afterward. */
      /* ---------------------------------------------------------------- */
      const v2SrcDir = join(base, "v2-src");
      mkdirSync(v2SrcDir);
      write(v2SrcDir, "schema.ts", SCHEMA_V2);
      write(v2SrcDir, "items.ts", ITEMS_V2);
      const filesV2 = await packageApp(v2SrcDir);

      const resultV2 = await applyDeploy(deps, filesV2);
      expect(resultV2.ok).toBe(true);
      if (!resultV2.ok) throw new Error("unreachable");
      expect(resultV2.rev).toMatch(/^[0-9a-f]{12}$/);
      expect(resultV2.functions).toBe(2); // items:list, items:add
      liveSchema = await schemaOf(v2SrcDir); // the swap succeeded — "current" is now v2's schema

      const added = await runtime.run<string>("items:add", { name: "a" });
      expect(added.committed).toBe(true);
      const list1 = await runtime.run<string[]>("items:list", {});
      expect(list1.value).toEqual(["a"]);
      expect(adminApi.getSchema().tableNumbers.items).toBeDefined();

      /* ---------------------------------------------------------------- */
      /* 2. A file that throws on import -> {ok:false, kind:"load-error"};*/
      /*    the OLD (v2) moduleMap still serves.                          */
      /* ---------------------------------------------------------------- */
      const v3SrcDir = join(base, "v3-src");
      mkdirSync(v3SrcDir);
      write(v3SrcDir, "schema.ts", SCHEMA_V2); // unchanged, still additive
      write(v3SrcDir, "items.ts", ITEMS_V3_BROKEN);
      const filesV3 = await packageApp(v3SrcDir);

      const resultV3 = await applyDeploy(deps, filesV3);
      expect(resultV3.ok).toBe(false);
      if (resultV3.ok) throw new Error("unreachable");
      expect(resultV3.kind).toBe("load-error");

      // v2's `add` mutation is still live — the swap never happened.
      const addedAfterBroken = await runtime.run<string>("items:add", { name: "b" });
      expect(addedAfterBroken.committed).toBe(true);
      const list2 = await runtime.run<string[]>("items:list", {});
      expect(list2.value.sort()).toEqual(["a", "b"]);

      /* ---------------------------------------------------------------- */
      /* 3. A destructive schema (drops the v1 table) ->                  */
      /*    {ok:false, kind:"schema-incompatible"}; no swap.              */
      /* ---------------------------------------------------------------- */
      const v4SrcDir = join(base, "v4-src");
      mkdirSync(v4SrcDir);
      write(v4SrcDir, "schema.ts", SCHEMA_V4_DESTRUCTIVE);
      const filesV4 = await packageApp(v4SrcDir);

      const resultV4 = await applyDeploy(deps, filesV4);
      expect(resultV4.ok).toBe(false);
      if (resultV4.ok) throw new Error("unreachable");
      expect(resultV4.kind).toBe("schema-incompatible");
      expect(resultV4.error).toMatch(/items.*removed/i);

      // Still v2 live: table + functions unaffected.
      expect(adminApi.getSchema().tableNumbers.items).toBeDefined();
      const list3 = await runtime.run<string[]>("items:list", {});
      expect(list3.value.sort()).toEqual(["a", "b"]);
      // `setRoutes` was only ever called for the successful v2 swap (an empty array — no http.ts).
      expect(liveRoutes).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rejects a path-traversal payload before writing anything outside the per-rev deploy dir", async () => {
    const v1Dir = join(base, "traversal-v1");
    mkdirSync(v1Dir);
    write(v1Dir, "schema.ts", SCHEMA_V1);
    write(v1Dir, "items.ts", ITEMS_V1);

    const { runtime, adminApi, store } = await bootProject({
      convexDir: v1Dir,
      dataPath: join(base, "traversal-db.sqlite"),
      adminKey: "k",
    });
    try {
      let liveRoutes: unknown[] = [];
      const liveSchema = await schemaOf(v1Dir);
      const deployRoot = join(base, "traversal-deployRoot");
      const deps: DeployDeps = {
        runtime,
        adminApi,
        setRoutes: (r) => { liveRoutes = r; },
        components: [],
        current: () => liveSchema,
        deployRoot,
      };

      const result = await applyDeploy(deps, [{ path: "../escape.js", code: "export const x = 1;" }]);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.kind).toBe("load-error");
      expect(result.error).toMatch(/invalid deploy payload/);

      // No swap: the original function is still live, and no file landed outside deployRoot.
      const list = await runtime.run<string[]>("items:list", {});
      expect(list.value).toEqual([]);
      expect(liveRoutes).toEqual([]);
      expect(existsSync(join(deployRoot, "escape.js"))).toBe(false);
      expect(existsSync(join(base, "escape.js"))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("rejects a non-string code payload before writing anything", async () => {
    const v1Dir = join(base, "badcode-v1");
    mkdirSync(v1Dir);
    write(v1Dir, "schema.ts", SCHEMA_V1);
    write(v1Dir, "items.ts", ITEMS_V1);

    const { runtime, adminApi, store } = await bootProject({
      convexDir: v1Dir,
      dataPath: join(base, "badcode-db.sqlite"),
      adminKey: "k",
    });
    try {
      const liveSchema = await schemaOf(v1Dir);
      const deps: DeployDeps = {
        runtime,
        adminApi,
        setRoutes: () => {},
        components: [],
        current: () => liveSchema,
        deployRoot: join(base, "badcode-deployRoot"),
      };

      const result = await applyDeploy(deps, [
        { path: "items.js", code: 123 as unknown as string },
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.kind).toBe("load-error");
      expect(result.error).toMatch(/invalid deploy payload/);

      const list = await runtime.run<string[]>("items:list", {});
      expect(list.value).toEqual([]);
    } finally {
      store.close();
    }
  });
});
