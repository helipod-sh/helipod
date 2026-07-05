// packages/component/test/compose-order.test.ts
//
// Regression coverage for the reviewer-flagged footgun: composeComponents validates `requires`
// presence but historically never REORDERED the input array, so a component listed BEFORE the
// sibling it `requires` saw an empty `cctx.components` at build time (a real TypeError footgun
// for @helipod/workflow, which reads `cctx.components.scheduler`). Fixed by a stable topological
// sort by `requires`, applied once at the top of composeComponents.
import { describe, it, expect } from "vitest";
import { defineSchema } from "@helipod/values";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { MonotonicTimestampOracle } from "@helipod/docstore";
import { SingleWriterTransactor } from "@helipod/transactor";
import { QueryRuntime } from "@helipod/query-engine";
import { InlineUdfExecutor, SimpleIndexCatalog, query, type ContextProvider } from "@helipod/executor";
import { defineComponent, type ComponentDefinition } from "../src/define-component";
import { composeComponents } from "../src/compose";

const emptySchema = defineSchema({});

async function harness(): Promise<InlineUdfExecutor> {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  return new InlineUdfExecutor({
    transactor: new SingleWriterTransactor(store, new MonotonicTimestampOracle()),
    queryRuntime: new QueryRuntime(store),
    catalog: new SimpleIndexCatalog(),
  });
}

function makeA(): ComponentDefinition {
  return defineComponent({
    name: "A",
    schema: emptySchema,
    modules: {},
    requires: ["B"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context: (cctx) => ({ sawB: (cctx.components as any).B?.marker === "B" }),
  });
}

function makeB(): ComponentDefinition {
  return defineComponent({ name: "B", schema: emptySchema, modules: {}, context: () => ({ marker: "B" }) });
}

/** Composes `components`, then runs a query that reads `ctx.A.sawB` and returns it. */
async function runASawB(components: ComponentDefinition[], providers?: ContextProvider[]): Promise<boolean> {
  const out = composeComponents({ schemaJson: emptySchema.export(), moduleMap: {} }, components);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = query(async (ctx) => (ctx as any).A.sawB as boolean);
  const exec = await harness();
  const r = await exec.run<boolean>(fn, {}, { contextProviders: providers ?? out.contextProviders });
  return r.value as boolean;
}

describe("composeComponents — topological ordering by requires", () => {
  it("A listed BEFORE its dependency B still sees B in cctx.components (the core fix)", async () => {
    expect(await runASawB([makeA(), makeB()])).toBe(true);
  });

  it("B listed before A (already-correct order) also works — order-independent", async () => {
    expect(await runASawB([makeB(), makeA()])).toBe(true);
  });

  it("throws on a requires cycle", () => {
    const a = defineComponent({ name: "A", schema: emptySchema, modules: {}, requires: ["B"] });
    const b = defineComponent({ name: "B", schema: emptySchema, modules: {}, requires: ["A"] });
    expect(() => composeComponents({ schemaJson: emptySchema.export(), moduleMap: {} }, [a, b])).toThrow(/cycle/);
  });

  it("still throws when a required component is missing (presence check unbroken)", () => {
    const a = defineComponent({ name: "A", schema: emptySchema, modules: {}, requires: ["missing"] });
    expect(() => composeComponents({ schemaJson: emptySchema.export(), moduleMap: {} }, [a])).toThrow(
      /component "A" requires "missing", which is not enabled/,
    );
  });

  it("preserves input order for independent components (stable sort, no gratuitous reordering)", () => {
    const x = defineComponent({ name: "X", schema: emptySchema, modules: {}, context: () => ({}) });
    const y = defineComponent({ name: "Y", schema: emptySchema, modules: {}, context: () => ({}) });
    const z = defineComponent({ name: "Z", schema: emptySchema, modules: {}, context: () => ({}) });
    const out = composeComponents({ schemaJson: emptySchema.export(), moduleMap: {} }, [x, y, z]);
    expect([...out.componentNames]).toEqual(["X", "Y", "Z"]);
    expect(out.contextProviders.map((p) => p.name)).toEqual(["X", "Y", "Z"]);
  });
});
