/**
 * The Gated Ledger — S1-S4 + the verdict §(c) reconciliation algorithm, driven through a REAL
 * `StackbaseClient`. Two harnesses (verdict §(h)):
 *  - REAL engine over a loopback transport (`newClient`) for the end-to-end gate behavior that
 *    depends on the origin-frontier feed: no-flicker, failure rollback, stacking, temp-id swap,
 *    wrong-guess self-heal, composed one-shot reads.
 *  - `MockTransport` for frames the engine can't be coaxed to produce on demand: the gate-timeout
 *    valve, resync-with-pending-layers, drop-at-close, replay-throw containment, the ts<=0 leak,
 *    the empty ts-advancing Transition, and the maxObservedTs reset.
 *
 * The no-flicker assertions collect EVERY listener frame and prove no frame ever shows the
 * reverted state across apply->confirm.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
import type { IndexSpec } from "@stackbase/query-engine";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, loopbackTransport, anyApi, MutationUndeliveredError, type ClientTransport, type OptimisticStoreView } from "../src/index";
import type { Value } from "@stackbase/values";
import type { ClientMessage, ServerMessage } from "@stackbase/sync";

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
  "messages:failSend": mutation<{ conversationId: string; body: string }, string>({
    handler: () => {
      throw new Error("send rejected server-side");
    },
  }),
};

const api = anyApi as {
  messages: { send: { __path: string }; list: { __path: string }; failSend: { __path: string } };
};

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** An optimistic append of `body` (with a temp id) to `messages:list` for `conversationId`. */
function appendUpdate(tempId: string): (store: OptimisticStoreView, args: Value) => void {
  return (store, rawArgs) => {
    const args = rawArgs as { conversationId: string; body: string };
    const list = store.getQuery(api.messages.list, { conversationId: args.conversationId }) as
      | Array<Record<string, Value>>
      | undefined;
    if (list === undefined) return;
    store.setQuery(api.messages.list, { conversationId: args.conversationId }, [
      ...list,
      { _id: tempId, _creationTime: 0, conversationId: args.conversationId, body: args.body } as Record<string, Value>,
    ]);
  };
}

let runtime: EmbeddedRuntime;
function newClient(session: string): StackbaseClient {
  return new StackbaseClient(loopbackTransport(runtime.connect(session)));
}

beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog().addIndex(byConversation);
  runtime = await createEmbeddedRuntime({ store, catalog, modules });
});

// ---- MockTransport: full control over the server frames ----------------------------------------
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
  lastMutationRequestId(): string {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i]!;
      if (m.type === "Mutation") return m.requestId;
    }
    throw new Error("no Mutation sent");
  }
}

const bodies = (v: unknown): string[] => (v as Array<{ body: string }>).map((d) => d.body);
const ids = (v: unknown): string[] => (v as Array<{ _id: string }>).map((d) => d._id);

