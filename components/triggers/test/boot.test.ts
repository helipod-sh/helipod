// components/triggers/test/boot.test.ts — handler-path validation (fail-fast) + cursor init (tip / fromStart)
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { mutation, query, action } from "@helipod/executor";
import { makeRuntimeWithTriggers, readCursors, testAppSchema } from "./helpers";

describe("@helipod/triggers — boot validation", () => {
  it("rejects an unknown handler path", async () => {
    await expect(
      makeRuntimeWithTriggers({}, { messages: { handler: "notifications:_onMessage" } }),
    ).rejects.toThrow(/unknown handler path|not a registered function/i);
  });

  it("rejects a non-internal (not `_`-prefixed) handler path", async () => {
    await expect(
      makeRuntimeWithTriggers(
        { "notifications:onMessage": mutation(async () => null) },
        { messages: { handler: "notifications:onMessage" } },
      ),
    ).rejects.toThrow(/internal/i);
  });

  it("rejects a handler that resolves to a query (wrong kind)", async () => {
    await expect(
      makeRuntimeWithTriggers(
        { "notifications:_onMessage": query(async () => null) },
        { messages: { handler: "notifications:_onMessage" } },
      ),
    ).rejects.toThrow(/mutation or action|not a mutation or action/i);
  });

  it("accepts an internal mutation handler and an internal action handler", async () => {
    const { runtime } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async () => null),
        "notifications:_onRoom": action(async () => null),
      },
      {
        messages: { handler: "notifications:_onMessage" },
        rooms: { handler: "notifications:_onRoom" },
      },
    );
    expect(runtime).toBeDefined();
  });

  it("a new (non-fromStart) trigger's cursor starts at the log's current tip — pre-existing history is not replayed", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());

    // Phase 1: a PLAIN runtime (no triggers component) writes history to `messages` BEFORE any
    // trigger is ever configured against this store.
    const schema = testAppSchema();
    const plain = composeComponents(
      { schemaJson: schema.export(), moduleMap: { "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })) } }, // eslint-disable-line @typescript-eslint/no-explicit-any
      [],
    );
    const plainRuntime = await EmbeddedRuntime.create({
      store,
      catalog: plain.catalog,
      modules: plain.moduleMap,
      tableNumbers: plain.tableNumbers,
    });
    await plainRuntime.run("app:insert", { body: "pre-existing-1" });
    await plainRuntime.run("app:insert", { body: "pre-existing-2" });

    // Phase 2: a SECOND runtime, over the SAME store, with a trigger newly configured on
    // `messages`. IMPORTANT: once this runtime exists, all further writes to the shared store go
    // through IT (not `plainRuntime` again) — `plainRuntime` and this runtime each carry their
    // own independent timestamp oracle seeded from `store.maxTimestamp()` at their own creation
    // time; writing through `plainRuntime` again now would race its stale oracle against this
    // runtime's, corrupting the log (two engines assigning the same next ts). `plainRuntime` is
    // used ONLY to seed history before this runtime is created, never after.
    const delivered: unknown[] = [];
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async (_ctx: any, a: { changes: unknown[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          delivered.push(...a.changes);
          return null;
        }),
        "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      { messages: { handler: "notifications:_onMessage" } },
      { store },
    );
    await tick("messages");

    expect(delivered).toEqual([]); // history NOT replayed
    const cursors = await readCursors(runtime);
    expect(cursors).toHaveLength(1);
    // `cursorTs` itself isn't asserted to an exact literal: it's a GLOBAL log timestamp, shared
    // across every table (including `triggers/cursors`'s own bookkeeping writes) — the invariant
    // under test is "the pre-existing history wasn't replayed" (asserted above via `delivered`),
    // not "the counter equals some hand-computed number."
    expect(cursors[0]).toMatchObject({ name: "messages", state: "running" });
    expect(cursors[0].cursorTs).toBeGreaterThanOrEqual(2); // at least past the 2 pre-existing commits

    // A NEW write after boot IS delivered.
    await runtime.run("app:insert", { body: "post-boot" });
    await tick("messages");
    expect(delivered).toHaveLength(1);
  });

  it("fromStart: true starts the cursor at ts 0 and replays existing history", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const schema = testAppSchema();
    const plain = composeComponents(
      { schemaJson: schema.export(), moduleMap: { "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })) } }, // eslint-disable-line @typescript-eslint/no-explicit-any
      [],
    );
    const plainRuntime = await EmbeddedRuntime.create({
      store,
      catalog: plain.catalog,
      modules: plain.moduleMap,
      tableNumbers: plain.tableNumbers,
    });
    await plainRuntime.run("app:insert", { body: "history-1" });
    await plainRuntime.run("app:insert", { body: "history-2" });

    const delivered: unknown[] = [];
    const { tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async (_ctx: any, a: { changes: unknown[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          delivered.push(...a.changes);
          return null;
        }),
      },
      { messages: { handler: "notifications:_onMessage", fromStart: true } },
      { store },
    );
    await tick("messages");

    expect(delivered).toHaveLength(2); // full historical replay
  });
});
