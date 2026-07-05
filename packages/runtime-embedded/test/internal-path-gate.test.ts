// Security regression test: the public function-invocation gate must block ANY namespaced
// internal module (a path with a colon-delimited segment starting with `_`), not just paths
// whose FULL string starts with `_`. Before the fix, `path.startsWith("_")` never matched
// `scheduler:_enqueue` (it starts with "s"), so a raw client could call
// `runtime.run("scheduler:_enqueue", {...})` and schedule arbitrary privileged function
// dispatch, bypassing app-level authz entirely. See packages/runtime-embedded/src/runtime.ts.
//
// This test does NOT compose the scheduler component — it proves the gate blocks by SEGMENT
// (not merely "module absent") by registering a dummy module at a path with a `_` segment
// (`x:_secret`) alongside a legitimate public path (`x:public`), and asserting the gate
// rejects the former and allows the latter through.
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents } from "@helipod/component";
import { defineSchema, defineTable, v } from "@helipod/values";
import { query } from "@helipod/executor";
import { EmbeddedRuntime } from "../src/index";

async function makeRuntime(modules: Record<string, any>) {
  const schema = defineSchema({ notes: defineTable({ body: v.string() }) });
  const c = composeComponents({ schemaJson: schema.export(), moduleMap: modules }, []);
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
    componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
    policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps, drivers: c.drivers,
    tableNumbers: c.tableNumbers,
  });
}

describe("internal-path gate (segment-aware)", () => {
  it("blocks a client call to a namespaced internal-looking path (scheduler:_enqueue) via runtime.run", async () => {
    const r = await makeRuntime({
      "app:foo": query(async () => "ok"),
    });
    await expect(
      r.run("scheduler:_enqueue", { fnPath: "app:foo", args: {}, runAtMs: 0 }),
    ).rejects.toThrow(/unknown function/);
  });

  it("blocks scheduler:_peekDue via runtime.run and scheduler:_enqueue via runtime.runAction", async () => {
    const r = await makeRuntime({
      "app:foo": query(async () => "ok"),
    });
    await expect(r.run("scheduler:_peekDue", {})).rejects.toThrow(/unknown function/);
    await expect(
      r.runAction("scheduler:_enqueue", { fnPath: "app:foo", args: {}, runAtMs: 0 }),
    ).rejects.toThrow(/unknown function/);
  });

  it("blocks by SEGMENT, not by module absence: a registered path with a `_` segment is blocked, a registered public path succeeds", async () => {
    const r = await makeRuntime({
      "x:public": query(async () => "public-ok"),
      "x:_secret": query(async () => "should-never-be-reachable"),
    });
    // Legitimate public call succeeds (no false-positive block).
    const ok = await r.run("x:public", {});
    expect(ok.value).toBe("public-ok");
    // Internal-looking segment is blocked even though the module IS registered.
    await expect(r.run("x:_secret", {})).rejects.toThrow(/unknown function/);
  });

  it("still blocks legacy _admin:* / _system:*-style whole-path-prefixed internal paths", async () => {
    const r = await makeRuntime({
      "app:foo": query(async () => "ok"),
    });
    await expect(r.run("_admin:browseTable", {})).rejects.toThrow(/unknown function/);
    await expect(r.run("_system:insertJob", {})).rejects.toThrow(/unknown function/);
  });
});
