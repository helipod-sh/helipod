/**
 * Task 3 (browser-ux Part B) — `drainOutboxOnce`, the headless one-shot outbox drain. A `MockTransport`
 * injected via the `_transport` test seam gives full control over the wire, exactly like
 * `outbox-drain.test.ts`'s harness for the REAL `StackbaseClient` — here there is no client at all,
 * only the store-only host + the shared `OutboxDrain`.
 */
import { describe, it, expect } from "vitest";
import { drainOutboxOnce, memoryOutbox, OUTBOX_VERSION, type OutboxEntry, type OutboxLockManager, type OutboxStorage } from "../src/index";
import type { ClientMessage, ServerMessage } from "@stackbase/sync";
import type { ClientTransport } from "../src/transport";

/* -------------------------------------------------------------------------- */
/* Harness                                                                      */
/* -------------------------------------------------------------------------- */

class MockTransport implements ClientTransport {
  readonly sent: ClientMessage[] = [];
  private readonly msg = new Set<(m: ServerMessage) => void>();
  private readonly closers = new Set<() => void>();
  closedCount = 0;
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
    this.closedCount++;
    for (const l of this.closers) l();
  }
  emit(m: ServerMessage): void {
    for (const l of this.msg) l(m);
  }
  connects(): Array<Extract<ClientMessage, { type: "Connect" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "Connect" }> => m.type === "Connect");
  }
  batches(): Array<Extract<ClientMessage, { type: "MutationBatch" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "MutationBatch" }> => m.type === "MutationBatch");
  }
}

/** Seed a durable outbox as if a PRIOR tab-session left it behind. */
async function seedOutbox(
  storage: OutboxStorage,
  clientId: string,
  rows: Array<{ seq: number; order: number; udfPath?: string; body?: string; status?: OutboxEntry["status"] }>,
): Promise<void> {
  for (const r of rows) {
    const entry: OutboxEntry = {
      clientId,
      seq: r.seq,
      requestId: `old-${r.seq}`,
      udfPath: r.udfPath ?? "messages:send",
      args: { body: r.body ?? `b${r.seq}` },
      seed: { entropy: `e${r.seq}`, now: 1000 + r.seq },
      order: r.order,
      status: r.status ?? "unsent",
      outboxVersion: OUTBOX_VERSION,
      enqueuedAt: 1000 + r.seq,
    };
    await storage.append(entry);
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 3));
  }
}

/** Emit `applied` (success) responses for every entry of a sent `MutationBatch`. */
function applyBatch(t: MockTransport, batch: Extract<ClientMessage, { type: "MutationBatch" }>, ts = 100): void {
  for (const e of batch.entries) {
    t.emit({ type: "MutationResponse", requestId: e.requestId, success: true, value: `srv-${e.seq}`, ts });
  }
}

/* -------------------------------------------------------------------------- */
/* Settle mapping: applied -> dequeue; terminal -> updateStatus("failed")       */
/* -------------------------------------------------------------------------- */

describe("drainOutboxOnce — the store-only host's settle mapping", () => {
  it("an applied response dequeues the durable row and counts drained", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [
      { seq: 0, order: 1 },
      { seq: 1, order: 2 },
    ]);
    const t = new MockTransport();
    const resultPromise = drainOutboxOnce({ url: "ws://ignored", outbox, locks: null, _transport: t });

    await waitFor(() => t.connects().length === 1);
    t.emit({ type: "ConnectAck", known: true, results: [], deploymentId: "dep-1" });
    await waitFor(() => t.batches().length > 0);
    applyBatch(t, t.batches()[0]!);

    const result = await resultPromise;
    expect(result).toEqual({ drained: 2, failed: 0, remaining: 0 });
    expect((await outbox.loadAll()).entries).toHaveLength(0); // dequeued, not merely marked
  });

  it("a coded terminal failure marks the durable row `failed` with {code, message} and counts failed", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [{ seq: 0, order: 1 }]);
    const t = new MockTransport();
    const resultPromise = drainOutboxOnce({ url: "ws://ignored", outbox, locks: null, _transport: t });

    await waitFor(() => t.connects().length === 1);
    t.emit({ type: "ConnectAck", known: true, results: [], deploymentId: "dep-1" });
    await waitFor(() => t.batches().length > 0);
    const batch = t.batches()[0]!;
    t.emit({ type: "MutationResponse", requestId: batch.entries[0]!.requestId, success: false, error: "bad", code: "APP_ERR" });

    const result = await resultPromise;
    expect(result).toEqual({ drained: 0, failed: 1, remaining: 0 });
    const remaining = (await outbox.loadAll()).entries;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ status: "failed", error: { code: "APP_ERR", message: expect.stringContaining("messages:send") } });
  });
});

/* -------------------------------------------------------------------------- */
/* Lock held -> immediate no-op                                                 */
/* -------------------------------------------------------------------------- */

describe("drainOutboxOnce — a live tab already holds the leader lock", () => {
  /** Mimics the real Web Locks `ifAvailable` contract: the callback is invoked with `null` when the
   *  lock cannot be granted immediately (never queued, never blocks). */
  class LockHeldFake implements OutboxLockManager {
    async request(_name: string, options: { ifAvailable?: boolean }, callback: () => Promise<unknown>): Promise<unknown> {
      if (options.ifAvailable) {
        return (callback as unknown as (lock: null) => Promise<unknown>)(null);
      }
      return callback();
    }
  }

  it("returns immediately with {drained: 0, failed: 0, remaining: N} and never touches the transport", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [
      { seq: 0, order: 1 },
      { seq: 1, order: 2 },
      { seq: 2, order: 3 },
    ]);
    const t = new MockTransport();
    const result = await drainOutboxOnce({ url: "ws://ignored", outbox, locks: new LockHeldFake(), _transport: t });

    expect(result).toEqual({ drained: 0, failed: 0, remaining: 3 });
    expect(t.sent).toHaveLength(0); // no Connect, no MutationBatch — never touched
    expect(t.closedCount).toBe(0); // never even opened
  });
});

