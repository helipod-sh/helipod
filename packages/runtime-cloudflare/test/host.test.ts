/**
 * The DO host, end-to-end through `HelipodDurableObject` over the DO-SQLite stand-in (API-shape
 * fidelity — see `do-harness.ts`). Proves the whole orchestration the real-Cloudflare E2E will later
 * confirm on workerd: boot, health, a committing `/api/run` mutation + read-back, the reactive
 * subscribe→commit→push fan-out across two sockets, hibernation-rehydrate from the attachment, the
 * per-socket subscription cap, and the wake alarm firing due driver timers.
 */
import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@helipod/values";
import { query, mutation } from "@helipod/executor";
import type { LoadedProject } from "@helipod/cli/project";
import { HelipodDurableObject, type DurableObjectAppConfig, MAX_SUBSCRIPTIONS_PER_SOCKET } from "../src/index";
import { FakeDoState, FakeDoStorage, FakeDoWebSocket, waitFor } from "./do-harness";

// workerd exposes `WebSocketRequestResponsePair` as a global (for `setWebSocketAutoResponse`); Node
// does not. Shim it so the host's keepalive-arming path runs under the stand-in.
(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair = class {
  constructor(
    public request: string,
    public response: string,
  ) {}
};

/* ------------------------------- the fixture app ------------------------------ */

const schema = defineSchema({
  messages: defineTable({ conversationId: v.id("conversations"), body: v.string() }).index("by_conversation", ["conversationId"]),
  conversations: defineTable({ title: v.string() }),
});
const messagesModule = {
  send: mutation<{ conversationId: string; body: string }, string>({
    handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
  }),
  list: query<{ conversationId: string }, unknown[]>({
    handler: (ctx, { conversationId }) =>
      ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect(),
  }),
};
const loaded: LoadedProject = { schema, modules: { messages: messagesModule } };
const ADMIN_KEY = "test-admin-key";

/** A concrete DO the fixture app statically injects (what the Worker-entry codegen would emit). */
class TestDO extends HelipodDurableObject {
  protected appConfig(): DurableObjectAppConfig {
    return { loaded, adminKey: ADMIN_KEY };
  }
}

function post(path: string, bodyObj: unknown, auth?: string): Request {
  return new Request(`https://do.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(bodyObj),
  });
}

/** Accept a fake socket into the DO (mirrors an upgrade): stamp a fresh attachment + enroll it, then
 *  the first `webSocketMessage` connects the handler session via the rehydrate path. */
function makeSocket(state: FakeDoState, connectionId: string): FakeDoWebSocket {
  const ws = new FakeDoWebSocket();
  ws.serializeAttachment({ connectionId, identity: null, subs: {} });
  state.seedSocket(ws);
  return ws;
}

describe("HelipodDurableObject (the single-shard DO host)", () => {
  it("boots and serves GET /api/health", async () => {
    const state = new FakeDoState();
    const doInstance = new TestDO(state, {});
    const res = await doInstance.fetch(new Request("https://do.test/api/health"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
    // The runtime-level keepalive was armed (replaces the disarmed per-session ping heartbeat).
    expect(state.autoResponseArmed).toBe(true);
  });

  it("commits a mutation via POST /api/run and reads it back", async () => {
    const doInstance = new TestDO(new FakeDoState(), {});
    const runRes = await doInstance.fetch(post("/api/run", { path: "messages:send", args: { conversationId: "c1", body: "hello-do" } }));
    expect(runRes.status).toBe(200);
    const runBody = await runRes.json();
    expect(typeof runBody.value).toBe("string"); // the new _id

    const readRes = await doInstance.fetch(post("/api/run", { path: "messages:list", args: { conversationId: "c1" } }));
    const rows = (await readRes.json()).value as Array<{ body: string }>;
    expect(rows.map((r) => r.body)).toEqual(["hello-do"]);
  });

  it("fans a commit out to a live WebSocket subscription (subscribe → commit → push)", async () => {
    const state = new FakeDoState();
    const doInstance = new TestDO(state, {});
    // Socket A subscribes to messages:list for c1.
    const wsA = makeSocket(state, "connA");
    await doInstance.webSocketMessage(
      wsA,
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "messages:list", args: { conversationId: "c1" } }], remove: [] }),
    );
    // The initial subscribe result arrives (a Transition carrying the empty list).
    await waitFor(() => wsA.framesOfType("Transition").length > 0);

    // A DIFFERENT client commits a write to the subscribed table via /api/run.
    const before = wsA.sent.length;
    await doInstance.fetch(post("/api/run", { path: "messages:send", args: { conversationId: "c1", body: "reactive!" } }));

    // Socket A receives the reactive push (a write it did not make) — this is reactivity in the DO.
    await waitFor(() => wsA.sent.length > before);
    const combined = wsA.sent.join("");
    expect(combined).toContain("reactive!");
  });

  it("rehydrates a hibernated socket's subscription from its attachment, then still fans out to it", async () => {
    const storage = new FakeDoStorage();
    // Incarnation #1: subscribe socket A.
    const state1 = new FakeDoState(storage);
    const do1 = new TestDO(state1, {});
    const wsA = makeSocket(state1, "connA");
    await do1.webSocketMessage(
      wsA,
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 7, udfPath: "messages:list", args: { conversationId: "c2" } }], remove: [] }),
    );
    await waitFor(() => wsA.framesOfType("Transition").length > 0);
    // The subscription DEFINITION was persisted into the socket's attachment.
    expect((wsA.deserializeAttachment() as { subs: Record<string, unknown> }).subs["7"]).toBeTruthy();

    // HIBERNATION: a brand-new DO incarnation over the SAME storage, with the SAME live socket still
    // enrolled (its in-RAM handler session is GONE, but the attachment survives).
    const state2 = new FakeDoState(storage);
    state2.seedSocket(wsA); // getWebSockets() returns the hibernated socket, as a real DO would
    const do2 = new TestDO(state2, {});

    // Force boot + eager rehydrate-all-on-wake to fully complete (a throwaway request awaits bootDone)
    // BEFORE we commit, so the reactive push we assert on is unambiguously the commit's, not the
    // rehydrate's own re-subscribe frame.
    await do2.fetch(new Request("https://do.test/api/health"));

    // A commit from another path must reach the rehydrated subscriber — its session was reconstructed
    // from the durable attachment on wake, so its read-set exists to intersect the write against.
    await do2.fetch(post("/api/run", { path: "messages:send", args: { conversationId: "c2", body: "after-hibernation" } }));
    await waitFor(() => wsA.sent.join("").includes("after-hibernation"));
    expect(wsA.sent.join("")).toContain("after-hibernation");
  });

  it("enforces the per-socket subscription cap with a QueryFailed", async () => {
    const state = new FakeDoState();
    const doInstance = new TestDO(state, {});
    const ws = makeSocket(state, "connCap");
    // Fill exactly to the cap.
    const add = Array.from({ length: MAX_SUBSCRIPTIONS_PER_SOCKET }, (_, i) => ({
      queryId: i + 1,
      udfPath: "messages:list",
      args: { conversationId: "c1" },
    }));
    await doInstance.webSocketMessage(ws, JSON.stringify({ type: "ModifyQuerySet", add, remove: [] }));
    const att = ws.deserializeAttachment() as { subs: Record<string, unknown> };
    expect(Object.keys(att.subs).length).toBe(MAX_SUBSCRIPTIONS_PER_SOCKET);

    // One more subscription is rejected with a QueryFailed and NOT persisted.
    await doInstance.webSocketMessage(
      ws,
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 9999, udfPath: "messages:list", args: { conversationId: "c1" } }], remove: [] }),
    );
    const failed = ws.framesOfType("QueryFailed");
    expect(failed.some((f) => f.queryId === 9999)).toBe(true);
    const att2 = ws.deserializeAttachment() as { subs: Record<string, unknown> };
    expect(att2.subs["9999"]).toBeUndefined();
    expect(Object.keys(att2.subs).length).toBe(MAX_SUBSCRIPTIONS_PER_SOCKET);
  });

  it("fires due driver timers on the alarm (the wake seam)", async () => {
    const state = new FakeDoState();
    const doInstance = new TestDO(state, {});
    // Boot completes; `alarm()` drives `runtime.fireDueTimers()` — with no composed drivers there is
    // nothing due, so this proves the wake plumbing runs without throwing (the driver-firing behavior
    // itself is covered by the runtime's own wake-seam unit tests).
    await doInstance.fetch(new Request("https://do.test/api/health")); // ensure booted
    await expect(doInstance.alarm()).resolves.toBeUndefined();
  });
});
