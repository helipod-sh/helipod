// components/triggers/test/helpers.ts
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { defineSchema, defineTable, v } from "@helipod/values";
import { query, type RegisteredFunction } from "@helipod/executor";
import { defineTriggers, type TriggersOpts, type TriggersDriver } from "../src/index";

/** Privileged raw-table scan — reads a fully-qualified table name (e.g. "triggers/cursors") bypassing the namespace boundary, mirroring `@helipod/scheduler`'s test helper. */
function systemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:scan": query(async (ctx, args: { table: string }) => await ctx.db.query(args.table, "by_creation").collect()),
  };
}

/** The app schema every test composes against: two watched tables (`messages`, `rooms`) plus one that no trigger watches (`unwatched`), so cross-table isolation is exercisable. */
export function testAppSchema() {
  return defineSchema({
    messages: defineTable({ body: v.string() }),
    rooms: defineTable({ body: v.string() }),
    unwatched: defineTable({ body: v.string() }),
  });
}

/**
 * Composes an `EmbeddedRuntime` with `@helipod/triggers` enabled. `opts.now` injects a
 * controllable virtual clock; `tick(name?)`/`wake(name?)` are the triggers driver's `__tick`/
 * `__wake` test seams (per-trigger or all-triggers) — see `../src/driver.ts`.
 *
 * Rejects (same as a real `helipod dev`/`serve` boot) if `triggersOpts` fails boot-time handler
 * validation — callers testing that path should `await expect(makeRuntimeWithTriggers(...))
 * .rejects.toThrow(...)` directly rather than destructuring the result.
 */
export async function makeRuntimeWithTriggers(
  appModules: Record<string, RegisteredFunction>,
  triggersOpts: TriggersOpts,
  opts?: { now?: () => number; store?: SqliteDocStore },
): Promise<{ runtime: EmbeddedRuntime; tick: (name?: string) => Promise<void>; wake: (name?: string) => void }> {
  const schema = testAppSchema();
  const c = composeComponents({ schemaJson: schema.export(), moduleMap: appModules }, [defineTriggers(triggersOpts)]);
  const runtime = await EmbeddedRuntime.create({
    store: opts?.store ?? new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: c.catalog,
    modules: c.moduleMap,
    systemModules: systemModules(),
    componentNames: c.componentNames,
    contextProviders: c.contextProviders,
    policyRegistry: c.policyRegistry,
    policyProviders: c.policyProviders,
    relationRegistry: c.relationRegistry,
    bootSteps: c.bootSteps,
    drivers: c.drivers,
    tableNumbers: c.tableNumbers,
    now: opts?.now,
  });
  const driver = c.drivers.find((d) => d.name === "triggers") as TriggersDriver | undefined;
  if (!driver) throw new Error("triggers driver not wired — defineTriggers() must set `driver: triggersDriver(opts)`");
  // `driver.start()` (run inside `EmbeddedRuntime.create()` above) fires an initial `wakeAll()`
  // fire-and-forget — NOT awaited by `create()` itself (a real commit-reactive driver has no
  // "finished starting" moment to wait for). Settle it deterministically here, once, before
  // handing the runtime to a test: without this, a test's very first write+tick could race the
  // implicit initial pass non-deterministically (which one's `targetBound` peek — see
  // `../src/driver.ts`'s `runPass` — lands first is a transactor-queuing detail, not something a
  // test should have to reason about). After this settles, every configured trigger's cursor is
  // caught up exactly to "the tip as of `makeRuntimeWithTriggers` returning" (or replayed to that
  // point, for a `fromStart` trigger) — a clean, predictable baseline for the rest of a test.
  await driver.__tick();
  return { runtime, tick: (name?: string) => driver.__tick(name), wake: (name?: string) => driver.__wake(name) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readTable(runtime: EmbeddedRuntime, table: string): Promise<any[]> {
  const r = await runtime.runSystem<unknown[]>("_system:scan", { table });
  return r.value as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readCursors(runtime: EmbeddedRuntime): Promise<any[]> {
  return readTable(runtime, "triggers/cursors");
}