/* -------------------------------------------------------------------------- */
/* known:false — unsent re-enqueue under a fresh clientId; parked -> failed     */
/* -------------------------------------------------------------------------- */

describe("drainOutboxOnce — ConnectAck{known:false} at the store level", () => {
  it("re-enqueues an unsent row under a fresh clientId (dequeue old, append new) and drains it", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [{ seq: 0, order: 1, body: "survivor" }]);
    const t = new MockTransport();
    const resultPromise = drainOutboxOnce({ url: "ws://ignored", outbox, locks: null, _transport: t });

    await waitFor(() => t.connects().length === 1);
    t.emit({ type: "ConnectAck", known: false, results: [], deploymentId: "dep-1" });

    // The reset re-enqueues under a fresh clientId, then the drain resends it — a SECOND batch.
    await waitFor(() => t.batches().length === 1, 3000);
    const batch = t.batches()[0]!;
    expect(batch.entries).toHaveLength(1);
    expect(batch.entries[0]!.clientId).not.toBe("old");
    expect(batch.entries[0]!.seq).toBe(0); // fresh identity's own seq counter starts at 0
    expect((batch.entries[0]!.args as { body: string }).body).toBe("survivor");

    applyBatch(t, batch);
    const result = await resultPromise;
    expect(result).toEqual({ drained: 1, failed: 0, remaining: 0 });

    // The OLD durable row is gone (dequeued at re-enqueue time); nothing survives under "old".
    const all = (await outbox.loadAll()).entries;
    expect(all).toHaveLength(0);
  });

  it("terminal-fails a parked row LOUDLY with OFFLINE_CLIENT_RESET instead of blind-resending it", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [{ seq: 0, order: 1, status: "parked" }]);
    const t = new MockTransport();
    const resultPromise = drainOutboxOnce({ url: "ws://ignored", outbox, locks: null, _transport: t });

    await waitFor(() => t.connects().length === 1);
    t.emit({ type: "ConnectAck", known: false, results: [], deploymentId: "dep-1" });

    const result = await resultPromise;
    expect(result).toEqual({ drained: 0, failed: 1, remaining: 0 });
    expect(t.batches()).toHaveLength(0); // never resent — rejected loudly instead

    const all = (await outbox.loadAll()).entries;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ clientId: "old", seq: 0, status: "failed", error: { code: "OFFLINE_CLIENT_RESET" } });
  });
});

/* -------------------------------------------------------------------------- */
/* getAuthToken -> SetAuth precedes Connect                                     */
/* -------------------------------------------------------------------------- */

describe("drainOutboxOnce — getAuthToken", () => {
  it("sends SetAuth before Connect when a token is available", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [{ seq: 0, order: 1 }]);
    const t = new MockTransport();
    const resultPromise = drainOutboxOnce({
      url: "ws://ignored",
      outbox,
      locks: null,
      _transport: t,
      getAuthToken: async () => "tok-123",
    });

    await waitFor(() => t.connects().length === 1);
    const setAuthIdx = t.sent.findIndex((m) => m.type === "SetAuth");
    const connectIdx = t.sent.findIndex((m) => m.type === "Connect");
    expect(setAuthIdx).toBeGreaterThanOrEqual(0);
    expect(connectIdx).toBeGreaterThan(setAuthIdx);
    expect((t.sent[setAuthIdx] as Extract<ClientMessage, { type: "SetAuth" }>).token).toBe("tok-123");

    t.emit({ type: "ConnectAck", known: true, results: [], deploymentId: "dep-1" });
    await waitFor(() => t.batches().length > 0);
    applyBatch(t, t.batches()[0]!);
    await resultPromise;
  });

  it("with no token resolved (null), sends no SetAuth at all", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [{ seq: 0, order: 1 }]);
    const t = new MockTransport();
    const resultPromise = drainOutboxOnce({
      url: "ws://ignored",
      outbox,
      locks: null,
      _transport: t,
      getAuthToken: async () => null,
    });
    await waitFor(() => t.connects().length === 1);
    expect(t.sent.some((m) => m.type === "SetAuth")).toBe(false);
    t.emit({ type: "ConnectAck", known: true, results: [], deploymentId: "dep-1" });
    await waitFor(() => t.batches().length > 0);
    applyBatch(t, t.batches()[0]!);
    await resultPromise;
  });
});

/* -------------------------------------------------------------------------- */
/* timeoutMs -> clean close + counts                                            */
/* -------------------------------------------------------------------------- */

describe("drainOutboxOnce — timeoutMs", () => {
  it("closes the transport and returns whatever counts it has when the queue never quiesces in time", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [
      { seq: 0, order: 1 },
      { seq: 1, order: 2 },
    ]);
    const t = new MockTransport();
    const resultPromise = drainOutboxOnce({ url: "ws://ignored", outbox, locks: null, _transport: t, timeoutMs: 40 });

    await waitFor(() => t.connects().length === 1);
    t.emit({ type: "ConnectAck", known: true, results: [], deploymentId: "dep-1" });
    await waitFor(() => t.batches().length > 0);
    // Settle only ONE of the two entries — the drain never reaches quiescence on its own.
    const batch = t.batches()[0]!;
    t.emit({ type: "MutationResponse", requestId: batch.entries[0]!.requestId, success: true, value: "ok0", ts: 5 });
    // (no response for the second entry — the drain is left waiting)

    const result = await resultPromise;
    expect(result.drained).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(1);
    expect(t.closedCount).toBe(1); // closed cleanly on timeout
  });
});
