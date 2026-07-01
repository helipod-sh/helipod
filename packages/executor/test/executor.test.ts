import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime, type IndexSpec } from "@stackbase/query-engine";
import { encodeStorageIndexId, encodeStorageTableId } from "@stackbase/id-codec";
import {
  InlineUdfExecutor,
  SimpleIndexCatalog,
  query,
  mutation,
  action,
  QUERY_PROFILE,
  MUTATION_PROFILE,
  ACTION_PROFILE,
  createSeededRandom,
  type UdfResult,
} from "../src/index";

const MESSAGES = 10001;
const COUNTERS = 10002;

const byConversation: IndexSpec = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "by_conversation",
  fields: ["conversationId"],
  indexId: encodeStorageIndexId(MESSAGES, "by_conversation"),
};

// --- functions (what a user would write in their functions directory) ---
const sendMessage = mutation<{ conversationId: string; body: string }, string>({
  handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
});
const listByConversation = query<{ conversationId: string }, unknown[]>({
  handler: (ctx, { conversationId }) =>
    ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect(),
});
const getDoc = query<{ id: string }, unknown>({
  handler: (ctx, { id }) => ctx.db.get(id),
});
const editBody = mutation<{ id: string; conversationId: string; body: string }, void>({
  handler: (ctx, { id, conversationId, body }) => ctx.db.replace(id, { conversationId, body }),
});
const removeDoc = mutation<{ id: string }, void>({
  handler: (ctx, { id }) => ctx.db.delete(id),
});
const createCounter = mutation<Record<string, never>, string>({
  handler: (ctx) => ctx.db.insert("counters", { count: 0n }),
});
const increment = mutation<{ id: string }, void>({
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get(id);
    const count = (doc as { count: bigint } | null)?.count ?? 0n;
    await ctx.db.replace(id, { count: count + 1n });
  },
});

let exec: InlineUdfExecutor;
beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const catalog = new SimpleIndexCatalog().addIndex(byConversation).addTable("counters", COUNTERS);
  exec = new InlineUdfExecutor({ transactor, queryRuntime: new QueryRuntime(store), catalog });
});

const bodies = (r: UdfResult<unknown>) => (r.value as Array<{ body: string }>).map((d) => d.body);

describe("syscall-driven query + mutation (end to end through the JSON boundary)", () => {
  it("inserts via a mutation and reads it back via an indexed query (index maintenance)", async () => {
    await exec.run(sendMessage, { conversationId: "c1", body: "hello" });
    const res = await exec.run(listByConversation, { conversationId: "c1" });
    expect(bodies(res)).toEqual(["hello"]);
    expect(res.committed).toBe(false); // queries don't commit
    expect(res.readRanges.length).toBeGreaterThan(0); // recorded a read set for reactivity
  });

  it("keeps conversations isolated and ordered", async () => {
    await exec.run(sendMessage, { conversationId: "c1", body: "a" });
    await exec.run(sendMessage, { conversationId: "c1", body: "b" });
    await exec.run(sendMessage, { conversationId: "c2", body: "x" });

    expect(bodies(await exec.run(listByConversation, { conversationId: "c1" }))).toEqual(["a", "b"]);
    expect(bodies(await exec.run(listByConversation, { conversationId: "c2" }))).toEqual(["x"]);
  });

  it("a committed mutation produces an oplog delta over the messages table", async () => {
    const res = await exec.run(sendMessage, { conversationId: "c1", body: "hi" });
    expect(res.committed).toBe(true);
    expect(res.oplog!.writtenTables).toContain(encodeStorageTableId(MESSAGES));
    expect(typeof res.value).toBe("string"); // the new document id
  });

  it("supports get, replace, and delete", async () => {
    const id = (await exec.run<string>(sendMessage, { conversationId: "c1", body: "orig" })).value;
    expect((await exec.run<{ body: string }>(getDoc, { id })).value.body).toBe("orig");

    await exec.run(editBody, { id, conversationId: "c1", body: "edited" });
    expect((await exec.run<{ body: string }>(getDoc, { id })).value.body).toBe("edited");

    await exec.run(removeDoc, { id });
    expect((await exec.run(getDoc, { id })).value).toBeNull();
  });

  it("an edit moves the document within its index correctly", async () => {
    const id = (await exec.run<string>(sendMessage, { conversationId: "c1", body: "m" })).value;
    await exec.run(editBody, { id, conversationId: "c2", body: "m" }); // move c1 -> c2
    expect(bodies(await exec.run(listByConversation, { conversationId: "c1" }))).toEqual([]);
    expect(bodies(await exec.run(listByConversation, { conversationId: "c2" }))).toEqual(["m"]);
  });
});

describe("OCC through the executor", () => {
  it("concurrent increments don't lose updates (deterministic replay)", async () => {
    const id = (await exec.run<string>(createCounter, {})).value;
    await Promise.all([exec.run(increment, { id }), exec.run(increment, { id }), exec.run(increment, { id })]);
    const final = await exec.run<{ count: bigint }>(getDoc, { id });
    expect(final.value.count).toBe(3n);
  });
});

describe("determinism profiles + seeded RNG (the contract)", () => {
  it("queries/mutations forbid clock and network and seed randomness; actions are native", () => {
    expect(QUERY_PROFILE.capabilities).toMatchObject({ dbWrite: false, random: "seeded", clock: "forbidden", network: "forbidden" });
    expect(MUTATION_PROFILE.capabilities).toMatchObject({ dbWrite: true, random: "seeded", clock: "forbidden", network: "forbidden" });
    expect(ACTION_PROFILE.capabilities).toMatchObject({ random: "native", clock: "native", network: "native" });
  });

  it("seeded RNG is deterministic and in range", () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const seqA = [a.next(), a.next(), a.next()];
    const seqB = [b.next(), b.next(), b.next()];
    expect(seqA).toEqual(seqB);
    expect(createSeededRandom(1).next()).not.toBe(createSeededRandom(2).next());
    for (const x of seqA) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("the inline executor refuses actions (deferred slice)", async () => {
    const noop = action({ handler: () => 1 });
    await expect(exec.run(noop, {})).rejects.toThrow(/action/);
  });
});
