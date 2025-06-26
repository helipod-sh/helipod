import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime, type IndexSpec } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { writtenTablesFromRanges, serializeKeyRange } from "@stackbase/index-key-codec";
import { jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import {
  InlineUdfExecutor,
  SimpleIndexCatalog,
  query,
  mutation,
  type RegisteredFunction,
} from "@stackbase/executor";
import {
  SyncProtocolHandler,
  createClientState,
  applyServerMessage,
  type SyncUdfExecutor,
  type SyncWebSocket,
  type ServerMessage,
  type SyncClientState,
} from "../src/index";

const MESSAGES = 10001;
const byConversation: IndexSpec = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "by_conversation",
  fields: ["conversationId"],
  indexId: encodeStorageIndexId(MESSAGES, "by_conversation"),
};

const sendMessage = mutation<{ conversationId: string; body: string }, string>({
  handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
});
const listByConversation = query<{ conversationId: string }, unknown[]>({
  handler: (ctx, { conversationId }) =>
    ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect(),
});
const modules: Record<string, RegisteredFunction> = {
  "messages:send": sendMessage,
  "messages:list": listByConversation,
};

class MockSocket implements SyncWebSocket {
  readonly messages: ServerMessage[] = [];
  bufferedAmount = 0;
  send(data: string): void {
    this.messages.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {}
  clear(): void {
    this.messages.length = 0;
  }
  transitions(): Extract<ServerMessage, { type: "Transition" }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: "Transition" }> => m.type === "Transition");
  }
}

let handler: SyncProtocolHandler;
let socketA: MockSocket;
let socketB: MockSocket;

function drainTo(state: SyncClientState, socket: MockSocket): void {
  for (const m of socket.messages) applyServerMessage(state, m);
}

const subscribe = (sessionId: string, queryId: number, udfPath: string, args: JSONValue) =>
  handler.handleMessage(sessionId, JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId, udfPath, args }], remove: [] }));
const mutate = (sessionId: string, requestId: string, udfPath: string, args: JSONValue) =>
  handler.handleMessage(sessionId, JSON.stringify({ type: "Mutation", requestId, udfPath, args }));

beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog().addIndex(byConversation);
  const exec = new InlineUdfExecutor({ transactor, queryRuntime, catalog });

  const syncExec: SyncUdfExecutor = {
    async runQuery(path, args) {
      const r = await exec.run(modules[path]!, jsonToConvex(args));
      return { value: r.value as Value, tables: writtenTablesFromRanges(r.readRanges), readRanges: r.readRanges.map(serializeKeyRange) };
    },
    async runMutation(path, args) {
      const r = await exec.run(modules[path]!, jsonToConvex(args));
      return { value: r.value as Value, tables: r.oplog?.writtenTables ?? [], writeRanges: r.oplog?.writtenRanges ?? [], commitTs: Number(r.oplog?.commitTs ?? 0) };
    },
  };

  handler = new SyncProtocolHandler(syncExec);
  socketA = new MockSocket();
  socketB = new MockSocket();
  handler.connect("sA", socketA);
  handler.connect("sB", socketB);
});

describe("subscribe → reactive push", () => {
  it("returns the initial query result, then pushes a transition when another client writes", async () => {
    await subscribe("sA", 1, "messages:list", { conversationId: "c1" });
    const clientA = createClientState();
    drainTo(clientA, socketA);
    expect(clientA.queries.get(1)).toEqual([]); // empty initially
    expect(clientA.needsResync).toBe(false);

    socketA.clear();
    socketB.clear();
    await mutate("sB", "r1", "messages:send", { conversationId: "c1", body: "hi" });

    // The writer got a mutation response; the subscriber got a reactive transition.
    expect(socketB.messages.some((m) => m.type === "MutationResponse" && m.success)).toBe(true);
    expect(socketA.transitions().length).toBe(1);

    drainTo(clientA, socketA);
    expect(clientA.needsResync).toBe(false);
    const rows = clientA.queries.get(1) as Array<{ body: string }>;
    expect(rows.map((d) => d.body)).toEqual(["hi"]);
  });

  it("range-level invalidation: a write to another conversation (different index range) does NOT recompute the c1 subscription", async () => {
    await mutate("sB", "seed", "messages:send", { conversationId: "c1", body: "keep" });
    await subscribe("sA", 1, "messages:list", { conversationId: "c1" });
    const clientA = createClientState();
    drainTo(clientA, socketA);

    socketA.clear();
    await mutate("sB", "r2", "messages:send", { conversationId: "c2", body: "other" });
    // Surgical range-level invalidation: c2 write is in a different index range than c1 subscription — NO re-run.
    expect(socketA.transitions().length).toBe(0);
    // The c1 result is unchanged (1 message, unaffected).
    expect((clientA.queries.get(1) as Array<{ body: string }>).map((d) => d.body)).toEqual(["keep"]);
  });
});

describe("version brackets", () => {
  it("a dropped transition makes the client resync from scratch", async () => {
    await subscribe("sA", 1, "messages:list", { conversationId: "c1" });
    socketA.clear();

    for (let i = 0; i < 3; i++) await mutate("sB", `m${i}`, "messages:send", { conversationId: "c1", body: `x${i}` });
    const ts = socketA.transitions();
    expect(ts.length).toBe(3);

    const client = createClientState();
    client.version = ts[0]!.startVersion; // client is caught up to just before the first
    applyServerMessage(client, ts[0]!); // applied
    expect(client.needsResync).toBe(false);
    // ts[1] is "dropped" (never delivered)
    applyServerMessage(client, ts[2]!); // start no longer matches → gap
    expect(client.needsResync).toBe(true);
  });
});

describe("ephemeral broadcast", () => {
  it("delivers to other sessions without touching the engine (no transition, no commit)", async () => {
    await subscribe("sA", 1, "messages:list", { conversationId: "c1" });
    socketA.clear();
    socketB.clear();

    await handler.handleMessage("sB", JSON.stringify({ type: "EphemeralPublish", topic: "typing", event: { userId: "u1" } }));

    // The other session got a Broadcast; no Transition was produced (the engine wasn't touched).
    expect(socketA.messages.some((m) => m.type === "Broadcast")).toBe(true);
    expect(socketA.transitions().length).toBe(0);
    // The publisher does not receive its own broadcast.
    expect(socketB.messages.some((m) => m.type === "Broadcast")).toBe(false);

    const clientA = createClientState();
    drainTo(clientA, socketA);
    expect(clientA.broadcasts).toEqual([{ topic: "typing", event: { userId: "u1" } }]);
  });
});
