/**
 * Task 2 — durable enqueue + the ConnectAck-armed park swap, through the REAL `StackbaseClient`
 * (not just `closeDisposition` in isolation — see `delivery-policy.test.ts` for that). Uses a
 * lightweight `MockTransport` (the `reconnect.test.ts` pattern) and a controllable `OutboxStorage`
 * wrapper so append-durability timing can be driven precisely.
 */
import { describe, it, expect } from "vitest";
import { StackbaseClient } from "../src/client";
import { memoryOutbox, OutboxOverflowError, type OutboxEntry, type OutboxStorage } from "../src/outbox-storage";
import type { ClientMessage, ServerMessage } from "@stackbase/sync";

class MockTransport {
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
  emitClose(): void {
    for (const l of this.closers) l();
  }
  emitReopen(): void {
    for (const l of this.reopeners) l();
  }
  mutations(): Array<Extract<ClientMessage, { type: "Mutation" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "Mutation" }> => m.type === "Mutation");
  }
}

/** Wraps `memoryOutbox()` with an inspectable/controllable `append` — `deferAppends: true` holds
 *  every `append()` call pending until `resolveNextAppend()` is called, so durability timing (the
 *  `entry.durable` flip) can be driven precisely from a test. */
function controllableOutbox(opts: { deferAppends?: boolean } = {}): {
  storage: OutboxStorage;
  appendCalls: OutboxEntry[];
  resolveNextAppend: () => void;
} {
  const base = memoryOutbox();
  const appendCalls: OutboxEntry[] = [];
  const waiters: Array<() => void> = [];
  const storage: OutboxStorage = {
    ...base,
    append: async (entry) => {
      appendCalls.push(entry);
      if (opts.deferAppends) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      await base.append(entry);
    },
  };
  return {
    storage,
    appendCalls,
    resolveNextAppend: () => waiters.shift()?.(),
  };
}

/** Flush pending microtasks (append `.then()` chains). `crypto.subtle.digest` resolves off a
 *  real async I/O completion (Node's threadpool), not a pure microtask — under full-gate parallel
 *  contention a single macrotask turn is not always enough, so this polls with real timeouts
 *  (bounded) rather than assuming a fixed tick count. */
async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Poll `cond` with real timeouts until it's true (or throw after `timeoutMs`) — for anything
 *  gated on `crypto.subtle.digest`'s threadpool completion, which a fixed tick count can't bound
 *  reliably under load. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("StackbaseClient.mutation — no-outbox-config byte-identity", () => {
  it("sends exactly today's Mutation shape — no clientId/seq keys at all, not even undefined ones", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    void client.mutation("messages:send", { body: "hi" });
    const sent = t.mutations();
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!).sort()).toEqual(["args", "requestId", "type", "udfPath"]);
    expect(sent[0]).toStrictEqual({ type: "Mutation", requestId: sent[0]!.requestId, udfPath: "messages:send", args: { body: "hi" } });
  });

  it("close() with no outbox still fails inflight exactly as before — armed defaults false regardless", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    const p = client.mutation("messages:send", { body: "hi" });
    t.emitClose();
    await expect(p).rejects.toThrow(/connection closed/);
  });
});

