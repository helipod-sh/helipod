import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents, type DriverContext } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { defineSchema, defineTable, v } from "@helipod/values";
import { mutation } from "@helipod/executor";
import { newDocumentId, encodeInternalDocumentId, type InternalDocumentId } from "@helipod/id-codec";
import type { DocStore, DocumentLogEntry } from "@helipod/docstore";

/** A raw log revision at `ts` (a `null` body = tombstone), for driving the store directly. */
function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body } } };
}

/**
 * Build a runtime over a fresh SQLite store, capturing its `DriverContext` (via a no-op driver whose
 * `start` records the ctx) plus the composed table-number map. Tests then write revisions DIRECTLY to
 * the returned store and call `ctx.readLog(...)` — deterministic, no commit-fan-out timing.
 */
async function harness(opts?: { stablePrefix?: () => Promise<bigint | null> }) {
  let ctx!: DriverContext;
  const driver = { name: "cap", start(c: DriverContext) { ctx = c; } };
  const app = { messages: defineTable({ body: v.string() }), rooms: defineTable({ body: v.string() }) };
  const schema = defineSchema(app);
  const c = composeComponents(
    { schemaJson: schema.export(), moduleMap: { "app:noop": mutation(async () => null) } },
    [{ name: "sys", schema: defineSchema({ log: defineTable({ body: v.string() }) }), modules: {}, driver }],
  );
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await EmbeddedRuntime.create({
    store, catalog: c.catalog, modules: c.moduleMap, componentNames: c.componentNames,
    contextProviders: c.contextProviders, policyRegistry: c.policyRegistry, policyProviders: c.policyProviders,
    relationRegistry: c.relationRegistry, bootSteps: c.bootSteps, drivers: c.drivers, tableNumbers: c.tableNumbers,
    ...(opts?.stablePrefix ? { stablePrefix: opts.stablePrefix } : {}),
  });
  return { ctx, store, tableNumbers: c.tableNumbers };
}

async function put(store: DocStore, revs: DocumentLogEntry[]): Promise<void> {
  for (const r of revs) await store.write([r], [], "Error");
}