// ================================================================================================
// REAL engine + loopback — the origin-frontier feed closes the gate.
// ================================================================================================
describe("Gated Ledger — real engine (origin-frontier feed)", () => {
  it("no-flicker: never shows the reverted state across apply -> confirm", async () => {
    const client = newClient("s1");
    const frames: string[][] = [];
    client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => frames.push(bodies(v)));
    await waitFor(() => frames.length >= 1);

    await client.mutation(api.messages.send, { conversationId: "c1", body: "seed" });
    await waitFor(() => frames.some((f) => f.length === 1));

    // Optimistic append: the layer applies synchronously here.
    await client.mutation(api.messages.send, { conversationId: "c1", body: "opt" }, { optimisticUpdate: appendUpdate("temp-1") });
    await waitFor(() => frames.filter((f) => f.length === 2).length >= 1);
    // let the covering transition settle
    await new Promise((r) => setTimeout(r, 30));

    const firstTwo = frames.findIndex((f) => f.length === 2);
    expect(firstTwo).toBeGreaterThan(-1);
    // From the first optimistic frame onward, the append never disappears (no revert flicker).
    for (let i = firstTwo; i < frames.length; i++) {
      expect(frames[i]!.length).toBeGreaterThanOrEqual(2);
      expect(frames[i]).toContain("opt");
    }
  });

  it("failure rollback: reject + full recompute back to server truth", async () => {
    const client = newClient("s1");
    const frames: string[][] = [];
    client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => frames.push(bodies(v)));
    await client.mutation(api.messages.send, { conversationId: "c1", body: "seed" });
    await waitFor(() => frames.some((f) => f.length === 1));

    const rejected = client
      .mutation(api.messages.failSend, { conversationId: "c1", body: "ghost" }, { optimisticUpdate: appendUpdate("temp-x") })
      .catch((e) => e as Error);
    // optimistic layer visible immediately
    expect(frames.at(-1)).toEqual(["seed", "ghost"]);

    const err = (await rejected) as Error;
    expect(err.message).toMatch(/rejected server-side/);
    await new Promise((r) => setTimeout(r, 20));
    expect(frames.at(-1)).toEqual(["seed"]); // rolled all the way back
  });

  it("stacked: A fails, B survives (ordered replay over the rolled-back base)", async () => {
    const client = newClient("s1");
    const frames: string[][] = [];
    client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => frames.push(bodies(v)));
    await client.mutation(api.messages.send, { conversationId: "c1", body: "seed" });
    await waitFor(() => frames.some((f) => f.length === 1));

    const aFails = client
      .mutation(api.messages.failSend, { conversationId: "c1", body: "A" }, { optimisticUpdate: appendUpdate("temp-a") })
      .catch(() => {});
    const bOk = client.mutation(api.messages.send, { conversationId: "c1", body: "B" }, { optimisticUpdate: appendUpdate("temp-b") });
    expect(frames.at(-1)).toEqual(["seed", "A", "B"]);

    await aFails;
    await new Promise((r) => setTimeout(r, 10));
    // A's layer gone; B survives over the base.
    expect(frames.at(-1)).toContain("B");
    expect(frames.at(-1)).not.toContain("A");
    await bOk;
  });

  it("temp-id atomic swap: drop + authoritative ingest in ONE frame (never a duplicate)", async () => {
    const client = newClient("s1");
    const frames: string[][] = [];
    const idFrames: string[][] = [];
    client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => {
      frames.push(bodies(v));
      idFrames.push(ids(v));
    });
    await waitFor(() => frames.length >= 1);

    await client.mutation(api.messages.send, { conversationId: "c1", body: "hi" }, { optimisticUpdate: appendUpdate("temp-1") });
    await new Promise((r) => setTimeout(r, 30));

    // The row count is never 2 for a single-message conversation (no temp+real duplicate frame).
    for (const f of idFrames) expect(f.length).toBeLessThanOrEqual(1);
    // Ends on the authoritative id, not the temp one.
    expect(idFrames.at(-1)!.length).toBe(1);
    expect(idFrames.at(-1)![0]).not.toBe("temp-1");
    expect(frames.at(-1)).toEqual(["hi"]);
  });

  it("wrong-guess self-heal: the covering Transition drops the bad layer; composed converges to server truth", async () => {
    const client = newClient("s1");
    const frames: string[][] = [];
    client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => frames.push(bodies(v)));
    await waitFor(() => frames.length >= 1);

    // Send "right" but optimistically predict "WRONG".
    const wrongGuess = (store: OptimisticStoreView, rawArgs: Value): void => {
      const args = rawArgs as { conversationId: string };
      const list = store.getQuery(api.messages.list, { conversationId: args.conversationId }) as unknown[] | undefined;
      if (list === undefined) return;
      store.setQuery(api.messages.list, { conversationId: args.conversationId }, [{ _id: "temp", _creationTime: 0, conversationId: args.conversationId, body: "WRONG" }]);
    };
    await client.mutation(api.messages.send, { conversationId: "c1", body: "right" }, { optimisticUpdate: wrongGuess });
    expect(frames.some((f) => f.includes("WRONG"))).toBe(true); // the bad guess was shown
    await waitFor(() => frames.at(-1)!.includes("right"), 1500);
    await new Promise((r) => setTimeout(r, 20));
    expect(frames.at(-1)).toEqual(["right"]); // healed to server truth, WRONG gone
  });

  it("client.query() returns the composed view (D15)", async () => {
    const client = newClient("s1");
    const frames: string[][] = [];
    client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => frames.push(bodies(v)));
    await waitFor(() => frames.length >= 1);
    // Hold an optimistic layer that never gates in this window by NOT awaiting; read composed immediately.
    void client.mutation(api.messages.send, { conversationId: "c1", body: "speculative" }, { optimisticUpdate: appendUpdate("temp-q") });
    const composed = bodies(await client.query(api.messages.list, { conversationId: "c1" }));
    expect(composed).toContain("speculative");
  });
});

