/**
 * T6 — reconnect-by-default transport + the S4 flush path (verdict §(b) transport line, §(c)
 * event 6's reconnect half). Two layers, both loopback-level (no real network / real-WS E2E — that
 * lands in T7):
 *
 *  - `webSocketTransport` itself: the reconnect/backoff state machine, driven through a fake
 *    `WebSocket` constructor injected via `createWebSocket` + vitest fake timers, so the backoff
 *    schedule is directly observable and controllable.
 *  - `StackbaseClient`'s reopen sequence: a `MockTransport` that can synthesize `onClose`/`onReopen`
 *    on demand, proving the client's SetAuth-replay -> resubscribe -> flush-unsent ordering and the
 *    FIFO-with-original-requestId contract.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { StackbaseClient, webSocketTransport, reconnectDelayMs, type ClientTransport } from "../src/index";
import type { ClientMessage, ServerMessage } from "@stackbase/sync";

// ================================================================================================
// `reconnectDelayMs` — the backoff formula in isolation.
// ================================================================================================
describe("reconnectDelayMs", () => {
  it("grows exponentially and is capped, with jitter always in [half, full] of the exponential term", () => {
    const initial = 300;
    const max = 30_000;
    // rand=0 -> the floor (half); rand=1 -> the ceiling (the full exponential term, still capped).
    expect(reconnectDelayMs(0, initial, max, () => 0)).toBe(150);
    expect(reconnectDelayMs(0, initial, max, () => 1)).toBe(300);
    expect(reconnectDelayMs(1, initial, max, () => 0)).toBe(300);
    expect(reconnectDelayMs(1, initial, max, () => 1)).toBe(600);
    expect(reconnectDelayMs(2, initial, max, () => 0)).toBe(600);
    expect(reconnectDelayMs(2, initial, max, () => 1)).toBe(1200);
  });

  it("caps at ~30s regardless of how large the attempt number grows", () => {
    const initial = 300;
    const max = 30_000;
    expect(reconnectDelayMs(20, initial, max, () => 1)).toBe(max);
    expect(reconnectDelayMs(20, initial, max, () => 0)).toBe(max / 2);
  });
});

// ================================================================================================
// `webSocketTransport` — the reconnect state machine, via a fake WebSocket.
// ================================================================================================
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(ev?: unknown) => void>>();
  closedByApp = false;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (ev?: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closedByApp = true;
    this.emit("close");
  }
  emit(type: string, ev?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

function freshFakeFactory(): (url: string) => WebSocket {
  FakeSocket.instances = [];
  return (url: string) => new FakeSocket(url) as unknown as WebSocket;
}

describe("webSocketTransport — reconnect state machine", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("close -> backoff schedule (fake timers) -> reopen: onClose fires once, no new socket until the delay elapses, onReopen fires only on the RECONNECT open (not the initial one)", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // deterministic: delay = half = 150ms for attempt 0
    const createWebSocket = freshFakeFactory();
    const t = webSocketTransport("ws://x", { createWebSocket });

    let closes = 0;
    let reopens = 0;
    t.onClose(() => closes++);
    t.onReopen!(() => reopens++);

    expect(FakeSocket.instances.length).toBe(1);
    FakeSocket.instances[0]!.emit("open"); // initial connect — NOT a reopen
    expect(reopens).toBe(0);

    FakeSocket.instances[0]!.emit("close"); // disconnect
    expect(closes).toBe(1);
    expect(FakeSocket.instances.length).toBe(1); // no new socket yet — still in backoff

    vi.advanceTimersByTime(149);
    expect(FakeSocket.instances.length).toBe(1); // still waiting
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(2); // backoff elapsed — new socket created

    FakeSocket.instances[1]!.emit("open"); // the reconnect succeeds
    expect(reopens).toBe(1);
    expect(closes).toBe(1); // onClose did not re-fire for the reconnect
  });

  it("a FAILED first-connect attempt (socket dies before ever opening) makes the NEXT open fire onReopen too — the 8ff4dda fix, isolated", () => {
    // Companion to the first test above, which proves the OTHER half of the same contract (a
    // never-failed first open does NOT fire onReopen). Together they pin both branches of
    // `hadFailedConnect` directly at the transport, without going through `StackbaseClient` — this
    // is the isolated proof the 8ff4dda fix commit shipped without (it was caught only by the real-
    // WebSocket flagship E2E's authed-reload scenario, per that commit's message).
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // delay = 150ms for attempt 0
    const createWebSocket = freshFakeFactory();
    const t = webSocketTransport("ws://x", { createWebSocket });

    let reopens = 0;
    t.onReopen!(() => reopens++);

    // The FIRST connection attempt dies before ever opening (no "open" event ever fired for it) —
    // a client constructed offline, or whose initial connect races a network blip.
    FakeSocket.instances[0]!.emit("close");
    expect(reopens).toBe(0); // the failed attempt itself is not a reopen — there was nothing to reopen FROM

    vi.advanceTimersByTime(150); // backoff elapses — a second attempt is made
    expect(FakeSocket.instances.length).toBe(2);

    // This second attempt is the transport's FIRST-EVER successful open (`everOpened` was still
    // false going in) — but because the PRIOR attempt failed, it must fire onReopen anyway: the
    // client needs to run its full reconnect sequence (SetAuth replay, resubscribe, the durable-
    // outbox Connect handshake) to rebuild the session from client state, exactly as it would after
    // a genuine mid-session drop.
    FakeSocket.instances[1]!.emit("open");
    expect(reopens).toBe(1);

    // A THIRD open (an ordinary reconnect after a normal disconnect, no failed attempt involved)
    // still fires exactly once more — the `hadFailedConnect` flag was consumed, not stuck on.
    FakeSocket.instances[1]!.emit("close");
    vi.advanceTimersByTime(300);
    expect(FakeSocket.instances.length).toBe(3);
    FakeSocket.instances[2]!.emit("open");
    expect(reopens).toBe(2);
  });

  it("backoff grows across repeated disconnects (attempt increments)", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // always the floor: delay = exp/2
    const createWebSocket = freshFakeFactory();
    const t = webSocketTransport("ws://x", { createWebSocket, initialBackoffMs: 300, maxBackoffMs: 30_000 });
    void t;

    FakeSocket.instances[0]!.emit("open");
    FakeSocket.instances[0]!.emit("close"); // attempt 0 -> delay 150
    vi.advanceTimersByTime(150);
    expect(FakeSocket.instances.length).toBe(2);

    FakeSocket.instances[1]!.emit("close"); // never opened this cycle -> attempt 1 -> delay 300
    vi.advanceTimersByTime(299);
    expect(FakeSocket.instances.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(3);
  });

  it("{ reconnect: false } preserves today's terminal behavior: one close, no reconnect ever scheduled, send() no-ops after close", () => {
    vi.useFakeTimers();
    const createWebSocket = freshFakeFactory();
    const t = webSocketTransport("ws://x", { createWebSocket, reconnect: false });
    let closes = 0;
    let reopens = 0;
    t.onClose(() => closes++);
    t.onReopen!(() => reopens++);

    FakeSocket.instances[0]!.emit("open");
    FakeSocket.instances[0]!.emit("close");
    expect(closes).toBe(1);

    vi.advanceTimersByTime(60_000); // well past any possible backoff
    expect(FakeSocket.instances.length).toBe(1); // never reconnected
    expect(reopens).toBe(0);

    // send() after a terminal close must not throw (existing contract).
    expect(() => t.send({ type: "SetAuth", token: null })).not.toThrow();
  });

  it("frames sent while down (post-disconnect, pre-reconnect) are dropped, not buffered onto the next socket — reopen listeners see the wire first", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // delay = 150ms for attempt 0
    const createWebSocket = freshFakeFactory();
    const t = webSocketTransport("ws://x", { createWebSocket });

    FakeSocket.instances[0]!.emit("open"); // initial connect
    FakeSocket.instances[0]!.emit("close"); // disconnect — now in backoff

    // Raw frames sent while down (mirrors what a bare subscribe/unsubscribe/setAuth/publishEphemeral
    // call does at the transport level): must NOT survive to the next socket.
    t.send({ type: "SetAuth", token: "stale" });
    t.send({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "messages:list", args: {} }], remove: [] });
    t.send({ type: "EphemeralPublish", topic: "typing", event: null });

    vi.advanceTimersByTime(150); // backoff elapses — new socket created
    expect(FakeSocket.instances.length).toBe(2);
    expect(FakeSocket.instances[1]!.sent).toEqual([]); // nothing flushed ahead of the reopen sequence

    let reopens = 0;
    t.onReopen!(() => reopens++);
    FakeSocket.instances[1]!.emit("open");
    expect(reopens).toBe(1);
    expect(FakeSocket.instances[1]!.sent).toEqual([]); // still nothing — those frames are gone for good

    // The wire only ever sees whatever the reopen listener itself sends, in its own order.
    t.send({ type: "SetAuth", token: "fresh" });
    expect(FakeSocket.instances[1]!.sent).toEqual([JSON.stringify({ type: "SetAuth", token: "fresh" })]);
  });

  it("pre-first-open buffering is untouched: frames sent before the transport's very first socket opens still flush on that first open", () => {
    vi.useFakeTimers();
    const createWebSocket = freshFakeFactory();
    const t = webSocketTransport("ws://x", { createWebSocket });

    t.send({ type: "SetAuth", token: "initial" }); // sent before the first socket is even open
    expect(FakeSocket.instances[0]!.sent).toEqual([]); // still queued, not dropped

    FakeSocket.instances[0]!.emit("open");
    expect(FakeSocket.instances[0]!.sent).toEqual([JSON.stringify({ type: "SetAuth", token: "initial" })]);
  });

  it("{ reconnect: false }: frames sent before the terminal close still buffer and flush on a manual first open (unchanged)", () => {
    const createWebSocket = freshFakeFactory();
    const t = webSocketTransport("ws://x", { createWebSocket, reconnect: false });

    t.send({ type: "SetAuth", token: "initial" }); // pre-open, queued as before
    FakeSocket.instances[0]!.emit("open");
    expect(FakeSocket.instances[0]!.sent).toEqual([JSON.stringify({ type: "SetAuth", token: "initial" })]);
  });

  it("explicit close() during a pending backoff cancels the scheduled reconnect", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const createWebSocket = freshFakeFactory();
    const t = webSocketTransport("ws://x", { createWebSocket });
    let reopens = 0;
    t.onReopen!(() => reopens++);

    FakeSocket.instances[0]!.emit("open");
    FakeSocket.instances[0]!.emit("close"); // schedules a reconnect in 150ms
    t.close(); // app gives up before the backoff elapses

    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances.length).toBe(1); // no reconnect socket was ever created
    expect(reopens).toBe(0);
  });
});

// ================================================================================================
// `StackbaseClient`'s reopen sequence — via a MockTransport that can synthesize reopen on demand.
// ================================================================================================
class MockTransport implements ClientTransport {
  readonly sent: ClientMessage[] = [];
  private readonly msg = new Set<(m: ServerMessage) => void>();
  private readonly closers = new Set<() => void>();
  private readonly reopeners = new Set<() => void>();
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
  onReopen(l: () => void): () => void {
    this.reopeners.add(l);
    return () => this.reopeners.delete(l);
  }
  close(): void {
    this.emitClose();
  }
  emit(m: ServerMessage): void {
    for (const l of this.msg) l(m);
  }
  emitClose(): void {
    for (const l of this.closers) l();
  }
  emitReopen(): void {
    for (const l of this.reopeners) l();
  }
  mutationRequestIds(): string[] {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "Mutation" }> => m.type === "Mutation").map((m) => m.requestId);
  }
}

describe("StackbaseClient — reconnect reopen sequence (S4 flush path)", () => {
  it("ordered: SetAuth replay, THEN resubscribe (existing resync path), THEN FIFO flush of unsent", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);

    client.setAuth("tok-1");
    client.subscribe("messages:list", { conversationId: "c1" }, () => {});
    expect(t.sent.map((m) => m.type)).toEqual(["SetAuth", "ModifyQuerySet"]);

    // Simulate a network drop, then two mutations queued while offline (both become `unsent`).
    t.emitClose();
    void client.mutation("messages:send", { conversationId: "c1", body: "A" });
    void client.mutation("messages:send", { conversationId: "c1", body: "B" });
    expect(client.__pending.map((e) => e.status.type)).toEqual(["unsent", "unsent"]);
    const sentBeforeReopen = t.sent.length;

    t.emitReopen();

    const afterReopen = t.sent.slice(sentBeforeReopen);
    // The load-bearing order: SetAuth before the resubscribe before either flushed Mutation.
    expect(afterReopen[0]).toEqual({ type: "SetAuth", token: "tok-1" });
    expect(afterReopen[1]!.type).toBe("ModifyQuerySet");
    const mutationFrames = afterReopen.slice(2);
    expect(mutationFrames.map((m) => m.type)).toEqual(["Mutation", "Mutation"]);
    expect((mutationFrames[0] as { args: unknown }).args).toEqual({ conversationId: "c1", body: "A" });
    expect((mutationFrames[1] as { args: unknown }).args).toEqual({ conversationId: "c1", body: "B" });

    // Both entries flipped unsent -> inflight; original requestIds reused (never re-minted).
    expect(client.__pending.map((e) => e.status.type)).toEqual(["inflight", "inflight"]);
  });

  it("unsent flushed FIFO with ORIGINAL requestIds; their promises resolve on the new session's responses", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    t.emitClose();

    const first = client.mutation("messages:send", { conversationId: "c1", body: "A" });
    const second = client.mutation("messages:send", { conversationId: "c1", body: "B" });
    const [reqA, reqB] = client.__pending.map((e) => e.requestId);
    expect(reqA).toBeDefined();
    expect(reqB).toBeDefined();
    expect(reqA).not.toBe(reqB);

    t.emitReopen();

    // The exact same requestIds appear on the wire — the S1 entry was reused, never re-minted.
    expect(t.mutationRequestIds()).toEqual([reqA, reqB]);

    // Respond out of wire order — each promise resolves to ITS OWN original entry regardless.
    t.emit({ type: "MutationResponse", requestId: reqB!, success: true, value: "idB" });
    t.emit({ type: "MutationResponse", requestId: reqA!, success: true, value: "idA" });
    await expect(first).resolves.toBe("idA");
    await expect(second).resolves.toBe("idB");
    expect(client.__pending.length).toBe(0);
  });

  it("closed clears on reopen: a mutation issued right after reopen sends immediately (not queued as unsent)", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    t.emitClose();

    void client.mutation("messages:send", { conversationId: "c1", body: "queued" });
    expect(client.__pending[0]!.status.type).toBe("unsent");

    t.emitReopen();
    const before = t.sent.length;
    void client.mutation("messages:send", { conversationId: "c1", body: "live" });
    expect(t.sent.length).toBe(before + 1);
    expect(t.sent.at(-1)).toMatchObject({ type: "Mutation" });
    expect(client.__pending.at(-1)!.status.type).toBe("inflight");
  });

  it("inflight-at-close still rejects with MutationUndeliveredError (T4 — unmodified) and is never re-flushed on reopen", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);

    const inflight = client.mutation("messages:send", { conversationId: "c1", body: "in-flight" });
    expect(client.__pending[0]!.status.type).toBe("inflight");

    t.emitClose();
    await expect(inflight).rejects.toThrow(/connection closed/);
    expect(client.__pending.length).toBe(0);

    void client.mutation("messages:send", { conversationId: "c1", body: "unsent" });
    const sentBefore = t.sent.length;
    t.emitReopen();
    // Only the ONE unsent mutation is flushed — the already-rejected inflight entry never reappears.
    const flushed = t.sent.slice(sentBefore).filter((m) => m.type === "Mutation");
    expect(flushed.length).toBe(1);
    expect((flushed[0] as { args: unknown }).args).toEqual({ conversationId: "c1", body: "unsent" });
  });

  it("a transport with no onReopen (e.g. loopbackTransport-shaped) behaves exactly as before — no crash, no flush", () => {
    const t = new MockTransport();
    // Reconstruct a transport-shaped object WITHOUT onReopen to prove the `?.()` guard holds.
    const bare: ClientTransport = {
      send: (m) => t.send(m),
      onMessage: (l) => t.onMessage(l),
      onClose: (l) => t.onClose(l),
      close: () => t.close(),
    };
    expect(() => new StackbaseClient(bare)).not.toThrow();
  });
});
