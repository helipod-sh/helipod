/**
 * G4 origin-frontier guarantee — end-to-end through the REAL handler + runtime + drain (client-sync
 * verdict §(d) item 2). A session that commits a mutation touching NOTHING it subscribes to still
 * receives a ts-advancing empty Transition, delivered via the actual commit fan-out: the origin tag
 * rides `executor.run` → `OplogDelta.origin` → the fan-out payload → the drain → `notifyWrites`.
 */
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@helipod/executor";
import type { IndexSpec } from "@helipod/query-engine";
import type { ServerMessage } from "@helipod/sync";
import { createEmbeddedRuntime } from "../src/index";

const MESSAGES = 10001;
const byConversation: IndexSpec = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "by_conversation",
  fields: ["conversationId"],
  indexId: encodeStorageIndexId(MESSAGES, "by_conversation"),
};

const modules: Record<string, RegisteredFunction> = {
  "messages:send": mutation<{ conversationId: string; body: string }, string>({
    handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
  }),
  "messages:list": query<{ conversationId: string }, unknown[]>({
    handler: (ctx, { conversationId }) =>
      ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect(),
  }),
};

async function makeRuntime() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog().addIndex(byConversation);
  return createEmbeddedRuntime({ store, catalog, modules });
}

type Transition = Extract<ServerMessage, { type: "Transition" }>;

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("G4 origin frontier — real runtime + drain", () => {
  it("a session that commits a mutation missing all its subscriptions still gets a ts-advancing empty Transition", async () => {
    const runtime = await makeRuntime();
    const conn = runtime.connect("sA");
    const received: ServerMessage[] = [];
    conn.onMessage((m) => received.push(m));

    // sA subscribes to conversation c1.
    await conn.send({
      type: "ModifyQuerySet",
      add: [{ queryId: 1, udfPath: "messages:list", args: { conversationId: "c1" } }],
      remove: [],
    });
    received.length = 0;

    // sA writes to a DIFFERENT conversation (c2) — a disjoint index range, so its own c1 subscription
    // is not invalidated. The commit still originated from sA, so its frontier must advance.
    await conn.send({ type: "Mutation", requestId: "r1", udfPath: "messages:send", args: { conversationId: "c2", body: "x" } });

    const resp = received.find((m) => m.type === "MutationResponse") as Extract<ServerMessage, { type: "MutationResponse"; success: true }>;
    expect(resp.ts).toBeGreaterThan(0);

    // The fan-out is async (drain) — wait for the empty frontier Transition to arrive.
    await waitFor(() => received.some((m) => m.type === "Transition"));
    const transitions = received.filter((m): m is Transition => m.type === "Transition");
    // No modifications (c1 didn't change), but the ts advanced to the mutation's commitTs.
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.modifications).toEqual([]);
    expect(transitions[0]!.endVersion.ts).toBe(resp.ts);
  });

  it("when the commit DOES hit the session's subscription, there is exactly one Transition (modifications + advance together)", async () => {
    const runtime = await makeRuntime();
    const conn = runtime.connect("sA");
    const received: ServerMessage[] = [];
    conn.onMessage((m) => received.push(m));

    await conn.send({
      type: "ModifyQuerySet",
      add: [{ queryId: 1, udfPath: "messages:list", args: { conversationId: "c1" } }],
      remove: [],
    });
    received.length = 0;

    await conn.send({ type: "Mutation", requestId: "r1", udfPath: "messages:send", args: { conversationId: "c1", body: "hi" } });
    const resp = received.find((m) => m.type === "MutationResponse") as Extract<ServerMessage, { type: "MutationResponse"; success: true }>;

    await waitFor(() => received.some((m) => m.type === "Transition"));
    const transitions = received.filter((m): m is Transition => m.type === "Transition");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.endVersion.ts).toBe(resp.ts);
    const mod = transitions[0]!.modifications[0]!;
    expect(mod).toMatchObject({ type: "QueryUpdated", queryId: 1 });
    const rows = (mod as unknown as { value: Array<{ body: string }> }).value;
    expect(rows.map((r) => r.body)).toEqual(["hi"]);
  });
});
