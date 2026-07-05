import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { SimpleIndexCatalog, query, mutation, action, type RegisteredFunction } from "@helipod/executor";
import type { IndexSpec } from "@helipod/query-engine";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, loopbackTransport, anyApi, memoryOutbox, type ClientTransport } from "../src/index";
import type { Value } from "@helipod/values";
import type { ClientMessage, ServerMessage } from "@helipod/sync";

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
  "messages:echo": action<{ body: string }, string>({
    handler: async (_ctx, { body }) => `echo:${body}`,
  }),
  "messages:boom": query<Record<string, never>, unknown>({
    handler: () => {
      throw new Error("kaboom");
    },
  }),
};

// Typed view of the runtime api proxy for the test.
const api = anyApi as {
  messages: { send: { __path: string }; list: { __path: string }; echo: { __path: string } };
};

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let runtime: EmbeddedRuntime;
function newClient(session: string): HelipodClient {
  return new HelipodClient(loopbackTransport(runtime.connect(session)));
}

beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog().addIndex(byConversation);
  runtime = await createEmbeddedRuntime({ store, catalog, modules });
});

describe("HelipodClient — reactive subscriptions", () => {
  it("delivers the initial result, then updates live when another client mutates", async () => {
    const clientA = newClient("sA");
    const clientB = newClient("sB");

    const updates: Array<Array<{ body: string }>> = [];
    clientA.subscribe(api.messages.list, { conversationId: "c1" }, (v) => updates.push(v as Array<{ body: string }>));
    await waitFor(() => updates.length >= 1);
    expect(updates[0]).toEqual([]); // initial empty

    await clientB.mutation(api.messages.send, { conversationId: "c1", body: "hi" });
    await waitFor(() => updates.length >= 2);
    expect(updates.at(-1)!.map((d) => d.body)).toEqual(["hi"]); // reactive update
  });

  it("dedupes identical subscriptions and cleans up on last unsubscribe", async () => {
    const client = newClient("s1");
    const a: Value[] = [];
    const b: Value[] = [];
    const unsubA = client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => a.push(v));
    const unsubB = client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => b.push(v));
    await waitFor(() => a.length >= 1 && b.length >= 1);
    expect(a[0]).toEqual([]);
    expect(b[0]).toEqual([]);
    unsubA();
    unsubB();
    // After both unsubscribe, a new mutation should not throw / leak (best-effort smoke).
    await newClient("s2").mutation(api.messages.send, { conversationId: "c1", body: "x" });
  });
});

describe("HelipodClient — one-shot query and mutation", () => {
  it("query() resolves with the current value", async () => {
    const client = newClient("s1");
    await client.mutation(api.messages.send, { conversationId: "c1", body: "seed" });
    const value = (await client.query(api.messages.list, { conversationId: "c1" })) as Array<{ body: string }>;
    expect(value.map((d) => d.body)).toEqual(["seed"]);
  });

  it("mutation() resolves with the function's return value", async () => {
    const client = newClient("s1");
    const id = await client.mutation(api.messages.send, { conversationId: "c1", body: "hi" });
    expect(typeof id).toBe("string");
  });

  it("action() resolves with the function's return value (one-shot, not reactive)", async () => {
    const client = newClient("s1");
    const value = await client.action(api.messages.echo, { body: "hi" });
    expect(value).toBe("echo:hi");
  });

  it("action() rejects when the target is an internal module (client can't reach `_`-paths)", async () => {
    const client = newClient("s1");
    await expect(client.action("scheduler:_enqueue", {})).rejects.toThrow();
  });
});

class MockTransport implements ClientTransport {
  readonly sent: ClientMessage[] = [];
  private readonly msg = new Set<(m: ServerMessage) => void>();
  private readonly closers = new Set<() => void>();
  send(m: ClientMessage): void {
    this.sent.push(m);
  }
  onMessage(l: (m: ServerMessage) => void): () => void {
    this.msg.add(l);
    return () => this.msg.delete(l);
  }
  onClose(l: () => void): () => void {
    this.closers.add(l);
    return () => this.closers.delete(l);
  }
  close(): void {
    for (const l of this.closers) l();
  }
  emit(m: ServerMessage): void {
    for (const l of this.msg) l(m);
  }
}

