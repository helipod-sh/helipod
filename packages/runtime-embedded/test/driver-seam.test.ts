import { describe, it, expect, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { defineSchema, defineTable, v } from "@helipod/values";
import { mutation } from "@helipod/executor";

describe("driver seam", () => {
  it("starts a component driver after boot; onCommit fires on a commit; runFunction runs a registered fn", async () => {
    const commits: number[] = [];
    let ran = 0;
    const driver = {
      name: "toy",
      start(ctx: any) {
        ctx.onCommit((inv: any) => { commits.push(inv.commitTs); void ctx.runFunction("toy:bump", {}); });
      },
    };
    const schema = defineSchema({ counters: defineTable({ n: v.number() }) });
    const c = composeComponents(
      { schemaJson: schema.export(), moduleMap: { "app:add": mutation(async (ctx) => ctx.db.insert("counters", { n: 1 })) } },
      [{ name: "toy", schema: defineSchema({}), modules: { bump: mutation(async () => { ran += 1; return null; }) }, driver }],
    );
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
      componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
      policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps, drivers: c.drivers,
    });
    await r.run("app:add", {});
    await new Promise((res) => setTimeout(res, 30)); // let the async commit fan-out + runFunction settle
    expect(commits.length).toBeGreaterThan(0);       // onCommit fired for the app:add commit
    expect(ran).toBeGreaterThan(0);                  // runFunction("toy:bump") executed
  });

  it("if driver 1 throws on onCommit, driver 2 still receives the commit", async () => {
    const driver1Commits: number[] = [];
    const driver2Commits: number[] = [];
    const driver1 = {
      name: "driver1",
      start(ctx: any) {
        ctx.onCommit((inv: any) => {
          driver1Commits.push(inv.commitTs);
          throw new Error("driver1 throws");
        });
      },
    };
    const driver2 = {
      name: "driver2",
      start(ctx: any) {
        ctx.onCommit((inv: any) => {
          driver2Commits.push(inv.commitTs);
        });
      },
    };
    const schema = defineSchema({ counters: defineTable({ n: v.number() }) });
    const c = composeComponents(
      { schemaJson: schema.export(), moduleMap: { "app:add": mutation(async (ctx) => ctx.db.insert("counters", { n: 1 })) } },
      [],
    );
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
      componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
      policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps,
      drivers: [driver1, driver2],
    });
    await r.run("app:add", {});
    await new Promise((res) => setTimeout(res, 100)); // let the async commit fan-out settle
    expect(driver1Commits.length).toBeGreaterThan(0);  // driver1's onCommit was called (and threw)
    expect(driver2Commits.length).toBeGreaterThan(0);  // driver2's onCommit was STILL called, not starved
  });

  it("stopDriversOnly stops drivers + resets the flag WITHOUT disposing the handler; startDrivers restarts (B2b, D5)", async () => {
    let starts = 0;
    let stops = 0;
    const commits: number[] = [];
    let unsub: (() => void) | undefined;
    const driver = {
      name: "toy",
      start(ctx: any) {
        starts += 1;
        unsub = ctx.onCommit((inv: any) => commits.push(inv.commitTs));
      },
      async stop() {
        stops += 1;
        unsub?.(); // a real driver unsubscribes its onCommit in stop()
      },
    };
    const schema = defineSchema({ counters: defineTable({ n: v.number() }) });
    const c = composeComponents(
      { schemaJson: schema.export(), moduleMap: { "app:add": mutation(async (ctx) => ctx.db.insert("counters", { n: 1 })) } },
      [{ name: "toy", schema: defineSchema({}), modules: {}, driver }],
    );
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
      componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
      policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps, drivers: c.drivers,
    });
    const disposeSpy = vi.spyOn(r.handler, "dispose");

    // Drivers started at create() (not deferred): a commit wakes the driver.
    await r.run("app:add", {});
    await new Promise((res) => setTimeout(res, 30));
    expect(starts).toBe(1);
    const afterFirst = commits.length;
    expect(afterFirst).toBeGreaterThan(0);

    // stopDriversOnly: driver stopped, handler NOT disposed, and a later commit does NOT wake the driver.
    await r.stopDriversOnly();
    expect(stops).toBe(1);
    expect(disposeSpy).not.toHaveBeenCalled(); // the sync handler keeps serving — never disposed
    await r.run("app:add", {});
    await new Promise((res) => setTimeout(res, 30));
    expect(commits.length).toBe(afterFirst); // driver did not run (onCommit unsubscribed, flag reset)

    // startDrivers restarts them — the one-way-flag regression (a write-once flag would no-op this).
    await r.startDrivers();
    expect(starts).toBe(2);
    await r.run("app:add", {});
    await new Promise((res) => setTimeout(res, 30));
    expect(commits.length).toBeGreaterThan(afterFirst); // driver runs again

    // Full teardown DOES dispose the handler (stopDrivers, unlike stopDriversOnly).
    await r.stopDrivers();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("notifyExternalCommit (fleet foreign-commit wake) fires onCommit with translated table names", async () => {
    const commits: Array<{ tables: string[]; commitTs: number }> = [];
    const driver = {
      name: "toy",
      start(ctx: any) {
        ctx.onCommit((inv: any) => commits.push({ tables: inv.tables, commitTs: inv.commitTs }));
      },
    };
    const schema = defineSchema({ counters: defineTable({ n: v.number() }) });
    const c = composeComponents(
      { schemaJson: schema.export(), moduleMap: { "app:add": mutation(async (ctx) => ctx.db.insert("counters", { n: 1 })) } },
      [{ name: "toy", schema: defineSchema({}), modules: {}, driver }],
    );
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
      componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
      policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps, drivers: c.drivers,
      tableNumbers: c.tableNumbers,
    });

    // Encode "counters"'s table number the same way `adapter.subscribe`'s real payload would
    // (a fleet's `AppliedInvalidation.writtenTables` carries this same encoded-storage-id shape —
    // see `replica-tailer.ts`'s doc comment on `AppliedInvalidation`).
    const { encodeStorageTableId } = await import("@helipod/id-codec");
    const countersTableNumber = c.tableNumbers["counters"]!;
    const encoded = encodeStorageTableId(countersTableNumber);

    r.notifyExternalCommit({ tables: [encoded], ranges: [], commitTs: 42 });
    await new Promise((res) => setTimeout(res, 10));

    expect(commits.length).toBe(1);
    expect(commits[0]!.tables).toEqual(["counters"]); // translated from the encoded id to the full name
    expect(commits[0]!.commitTs).toBe(42);
  });

  it("notifyExternalCommit is a no-op when no drivers are registered", async () => {
    const schema = defineSchema({ counters: defineTable({ n: v.number() }) });
    const c = composeComponents(
      { schemaJson: schema.export(), moduleMap: { "app:add": mutation(async (ctx) => ctx.db.insert("counters", { n: 1 })) } },
      [],
    );
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
      componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
      policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps,
      tableNumbers: c.tableNumbers,
    });
    // No registered driver → commitSubs is empty; must not throw.
    expect(() => r.notifyExternalCommit({ tables: ["1"], ranges: [], commitTs: 1 })).not.toThrow();
  });
});