describe("DriverContext.readLog", () => {
  it("derives op (insert/update/delete) and oldDoc via the prev_ts chain across a 3-revision doc", async () => {
    const { ctx, store, tableNumbers } = await harness();
    const id = newDocumentId(tableNumbers.messages!);
    await put(store, [
      rev(id, 1n, null, "v1"),  // insert
      rev(id, 2n, 1n, "v2"),    // update
      rev(id, 3n, 2n, null),    // delete
    ]);

    const { changes, maxScannedTs } = await ctx.readLog({ afterTs: 0 });
    expect(changes.map((c) => c.op)).toEqual(["insert", "update", "delete"]);
    expect(changes.map((c) => c.newDoc)).toEqual([{ body: "v1" }, { body: "v2" }, null]);
    expect(changes.map((c) => c.oldDoc)).toEqual([null, { body: "v1" }, { body: "v2" }]);
    expect(changes.map((c) => c.ts)).toEqual([1, 2, 3]);
    expect(maxScannedTs).toBe(3);

    const idStr = encodeInternalDocumentId(id);
    expect(changes[0]!.id).toBe(idStr);
    expect(changes.map((c) => c.changeId)).toEqual([
      `messages:${idStr}:1`,
      `messages:${idStr}:2`,
      `messages:${idStr}:3`,
    ]);
    expect(changes.every((c) => c.table === "messages")).toBe(true);
  });

  it("yields oldDoc null with op update when prev_ts points at a tombstone (delete→re-insert edge)", async () => {
    const { ctx, store, tableNumbers } = await harness();
    const id = newDocumentId(tableNumbers.messages!);
    await put(store, [
      rev(id, 1n, null, "v1"), // insert
      rev(id, 2n, 1n, null),   // delete (tombstone)
      rev(id, 3n, 2n, "v3"),   // re-insert reusing the id → prev_ts points at the tombstone
    ]);

    const { changes } = await ctx.readLog({ afterTs: 2 }); // only ts 3
    expect(changes).toHaveLength(1);
    expect(changes[0]!.op).toBe("update"); // value non-null + prev_ts non-null
    expect(changes[0]!.oldDoc).toBeNull(); // get(id, prev_ts) at a tombstone → null
    expect(changes[0]!.newDoc).toEqual({ body: "v3" });
  });

  it("filters `changes` to the requested tables while still scanning past the rest", async () => {
    const { ctx, store, tableNumbers } = await harness();
    const m = newDocumentId(tableNumbers.messages!);
    const room = newDocumentId(tableNumbers.rooms!);
    await put(store, [rev(m, 1n, null, "m1"), rev(room, 2n, null, "r1"), rev(m, 3n, null, "m2")]);

    const { changes, maxScannedTs } = await ctx.readLog({ afterTs: 0, tables: ["messages"] });
    expect(changes.map((c) => c.table)).toEqual(["messages", "messages"]);
    expect(changes.map((c) => c.ts)).toEqual([1, 3]);
    expect(maxScannedTs).toBe(3); // scanned past the rooms commit at ts 2 even though it wasn't matched
  });

  it("excludes component-namespaced tables from changes but still counts them toward maxScannedTs", async () => {
    const { ctx, store, tableNumbers } = await harness();
    const m = newDocumentId(tableNumbers.messages!);
    const sysLog = newDocumentId(tableNumbers["sys/log"]!);
    await put(store, [rev(m, 1n, null, "m1"), rev(sysLog, 2n, null, "internal"), rev(sysLog, 3n, null, "internal2")]);

    const { changes, maxScannedTs } = await ctx.readLog({ afterTs: 0 });
    expect(changes.map((c) => c.table)).toEqual(["messages"]); // sys/log revisions never surface
    expect(maxScannedTs).toBe(3); // but the cursor advances past them (no rescan creep)
  });

  it("advances maxScannedTs on a quiet watched table over a busy log (no rescan creep)", async () => {
    const { ctx, store, tableNumbers } = await harness();
    const room = newDocumentId(tableNumbers.rooms!);
    // Log is busy on `rooms`; `messages` (the watched table) is silent.
    await put(store, [rev(room, 1n, null, "r1"), rev(room, 2n, null, "r2"), rev(room, 3n, null, "r3")]);

    const { changes, maxScannedTs } = await ctx.readLog({ afterTs: 0, tables: ["messages"] });
    expect(changes).toHaveLength(0);
    expect(maxScannedTs).toBe(3); // advanced to the tip despite zero matches
  });

  it("without a stablePrefix accessor, the scan bound is maxTimestamp()", async () => {
    const { ctx, store, tableNumbers } = await harness();
    const m = newDocumentId(tableNumbers.messages!);
    await put(store, [rev(m, 1n, null, "m1"), rev(m, 2n, 1n, "m2"), rev(m, 3n, 2n, "m3")]);

    const { changes, maxScannedTs } = await ctx.readLog({ afterTs: 0 });
    expect(changes.map((c) => c.ts)).toEqual([1, 2, 3]);
    expect(maxScannedTs).toBe(3);
  });

  it("FLEET GAP: a stablePrefix F below the tip bounds the scan — nothing above F, maxScannedTs <= F", async () => {
    // Simulates the fleet commit pool: ts 4/5 have landed out of order while ts 3 was the last
    // gap-free commit. F = 3 (min frontier). readLog must NEVER surface ts 4/5, and must not advance
    // the cursor past F — otherwise a later-arriving ts below the gap would be permanently missed.
    const { ctx, store, tableNumbers } = await harness({ stablePrefix: async () => 3n });
    const m = newDocumentId(tableNumbers.messages!);
    await put(store, [
      rev(m, 1n, null, "m1"),
      rev(m, 2n, 1n, "m2"),
      rev(m, 3n, 2n, "m3"),
      rev(m, 4n, 3n, "m4"), // above F — in-flight, must not be observed
      rev(m, 5n, 4n, "m5"), // above F — in-flight, must not be observed
    ]);

    const { changes, maxScannedTs } = await ctx.readLog({ afterTs: 0 });
    expect(changes.map((c) => c.ts)).toEqual([1, 2, 3]); // strictly <= F
    expect(maxScannedTs).toBeLessThanOrEqual(3);
    expect(maxScannedTs).toBe(3);

    // A null return from stablePrefix (e.g. no shard rows yet) falls back to maxTimestamp().
    const { ctx: ctx2, store: store2, tableNumbers: tn2 } = await harness({ stablePrefix: async () => null });
    const m2 = newDocumentId(tn2.messages!);
    await put(store2, [rev(m2, 1n, null, "a"), rev(m2, 2n, 1n, "b")]);
    const r2 = await ctx2.readLog({ afterTs: 0 });
    expect(r2.changes.map((c) => c.ts)).toEqual([1, 2]);
    expect(r2.maxScannedTs).toBe(2);
  });

  it("limit bounds SCANNED entries; maxScannedTs never crosses a partially-scanned ts; resumes", async () => {
    const { ctx, store, tableNumbers } = await harness();
    const m = newDocumentId(tableNumbers.messages!);
    // Distinct-ts revisions 1..5 on the watched table.
    await put(store, [
      rev(m, 1n, null, "v1"), rev(m, 2n, 1n, "v2"), rev(m, 3n, 2n, "v3"),
      rev(m, 4n, 3n, "v4"), rev(m, 5n, 4n, "v5"),
    ]);

    // limit=2, all distinct ts → the last (possibly-partial) ts group is dropped; cursor stops below it.
    const page1 = await ctx.readLog({ afterTs: 0, limit: 2 });
    expect(page1.changes.map((c) => c.ts)).toEqual([1]);
    expect(page1.maxScannedTs).toBe(1);

    const page2 = await ctx.readLog({ afterTs: page1.maxScannedTs, limit: 2 });
    expect(page2.changes.map((c) => c.ts)).toEqual([2]);
    expect(page2.maxScannedTs).toBe(2);
  });

  it("delivers a single commit larger than the limit whole (degenerate same-ts group makes progress)", async () => {
    const { ctx, store, tableNumbers } = await harness();
    // Three docs committed at the SAME ts (one commit), with limit 2 < 3. The scan must not stall:
    // it re-reads the whole ts group and advances the cursor past it.
    const a = newDocumentId(tableNumbers.messages!);
    const b = newDocumentId(tableNumbers.messages!);
    const d = newDocumentId(tableNumbers.messages!);
    await store.write([rev(a, 1n, null, "a"), rev(b, 1n, null, "b"), rev(d, 1n, null, "d")], [], "Error");

    const page = await ctx.readLog({ afterTs: 0, limit: 2 });
    expect(page.changes).toHaveLength(3); // whole commit delivered
    expect(page.maxScannedTs).toBe(1);    // cursor advanced — no infinite loop
  });

  it("limit:0 peeks the current bound at O(1) cost — no scan, no crash — on a non-empty log", async () => {
    // Regression: a naive reading of `scanned.length === limit` (0 === 0) would fall into the
    // `limitHit` branch and crash on `scanned[scanned.length - 1]` (empty array) — see the `limit:
    // 0` special-case in `runtime.ts`'s `readLog`. `@helipod/triggers` relies on this exact idiom
    // to seed a new trigger's cursor at the log's current tip without paying for a scan.
    const { ctx, store, tableNumbers } = await harness();
    const m = newDocumentId(tableNumbers.messages!);
    await put(store, [rev(m, 1n, null, "v1"), rev(m, 2n, 1n, "v2")]);

    const peek = await ctx.readLog({ afterTs: 0, tables: [], limit: 0 });
    expect(peek.changes).toEqual([]);
    expect(peek.maxScannedTs).toBe(2); // the bound, not `afterTs` — the whole point of the peek

    // An empty log still returns the (trivial) bound, not a crash.
    const { ctx: ctxEmpty } = await harness();
    const peekEmpty = await ctxEmpty.readLog({ afterTs: 0, tables: [], limit: 0 });
    expect(peekEmpty).toEqual({ changes: [], maxScannedTs: 0 });
  });
});