// ================================================================================================
// MockTransport — deterministic frames.
// ================================================================================================
describe("Gated Ledger — controlled frames (MockTransport)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function baseSubscribe(t: MockTransport, client: StackbaseClient, seed: string[]): string[][] {
    const frames: string[][] = [];
    client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => frames.push(bodies(v)));
    t.emit({
      type: "Transition",
      startVersion: { querySet: 0, ts: 0 },
      endVersion: { querySet: 1, ts: 0 },
      modifications: [{ type: "QueryUpdated", queryId: 1, value: seed.map((b) => ({ body: b })) }],
    });
    return frames;
  }

  it("gate-timeout valve: a completed layer never gated drops after 10s with a warn", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    const frames = baseSubscribe(t, client, ["seed"]);

    void client.mutation(api.messages.send, { conversationId: "c1", body: "opt" }, { optimisticUpdate: appendUpdate("temp-1") });
    expect(frames.at(-1)).toEqual(["seed", "opt"]);
    const requestId = t.lastMutationRequestId();
    t.emit({ type: "MutationResponse", requestId, success: true, value: "id", ts: 5 }); // completed, not yet gated
    expect(frames.at(-1)).toEqual(["seed", "opt"]); // layer held

    vi.advanceTimersByTime(10_000);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not confirmed within 10000ms/));
    expect(frames.at(-1)).toEqual(["seed"]); // valve dropped it
    expect(client.__pending.length).toBe(0);
  });

  it("resync-with-pending-layers: in-session layers survive, rebuilt over the adopted baseline", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    const frames = baseSubscribe(t, client, ["seed"]);
    void client.mutation(api.messages.send, { conversationId: "c1", body: "opt" }, { optimisticUpdate: appendUpdate("temp-1") });
    expect(frames.at(-1)).toEqual(["seed", "opt"]);

    // A gapped Transition triggers a resync.
    t.emit({ type: "Transition", startVersion: { querySet: 9, ts: 9 }, endVersion: { querySet: 9, ts: 9 }, modifications: [] });
    // The adopted baseline (new server truth) — the inflight layer must be replayed over it.
    t.emit({
      type: "Transition",
      startVersion: { querySet: 99, ts: 99 },
      endVersion: { querySet: 2, ts: 3 },
      modifications: [{ type: "QueryUpdated", queryId: 1, value: [{ body: "seed" }, { body: "server2" }] }],
    });
    expect(frames.at(-1)).toEqual(["seed", "server2", "opt"]); // layer survived, rebuilt on the new base
  });

  it("drop-non-unsent-at-close: unsent retained, inflight rejects MutationUndeliveredError, completed drops", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    baseSubscribe(t, client, ["seed"]);

    const inflight = client.mutation(api.messages.send, { conversationId: "c1", body: "A" }, { optimisticUpdate: appendUpdate("temp-a") });
    const inflightReq = t.lastMutationRequestId();
    const completed = client.mutation(api.messages.send, { conversationId: "c1", body: "B" }, { optimisticUpdate: appendUpdate("temp-b") });
    const completedReq = t.lastMutationRequestId();
    t.emit({ type: "MutationResponse", requestId: completedReq, success: true, value: "idB", ts: 5 }); // -> completed
    await expect(completed).resolves.toBe("idB");
    expect(inflightReq).not.toBe(completedReq);

    client.close();

    await expect(inflight).rejects.toBeInstanceOf(MutationUndeliveredError);
    // After close, both A (inflight) and B (completed) layers are gone.
    expect(client.__pending.length).toBe(0);
    expect(client.__maxObservedTs).toBe(0); // frontier reset

    // A mutation issued while closed is retained as `unsent` (kept for a reconnect flush).
    const unsentFrames: string[][] = [];
    client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => unsentFrames.push(bodies(v)));
    void client.mutation(api.messages.send, { conversationId: "c1", body: "C" }, { optimisticUpdate: appendUpdate("temp-c") });
    expect(client.__pending.length).toBe(1);
    expect(client.__pending[0]!.status.type).toBe("unsent");
  });

  it("replay-throw containment: the throwing entry drops + warns, the rebuild completes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    const frames = baseSubscribe(t, client, ["seed"]);

    // This updater only throws when the base is empty — fine at initiation (base=[seed]).
    const throwsWhenEmpty = (store: OptimisticStoreView): void => {
      const list = store.getQuery(api.messages.list, { conversationId: "c1" }) as Value[] | undefined;
      if (list === undefined) return;
      if (list.length === 0) throw new Error("replay boom");
      store.setQuery(api.messages.list, { conversationId: "c1" }, [...list, { _id: "t", _creationTime: 0, conversationId: "c1", body: "layer" }]);
    };
    void client.mutation(api.messages.send, { conversationId: "c1", body: "x" }, { optimisticUpdate: throwsWhenEmpty });
    expect(frames.at(-1)).toEqual(["seed", "layer"]);

    // A Transition empties the base -> on replay the updater throws -> its layer drops, rebuild finishes.
    t.emit({
      type: "Transition",
      startVersion: { querySet: 1, ts: 0 },
      endVersion: { querySet: 1, ts: 1 },
      modifications: [{ type: "QueryUpdated", queryId: 1, value: [] }],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/threw during replay/), expect.anything());
    expect(frames.at(-1)).toEqual([]); // rebuilt cleanly to the (now empty) base
    expect(client.__pending.length).toBe(0);
  });

  it("ts<=0 leak: warn + drop the layer now", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    const frames = baseSubscribe(t, client, ["seed"]);
    void client.mutation(api.messages.send, { conversationId: "c1", body: "opt" }, { optimisticUpdate: appendUpdate("temp-1") });
    const requestId = t.lastMutationRequestId();
    expect(frames.at(-1)).toEqual(["seed", "opt"]);

    t.emit({ type: "MutationResponse", requestId, success: true, value: "id", ts: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no usable commitTs/));
    expect(frames.at(-1)).toEqual(["seed"]); // dropped now (one-frame flicker accepted over a wedge)
  });

  it("updater-throws-at-initiation: synchronous throw, nothing sent", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    baseSubscribe(t, client, ["seed"]);
    const before = t.sent.length;
    expect(() =>
      client.mutation(api.messages.send, { conversationId: "c1", body: "x" }, {
        optimisticUpdate: () => {
          throw new Error("init boom");
        },
      }),
    ).toThrow(/init boom/);
    // No Mutation frame was sent, and no layer lingers.
    expect(t.sent.length).toBe(before);
    expect(t.sent.some((m, i) => i >= before && m.type === "Mutation")).toBe(false);
    expect(client.__pending.length).toBe(0);
  });

  it("empty ts-advancing Transition (T2): event 2 gates a completed layer with zero special-casing", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    baseSubscribe(t, client, ["seed"]);
    void client.mutation(api.messages.send, { conversationId: "c1", body: "opt" }, { optimisticUpdate: appendUpdate("temp-1") });
    const requestId = t.lastMutationRequestId();
    t.emit({ type: "MutationResponse", requestId, success: true, value: "id", ts: 5 }); // completed, not gated
    expect(client.__pending.length).toBe(1);

    // A NORMAL Transition that happens to carry modifications: [] — advances ts, closes the gate.
    t.emit({ type: "Transition", startVersion: { querySet: 1, ts: 0 }, endVersion: { querySet: 1, ts: 5 }, modifications: [] });
    expect(client.__maxObservedTs).toBe(5);
    expect(client.__pending.length).toBe(0); // gated + dropped, no special-casing of the empty frame
  });

  it("events replay in requestId order", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    const frames = baseSubscribe(t, client, ["seed"]);
    void client.mutation(api.messages.send, { conversationId: "c1", body: "A" }, { optimisticUpdate: appendUpdate("temp-a") });
    void client.mutation(api.messages.send, { conversationId: "c1", body: "B" }, { optimisticUpdate: appendUpdate("temp-b") });
    expect(frames.at(-1)).toEqual(["seed", "A", "B"]); // A before B, deterministic order
  });

  it("maxObservedTs advances monotonically across transitions", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    baseSubscribe(t, client, ["seed"]);
    t.emit({ type: "Transition", startVersion: { querySet: 1, ts: 0 }, endVersion: { querySet: 1, ts: 4 }, modifications: [] });
    expect(client.__maxObservedTs).toBe(4);
  });

  it("maxObservedTs resets at close", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    baseSubscribe(t, client, ["seed"]);
    t.emit({ type: "Transition", startVersion: { querySet: 1, ts: 0 }, endVersion: { querySet: 1, ts: 7 }, modifications: [] });
    expect(client.__maxObservedTs).toBe(7);
    client.close();
    expect(client.__maxObservedTs).toBe(0);
  });

  it("T5: the optimisticUpdate closure runs BEFORE the Mutation frame hits the wire (order proof)", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    baseSubscribe(t, client, ["seed"]);
    const order: string[] = [];
    const sendSpy = vi.spyOn(t, "send");
    sendSpy.mockImplementation((m) => {
      if (m.type === "Mutation") order.push("send");
      MockTransport.prototype.send.call(t, m);
    });

    void client.mutation(api.messages.send, { conversationId: "c1", body: "opt" }, {
      optimisticUpdate: (store, args) => {
        order.push("update");
        appendUpdate("temp-1")(store, args);
      },
    });

    expect(order).toEqual(["update", "send"]); // the closure ran, and completed, before any send
    expect(t.sent.some((m) => m.type === "Mutation")).toBe(true);
  });
});