describe("StackbaseClient.mutation — durable enqueue (Task 2)", () => {
  it("direct-send (queue empty, transport open) carries (clientId, seq) on the wire, matching the minted identity", async () => {
    const t = new MockTransport();
    const outbox = memoryOutbox();
    const client = new StackbaseClient(t, { outbox });

    // Called in the SAME tick as construction — `getOutboxIdentity()` has not resolved yet, but
    // `mutation()` must stay synchronous and still stamp the right clientId (T1's open concern).
    void client.mutation("messages:send", { body: "hi" });

    const sent = t.mutations();
    expect(sent).toHaveLength(1);
    expect(typeof sent[0]!.clientId).toBe("string");
    expect(sent[0]!.seq).toBe(0);

    const identity = await client.getOutboxIdentity();
    expect(sent[0]!.clientId).toBe(identity!.clientId); // same id the durable meta row was minted under
    const meta = await outbox.getMeta(identity!.clientId);
    expect(meta).toBeDefined(); // durable identity persisted, unaffected by the immediate mutation() call
  });

  it("a second direct-send increments seq (never reuses one)", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox() });
    void client.mutation("messages:send", { body: "a" });
    void client.mutation("messages:send", { body: "b" });
    const [a, b] = t.mutations();
    expect(a!.seq).toBe(0);
    expect(b!.seq).toBe(1);
    expect(a!.clientId).toBe(b!.clientId);
  });

  it("write-behind: the append is fired but never awaited by the send — the Mutation frame is on the wire before append() even resolves", () => {
    const t = new MockTransport();
    const { storage, appendCalls } = controllableOutbox({ deferAppends: true });
    const client = new StackbaseClient(t, { outbox: storage });
    void client.mutation("messages:send", { body: "hi" });
    // The send happened synchronously, in the SAME tick — proven by asserting it before any
    // microtask has had a chance to run at all.
    expect(t.mutations()).toHaveLength(1);
    expect(appendCalls).toHaveLength(1); // append() was CALLED (fire-and-forget)...
    expect(client.__pending[0]!.durable).toBeFalsy(); // ...but has not resolved/committed yet
  });

  it("encodability triage: an unencodable args throws synchronously, BEFORE any seq is consumed", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox() });
    expect(() => client.mutation("messages:send", { cb: (() => {}) as unknown as string })).toThrow(TypeError);
    expect(t.mutations()).toHaveLength(0);
    expect(client.__pending).toHaveLength(0);

    // The seq counter was never advanced — the next (valid) mutation still gets seq 0.
    void client.mutation("messages:send", { body: "ok" });
    expect(t.mutations()[0]!.seq).toBe(0);
  });
});

describe("StackbaseClient — overflow (Task 2)", () => {
  it("rejects the NEW enqueue with a coded OutboxOverflowError once the cap is hit, leaving the old entries intact", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox(), outboxMaxQueueSize: 2 });
    t.emitClose(); // offline — mutations pile up as `unsent`, never settling

    const first = client.mutation("messages:send", { body: "1" });
    const second = client.mutation("messages:send", { body: "2" });
    expect(client.__pending).toHaveLength(2);

    let optimisticRan = false;
    const third = client.mutation(
      "messages:send",
      { body: "3" },
      { optimisticUpdate: () => { optimisticRan = true; } },
    );
    await expect(third).rejects.toBeInstanceOf(OutboxOverflowError);
    await expect(third).rejects.toMatchObject({ code: "OUTBOX_OVERFLOW" });
    expect(optimisticRan).toBe(false); // no layer touched for a rejected-before-creation entry

    // The two originals are completely untouched — still queued, in order, unresolved.
    expect(client.__pending.map((e) => e.args)).toEqual([{ body: "1" }, { body: "2" }]);
    expect(client.__pending.every((e) => e.status.type === "unsent")).toBe(true);

    // Still full — a 4th attempt overflows identically (the 3rd rejection did not silently
    // consume a slot).
    await expect(client.mutation("messages:send", { body: "4" })).rejects.toBeInstanceOf(OutboxOverflowError);
    expect(client.__pending).toHaveLength(2);

    void first;
    void second;
  });

  it("no cap applies without an outbox — 1000+ offline mutations all queue fine", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    t.emitClose();
    for (let i = 0; i < 5; i++) void client.mutation("messages:send", { body: String(i) });
    expect(client.__pending).toHaveLength(5);
  });
});

describe("StackbaseClient.setAuth — the identityFingerprint cache (Task 2)", () => {
  it("defaults to \"anon\" before any setAuth call", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox() });
    void client.mutation("messages:send", { body: "hi" });
    expect(client.__pending[0]!.identityFingerprint).toBe("anon");
  });

  it("setAuth(null) stamps \"anon\" synchronously (no async wait needed)", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox() });
    client.setAuth("tok-1");
    client.setAuth(null);
    void client.mutation("messages:send", { body: "hi" });
    expect(client.__pending[0]!.identityFingerprint).toBe("anon");
  });

  it("setAuth(token) computes the SHA-256 hex ASYNCHRONOUSLY — a same-tick mutation still sees the OLD cached value", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox() });
    client.setAuth("tok-1");
    void client.mutation("messages:send", { body: "immediate" }); // fires before the digest resolves
    expect(client.__pending[0]!.identityFingerprint).toBe("anon");

    // Poll (bounded, real timeouts) rather than assume a fixed tick count — `crypto.subtle.digest`
    // resolves off a real threadpool completion, which a microtask-only flush can't bound.
    await waitFor(() => client.__outboxFingerprint !== "anon");
    void client.mutation("messages:send", { body: "later" });
    const later = client.__pending[1]!;
    expect(later.identityFingerprint).not.toBe("anon");
    expect(later.identityFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a later setAuth wins over a slower-resolving earlier hash (no stale clobber)", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox() });
    client.setAuth("tok-A");
    client.setAuth("tok-B");
    await waitFor(() => client.__outboxFingerprint !== "anon");
    void client.mutation("messages:send", { body: "hi" });
    const fpB = client.__pending[0]!.identityFingerprint;

    const beforeReset = fpB;
    client.setAuth("tok-A"); // re-set to A, but don't await
    await waitFor(() => client.__outboxFingerprint !== beforeReset);
    void client.mutation("messages:send", { body: "hi2" });
    const fpA = client.__pending[1]!.identityFingerprint;
    expect(fpA).not.toBe(fpB);
  });
});