describe("HelipodClient — protocol safety", () => {
  it("a dropped transition (version gap) triggers a resync and never delivers stale values", async () => {
    const t = new MockTransport();
    const client = new HelipodClient(t);
    const seen: Array<Array<{ body: string }>> = [];
    client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => seen.push(v as Array<{ body: string }>));

    // DLR 2a: a non-outbox client advertises `supportsQueryDiff` via a capability-only Connect before
    // its first ModifyQuerySet, so the subscribe is the SECOND frame.
    expect(t.sent[0]!.type).toBe("Connect");
    expect(t.sent[1]!.type).toBe("ModifyQuerySet");
    // Initial transition (start {0,0} → {1,0}) — applied.
    t.emit({ type: "Transition", startVersion: { querySet: 0, ts: 0 }, endVersion: { querySet: 1, ts: 0 }, modifications: [{ type: "QueryUpdated", queryId: 1, value: [] }] });
    expect(seen.at(-1)).toEqual([]);

    // A GAPPED transition (startVersion does not match the client's {1,0}).
    const sentBefore = t.sent.length;
    t.emit({ type: "Transition", startVersion: { querySet: 1, ts: 5 }, endVersion: { querySet: 1, ts: 6 }, modifications: [{ type: "QueryUpdated", queryId: 1, value: [{ body: "STALE" }] }] });

    expect(seen.at(-1)).toEqual([]); // stale value NOT delivered
    expect(t.sent.length).toBeGreaterThan(sentBefore); // resync re-subscribe sent
    expect(t.sent.at(-1)!.type).toBe("ModifyQuerySet");

    // The resync reply is adopted regardless of its start version.
    t.emit({ type: "Transition", startVersion: { querySet: 99, ts: 99 }, endVersion: { querySet: 2, ts: 6 }, modifications: [{ type: "QueryUpdated", queryId: 1, value: [{ body: "fresh" }] }] });
    expect(seen.at(-1)!.map((d) => d.body)).toEqual(["fresh"]);
  });

  it("rejects pending mutations when the transport closes (no hung promises)", async () => {
    const t = new MockTransport();
    const client = new HelipodClient(t);
    const pending = client.mutation(api.messages.send, { conversationId: "c1", body: "x" });
    t.close();
    await expect(pending).rejects.toThrow(/connection closed/);
  });

  it("action() sends an Action message and resolves on the matching ActionResponse", async () => {
    const t = new MockTransport();
    const client = new HelipodClient(t);
    const pending = client.action(api.messages.echo, { body: "hi" });
    expect(t.sent.at(-1)).toMatchObject({ type: "Action", udfPath: "messages:echo", args: { body: "hi" } });
    const requestId = (t.sent.at(-1) as any).requestId;
    t.emit({ type: "ActionResponse", requestId, success: true, value: "echo:hi" });
    await expect(pending).resolves.toBe("echo:hi");
  });

  it("rejects pending actions when the transport closes (no hung promises)", async () => {
    const t = new MockTransport();
    const client = new HelipodClient(t);
    const pending = client.action(api.messages.echo, { body: "x" });
    t.close();
    await expect(pending).rejects.toThrow(/connection closed/);
  });
});

describe("HelipodClient — query failure surfacing (no silent QueryFailed drop)", () => {
  it("fires onError (and never onUpdate) when a subscribed query throws server-side", async () => {
    const client = newClient("sErr");
    const updates: unknown[] = [];
    const errors: string[] = [];
    client.subscribe(
      "messages:boom",
      {},
      (v) => updates.push(v),
      (e) => errors.push(e),
    );
    await waitFor(() => errors.length > 0);
    expect(errors[0]).toContain("kaboom");
    expect(updates).toEqual([]); // a failed query never delivers a value
  });

  it("query() rejects when the one-shot query throws, instead of hanging forever", async () => {
    const client = newClient("sErr2");
    await expect(client.query("messages:boom", {})).rejects.toThrow(/kaboom/);
  });
});

describe("HelipodClient — the OutboxStorage seam (Task 1: identity only)", () => {
  it("no-outbox-config byte-identity: a client constructed without `outbox` has no durable identity", () => {
    const client = newClient("sNoOutbox");
    expect(client.getOutboxIdentity()).toBeUndefined();
  });

  it("mints a durable clientId when constructed with an `outbox`", async () => {
    const client = new HelipodClient(loopbackTransport(runtime.connect("sOutbox1")), { outbox: memoryOutbox() });
    const identity = await client.getOutboxIdentity();
    expect(identity).toBeDefined();
    expect(typeof identity?.clientId).toBe("string");
    expect(identity?.clientId.length).toBeGreaterThan(0);
    expect(identity?.nextSeq).toBe(0);
  });

  it("two client instances sharing the same outbox mint DIFFERENT clientIds — never reused across a reload", async () => {
    const outbox = memoryOutbox();
    const a = new HelipodClient(loopbackTransport(runtime.connect("sOutboxA")), { outbox });
    const b = new HelipodClient(loopbackTransport(runtime.connect("sOutboxB")), { outbox });
    const [idA, idB] = await Promise.all([a.getOutboxIdentity(), b.getOutboxIdentity()]);
    expect(idA?.clientId).not.toBe(idB?.clientId);
  });

  it("the minted clientId's meta row is durable in the outbox itself", async () => {
    const outbox = memoryOutbox();
    const client = new HelipodClient(loopbackTransport(runtime.connect("sOutboxMeta")), { outbox });
    const identity = await client.getOutboxIdentity();
    expect(identity).toBeDefined();
    const meta = await outbox.getMeta(identity!.clientId);
    expect(meta).toEqual({ nextSeq: 0 });
  });
});
