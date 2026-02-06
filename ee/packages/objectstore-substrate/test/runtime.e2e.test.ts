/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Task 2.4 — the slice's HEADLINE E2E (design record §4/§6a/§7, whole-arc plan): the full engine —
 * transactor, query engine, and reactive read-set recording — runs over `ObjectStoreDocStore`, wired
 * through `createEmbeddedRuntime` exactly as `packages/cli/test/action-e2e.test.ts` wires it over a
 * plain `SqliteDocStore`. `createEmbeddedRuntime({ store })` takes an arbitrary `DocStore` — no engine
 * change was needed to plug the object-storage substrate in.
 *
 * Proves, through the REAL runtime (`runtime.run`, not the decorator directly):
 *   1. a mutation committed via the runtime lands durably in the bucket (object-first commit) AND is
 *      immediately readable through a query run on the SAME runtime;
 *   2. a SECOND, independent runtime — a fresh `ObjectStoreDocStore.open` over the SAME bucket, a
 *      fresh local SQLite store, a fresh `createEmbeddedRuntime` — bootstraps from the object log
 *      alone and serves the identical persisted rows through its own query. No Postgres anywhere.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import type { ObjectStore } from "@stackbase/objectstore";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { ObjectStoreDocStore } from "../src/object-doc-store";

const SHARD = "0";
const NOTES_TABLE_NUMBER = 40001;

// A `notes` schema — mirrors how an app would declare it (`defineSchema`/`defineTable`/`v`), even
// though this harness builds the runtime's `SimpleIndexCatalog` by hand (the same thing
// `packages/cli`'s `loadProject`/`composeComponents` does from a schema at codegen time — see
// `compose.ts`'s `DEFAULT_INDEX = "by_creation"`, `fields: []` convention, mirrored below).
const schema = defineSchema({ notes: defineTable({ body: v.string() }) });

const modules: Record<string, RegisteredFunction> = {
  "notes:add": mutation<{ body: string }, string>({
    handler: (ctx, { body }) => ctx.db.insert("notes", { body }),
  }),
  "notes:list": query<Record<string, never>, string[]>({
    handler: async (ctx) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await (ctx.db.query("notes", "by_creation") as any).collect()).map((d: { body: string }) => d.body),
  }),
};

function notesCatalog(): SimpleIndexCatalog {
  const documentType = schema.export().tables.notes!.documentType;
  return new SimpleIndexCatalog()
    .addTable("notes", NOTES_TABLE_NUMBER, documentType)
    .addIndex({
      table: "notes",
      tableNumber: NOTES_TABLE_NUMBER,
      index: "by_creation",
      fields: [],
      indexId: encodeStorageIndexId(NOTES_TABLE_NUMBER, "by_creation"),
    });
}

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

const dirs: string[] = [];
async function freshBucket(): Promise<ObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-runtime-e2e-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("the engine runs over ObjectStoreDocStore, wired through createEmbeddedRuntime", () => {
  it("a mutation committed through the runtime persists to a bucket, a query reads it back, and a FRESH runtime over the same bucket bootstraps and serves it — no Postgres", async () => {
    const bucket = await freshBucket();

    // ---- Runtime #1: commit through the real engine, over the object-storage substrate. ----
    const store1 = await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: freshLocal() });
    // Tier 3 Slice 4, Task 4.2: commits now require a held lease.
    const acquired = await store1.acquire({ writerId: "w", leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
    if (!acquired.acquired) throw new Error(`test setup: acquire() unexpectedly refused (heldBy ${acquired.heldBy})`);
    const runtime1 = await createEmbeddedRuntime({ store: store1, catalog: notesCatalog(), modules });

    const id1 = (await runtime1.run<string>("notes:add", { body: "first" })).value;
    const id2 = (await runtime1.run<string>("notes:add", { body: "second" })).value;
    expect(typeof id1).toBe("string");
    expect(typeof id2).toBe("string");

    // The transactor + query engine + reactive read-set recording all work over the object-storage
    // substrate — a plain `runtime.run` of the query proves the read path, exactly as
    // `action-e2e.test.ts` proves the write/subscribe path over `SqliteDocStore`.
    const list1 = (await runtime1.run<string[]>("notes:list", {})).value;
    expect(list1.sort()).toEqual(["first", "second"]);

    await store1.close();

    // ---- Runtime #2: a FRESH ObjectStoreDocStore.open over the SAME bucket, a fresh local store, a
    // fresh createEmbeddedRuntime — bootstrap-through-the-runtime. No coordination with #1. ----
    const store2 = await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: freshLocal() });
    const runtime2 = await createEmbeddedRuntime({ store: store2, catalog: notesCatalog(), modules });

    const list2 = (await runtime2.run<string[]>("notes:list", {})).value;
    expect(list2.sort()).toEqual(["first", "second"]);

    await store2.close();
  });
});