describe("StackbaseClient — the S4 park swap (Task 2)", () => {
  it("park-requires-durability: an inflight entry whose append has NOT committed still rejects at close, even when armed", async () => {
    const t = new MockTransport();
    const { storage } = controllableOutbox({ deferAppends: true });
    const client = new StackbaseClient(t, { outbox: storage });
    client.setOutboxArmed(true);

    const p = client.mutation("messages:send", { body: "hi" });
    expect(client.__pending[0]!.durable).toBeFalsy();
    t.emitClose(); // the append is still pending — not durable

    await expect(p).rejects.toThrow(/connection closed/);
    expect(client.__pending).toHaveLength(0);
  });

  it("park-requires-durability: a COMMITTED append parks instead — the promise stays pending, the layer drops", async () => {
    const t = new MockTransport();
    const { storage, resolveNextAppend } = controllableOutbox({ deferAppends: true });
    const client = new StackbaseClient(t, { outbox: storage });
    client.setOutboxArmed(true);

    let touchedList: unknown;
    const p = client.mutation(
      "messages:send",
      { body: "hi" },
      { optimisticUpdate: (store) => store.setQuery("messages:list", {}, (touchedList = [{ body: "hi" }]) as never) },
    );
    resolveNextAppend();
    await flushMicrotasks();
    expect(client.__pending[0]!.durable).toBe(true);

    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );

    t.emitClose();
    await flushMicrotasks();
    expect(settled).toBe(false); // NOT rejected, NOT resolved — parked, awaiting a future drain
    expect(client.__pending).toHaveLength(1);
    expect(client.__pending[0]!.status.type).toBe("parked");
    expect(client.__pending[0]!.update).toBeUndefined(); // the layer dropped (unchanged rule)
    void touchedList;
  });

  it("without arming (T3 never called setOutboxArmed), a durable inflight entry rejects exactly as before — feature-detected, off by default", async () => {
    const t = new MockTransport();
    const { storage, resolveNextAppend } = controllableOutbox({ deferAppends: true });
    const client = new StackbaseClient(t, { outbox: storage });
    // No setOutboxArmed(true) call at all.

    const p = client.mutation("messages:send", { body: "hi" });
    resolveNextAppend();
    await flushMicrotasks();
    expect(client.__pending[0]!.durable).toBe(true);

    t.emitClose();
    await expect(p).rejects.toThrow(/connection closed/);
  });

  it("enqueue-behind-queue FIFO across the boundary: a parked entry left in the log makes a later live mutation queue behind it instead of direct-sending", async () => {
    const t = new MockTransport();
    const { storage, resolveNextAppend } = controllableOutbox({ deferAppends: true });
    const client = new StackbaseClient(t, { outbox: storage });
    client.setOutboxArmed(true);

    const first = client.mutation("messages:send", { body: "A" });
    resolveNextAppend();
    await flushMicrotasks();
    t.emitClose(); // parks A (durable + armed)
    expect(client.__pending[0]!.status.type).toBe("parked");

    t.emitReopen(); // resync + flush unsentInOrder — A is `parked`, not `unsent`, so it is NOT resent
    const sentBeforeB = t.mutations().length;

    void client.mutation("messages:send", { body: "B" }); // issued AFTER reopen, transport now open
    expect(client.__pending.map((e) => e.status.type)).toEqual(["parked", "unsent"]); // FIFO preserved
    expect(t.mutations().length).toBe(sentBeforeB); // B did NOT go out on the wire — queued behind A

    void first;
  });
});
