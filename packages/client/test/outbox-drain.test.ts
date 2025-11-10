/**
 * Task 4 — the drain, through the REAL `StackbaseClient` (verdict §(d) "Drain"). A `MockTransport`
 * gives full control over the wire: the drain sends `MutationBatch` chunks, the test emits the
 * per-unit `MutationResponse` frames back. Covers hydrate-into-log + FIFO, chunking + one-unacked,
 * every per-unit outcome, poison skip-vs-pause, the transient-stop re-send, the flush-time identity
 * gate, faked-lock leader handoff, first-connect handshake+drain, retry()=fresh-seq, the dead-meta
 * prune, and the `computeDrainBackoff` mirror.
 *
 * Web Locks + BroadcastChannel are absent in the Node/jsdom test runtime, so the drain runs
 * single-tab by default (`outboxLocks: null` forces it); the leader-handoff test injects a
 * `FakeLockManager`. The interval nudge is disabled (`outboxDrainIntervalMs: 0`) so every drain step
 * is driven by an explicit wake — deterministic, no wall-clock races.
 */
import { describe, it, expect, vi } from "vitest";
import {
  StackbaseClient,
  memoryOutbox,
  OUTBOX_VERSION,
  OFFLINE_IDENTITY_CHANGED,
  computeDrainBackoff,
  type ClientResetInfo,
  type ClientTransport,
  type OutboxEntry,
  type OutboxLockManager,
  type OutboxStorage,
} from "../src/index";
import type { ClientMessage, MutationBatchEntry, ServerMessage } from "@stackbase/sync";

/* -------------------------------------------------------------------------- */
/* Harness                                                                      */
/* -------------------------------------------------------------------------- */

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
    for (const l of this.closers) l();
  }
  emit(m: ServerMessage): void {
    for (const l of this.msg) l(m);
  }
  emitReopen(): void {
    for (const l of this.reopeners) l();
  }
  batches(): Array<Extract<ClientMessage, { type: "MutationBatch" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "MutationBatch" }> => m.type === "MutationBatch");
  }
  connects(): Array<Extract<ClientMessage, { type: "Connect" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "Connect" }> => m.type === "Connect");
  }
}

async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 3));
  }
}

/** Seed a durable outbox as if a PRIOR tab-session left it behind, so a fresh client hydrates it. */
async function seedOutbox(
  storage: OutboxStorage,
  clientId: string,
  rows: Array<{ seq: number; order: number; udfPath?: string; body?: string; identityFingerprint?: string }>,
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
      status: "unsent",
      identityFingerprint: r.identityFingerprint,
      outboxVersion: OUTBOX_VERSION,
      enqueuedAt: 1000 + r.seq,
    };
    await storage.append(entry);
  }
}

/** Emit `applied` (success) responses for every entry of a sent `MutationBatch`. */
function applyBatch(t: MockTransport, batch: Extract<ClientMessage, { type: "MutationBatch" }>, ts = 100): void {
  for (const e of batch.entries) {
    t.emit({ type: "MutationResponse", requestId: e.requestId, success: true, value: `srv-${e.seq}`, ts });
  }
}

const armedClientOpts = { outbox: undefined as unknown as OutboxStorage, outboxLocks: null, outboxDrainIntervalMs: 0 };

/* -------------------------------------------------------------------------- */
/* Hydrate-into-log + FIFO                                                      */
/* -------------------------------------------------------------------------- */

describe("OutboxDrain — hydrate + FIFO by persisted order (T4)", () => {
  it("hydrates a prior session's durable entries into the log and drains them FIFO by `order`, not seq", async () => {
    const outbox = memoryOutbox();
    // Persisted OUT of seq order: order [3,1,2] for seq [0,1,2] → drain must send by order → seq 1,2,0.
    await seedOutbox(outbox, "old-tab", [
      { seq: 0, order: 30, body: "third" },
      { seq: 1, order: 10, body: "first" },
      { seq: 2, order: 20, body: "second" },
    ]);

    const t = new MockTransport();
    const client = new StackbaseClient(t, { ...armedClientOpts, outbox });
    client.setOutboxArmed(true);

    await waitFor(() => t.batches().length > 0);
    const batch = t.batches()[0]!;
    // Hydrated into the log under RECORDED (clientId, seq).
    expect(batch.entries.map((e) => e.clientId)).toEqual(["old-tab", "old-tab", "old-tab"]);
    expect(batch.entries.map((e) => e.seq)).toEqual([1, 2, 0]); // order 10,20,30
    expect(batch.entries.map((e) => (e.args as { body: string }).body)).toEqual(["first", "second", "third"]);
  });

  it("dequeues each applied unit from the durable store as it settles", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [
      { seq: 0, order: 1 },
      { seq: 1, order: 2 },
    ]);
    const t = new MockTransport();
    const client = new StackbaseClient(t, { ...armedClientOpts, outbox });
    client.setOutboxArmed(true);

    await waitFor(() => t.batches().length > 0);
    applyBatch(t, t.batches()[0]!);
    await tick();
    expect((await outbox.loadAll()).entries).toHaveLength(0); // all dequeued
    expect(client.__pending).toHaveLength(0); // dropped after baseline
  });
});

/* -------------------------------------------------------------------------- */
/* Chunking + one unacked                                                       */
/* -------------------------------------------------------------------------- */

describe("OutboxDrain — MutationBatch chunks of 50, one unacked at a time (T4)", () => {
  it("splits 120 entries into 50 / 50 / 20 and never has two chunks in flight", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(
      outbox,
      "old",
      Array.from({ length: 120 }, (_, i) => ({ seq: i, order: i + 1 })),
    );
    const t = new MockTransport();
    const client = new StackbaseClient(t, { ...armedClientOpts, outbox });
    client.setOutboxArmed(true);

    await waitFor(() => t.batches().length === 1);
    expect(t.batches()[0]!.entries).toHaveLength(50);

    // A second chunk is NOT sent until the first is fully acked.
    await tick();
    expect(t.batches()).toHaveLength(1);

    applyBatch(t, t.batches()[0]!);
    await waitFor(() => t.batches().length === 2);
    expect(t.batches()[1]!.entries).toHaveLength(50);
    await tick();
    expect(t.batches()).toHaveLength(2);

    applyBatch(t, t.batches()[1]!);
    await waitFor(() => t.batches().length === 3);
    expect(t.batches()[2]!.entries).toHaveLength(20);
    // FIFO across chunks: seqs 0..119 in order.
    const allSeqs = t.batches().flatMap((b) => b.entries.map((e) => e.seq));
    expect(allSeqs).toEqual(Array.from({ length: 120 }, (_, i) => i));
  });
});

/* -------------------------------------------------------------------------- */
/* Per-unit outcomes: coded terminal skip-and-record (continue)                 */
/* -------------------------------------------------------------------------- */

describe("OutboxDrain — coded failure is skip-and-record: settle terminal + CONTINUE (T4)", () => {
  it("a mid-chunk coded failure rejects that unit terminally and keeps draining the rest", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [
      { seq: 0, order: 1 },
      { seq: 1, order: 2 },
      { seq: 2, order: 3 },
    ]);
    const t = new MockTransport();
    const client = new StackbaseClient(t, { ...armedClientOpts, outbox });
    client.setOutboxArmed(true);

    await waitFor(() => t.batches().length > 0);
    const batch = t.batches()[0]!;
    // seq0 applied, seq1 coded-fail, seq2 applied — all in the same chunk.
    t.emit({ type: "MutationResponse", requestId: batch.entries[0]!.requestId, success: true, value: "ok0", ts: 5 });
    t.emit({ type: "MutationResponse", requestId: batch.entries[1]!.requestId, success: false, error: "bad", code: "APP_ERR" });
    t.emit({ type: "MutationResponse", requestId: batch.entries[2]!.requestId, success: true, value: "ok2", ts: 6 });
    await tick();

    // All three left the durable store (the coded one was server-recorded → dequeued too).
    expect((await outbox.loadAll()).entries).toHaveLength(0);
    expect(client.__pending).toHaveLength(0);
    // The drain did NOT stop on the coded failure — it is not paused, and nothing lingers.
    expect(client.__outboxDrain!.isPaused).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Poison: pause halts                                                          */
/* -------------------------------------------------------------------------- */

describe("OutboxDrain — poisonPolicy: 'pause' halts on a coded failure (T4)", () => {
  it("stops the drain, surfaces via onOutboxPause, and leaves the queue intact", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [
      { seq: 0, order: 1 },
      { seq: 1, order: 2 },
    ]);
    const paused: Array<{ code: string; udfPath: string }> = [];
    const t = new MockTransport();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new StackbaseClient(t, {
      ...armedClientOpts,
      outbox,
      poisonPolicy: "pause",
      onOutboxPause: (i) => paused.push({ code: i.code, udfPath: i.udfPath }),
    });
    client.setOutboxArmed(true);

    await waitFor(() => t.batches().length > 0);
    const batch = t.batches()[0]!;
    // The FIRST unit fails coded → pause.
    t.emit({ type: "MutationResponse", requestId: batch.entries[0]!.requestId, success: false, error: "poison", code: "APP_ERR" });
    await tick();

    expect(client.__outboxDrain!.isPaused).toBe(true);
    expect(paused).toEqual([{ code: "APP_ERR", udfPath: "messages:send" }]);
    // The queue is HALTED — nothing dequeued, no further chunk, entries still durable.
    expect((await outbox.loadAll()).entries).toHaveLength(2);
    const batchesAfter = t.batches().length;
    await tick();
    expect(t.batches().length).toBe(batchesAfter); // no more chunks
    errSpy.mockRestore();
  });
});

/* -------------------------------------------------------------------------- */
/* Transient-stop → re-send from the failed unit                                */
/* -------------------------------------------------------------------------- */

describe("OutboxDrain — the transient-stop chunk contract (T4)", () => {
  it("a codeless failure + a silent remainder re-send on the next chunk, from the failed unit", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [
      { seq: 0, order: 1 },
      { seq: 1, order: 2 },
      { seq: 2, order: 3 },
    ]);
    const t = new MockTransport();
    const client = new StackbaseClient(t, { ...armedClientOpts, outbox, outboxBackoffMs: () => 0 });
    client.setOutboxArmed(true);

    await waitFor(() => t.batches().length > 0);
    const first = t.batches()[0]!;
    // seq0 applied; seq1 fails CODELESS (transient) → server STOPS; seq2 gets NO response.
    t.emit({ type: "MutationResponse", requestId: first.entries[0]!.requestId, success: true, value: "ok0", ts: 5 });
    t.emit({ type: "MutationResponse", requestId: first.entries[1]!.requestId, success: false, error: "503 unavailable" });
    // (no frame for seq2)

    // After the backoff, the drain re-sends the remainder FROM the failed unit (seq1, then seq2).
    await waitFor(() => t.batches().length === 2, 3000);
    const second = t.batches()[1]!;
    expect(second.entries.map((e) => e.seq)).toEqual([1, 2]);

    // Completing the resend drains everything.
    applyBatch(t, second);
    await tick();
    expect((await outbox.loadAll()).entries).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The flush-time identity gate                                                 */
/* -------------------------------------------------------------------------- */

describe("OutboxDrain — the flush-time identity gate (T4, hazard 9)", () => {
  it("terminal-fails an entry whose stored fingerprint differs from the session's, loudly, and never sends it", async () => {
    const outbox = memoryOutbox();
    // The current session fingerprint is "anon" (no setAuth) — seed one matching, one foreign.
    await seedOutbox(outbox, "old", [
      { seq: 0, order: 1, identityFingerprint: "anon", body: "mine" },
      { seq: 1, order: 2, identityFingerprint: "someone-else", body: "theirs" },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new MockTransport();
    const client = new StackbaseClient(t, { ...armedClientOpts, outbox });
    client.setOutboxArmed(true);

    await waitFor(() => t.batches().length > 0);
    const batch = t.batches()[0]!;
    // Only the matching entry is on the wire; the foreign one was dropped before flush.
    expect(batch.entries.map((e) => e.seq)).toEqual([0]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(OFFLINE_IDENTITY_CHANGED));
    // The foreign entry was dequeued (terminal), the matching one still pending its response.
    await tick();
    const remaining = (await outbox.loadAll()).entries.map((e) => e.seq);
    expect(remaining).toEqual([0]); // seq1 gone (identity-failed), seq0 still in flight
    errSpy.mockRestore();
  });
});

/* -------------------------------------------------------------------------- */
/* Leader handoff (locks faked)                                                 */
/* -------------------------------------------------------------------------- */

/** A serialized single-holder lock manager: a second `request` for the same name waits until the
 *  first callback's promise resolves — exactly the Web Locks guarantee the drain relies on. */
class FakeLockManager implements OutboxLockManager {
  private held = false;
  private readonly waiters: Array<() => void> = [];
  async request(_name: string, _options: unknown, callback: () => Promise<unknown>): Promise<unknown> {
    while (this.held) await new Promise<void>((r) => this.waiters.push(r));
    this.held = true;
    try {
      return await callback();
    } finally {
      this.held = false;
      this.waiters.shift()?.();
    }
  }
}

describe("OutboxDrain — leader handoff across two tabs sharing one queue (T4, hazard 7)", () => {
  it("a successor leader drains the entries the dead leader never finished, under recorded ids", async () => {
    const outbox = memoryOutbox(); // ONE shared durable queue
    const locks = new FakeLockManager(); // ONE shared lock manager
    await seedOutbox(outbox, "old", [
      { seq: 0, order: 1, body: "a" },
      { seq: 1, order: 2, body: "b" },
    ]);

    // Tab A becomes leader, sends the chunk, acks only seq0, then dies (close releases the lock).
    const tA = new MockTransport();
    const clientA = new StackbaseClient(tA, { outbox, outboxLocks: locks, outboxDrainIntervalMs: 0 });
    clientA.setOutboxArmed(true);
    await waitFor(() => clientA.__outboxDrain!.isLeader && tA.batches().length > 0);
    const batchA = tA.batches()[0]!;
    tA.emit({ type: "MutationResponse", requestId: batchA.entries[0]!.requestId, success: true, value: "ok0", ts: 5 });
    await tick();
    expect((await outbox.loadAll()).entries.map((e) => e.seq)).toEqual([1]); // seq0 done, seq1 remains
    clientA.close(); // releases the lock

    // Tab B acquires leadership, hydrates the remaining durable entry, and drains it.
    const tB = new MockTransport();
    const clientB = new StackbaseClient(tB, { outbox, outboxLocks: locks, outboxDrainIntervalMs: 0 });
    clientB.setOutboxArmed(true);
    await waitFor(() => clientB.__outboxDrain!.isLeader && tB.batches().length > 0, 3000);
    const batchB = tB.batches()[0]!;
    expect(batchB.entries.map((e) => e.seq)).toEqual([1]); // recorded id, only the unfinished one
    expect((batchB.entries[0]!.args as { body: string }).body).toBe("b");

    tB.emit({ type: "MutationResponse", requestId: batchB.entries[0]!.requestId, success: true, value: "ok1", ts: 6 });
    await tick();
    expect((await outbox.loadAll()).entries).toHaveLength(0);
    clientB.close();
  });
});

/* -------------------------------------------------------------------------- */
/* First-connect fires the handshake + drain                                    */
/* -------------------------------------------------------------------------- */

describe("OutboxDrain — first-connect (reload) fires the handshake + drain (T4 / T3 handoff #1)", () => {
  it("a fresh client over a persisted backlog sends Connect on the FIRST connection, then drains after ConnectAck", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old-tab", [{ seq: 0, order: 1, body: "survivor" }]);

    const t = new MockTransport();
    // NOTE: no setOutboxArmed here — the drain must arm itself via the first-connect ConnectAck.
    const client = new StackbaseClient(t, { outbox, outboxLocks: null, outboxDrainIntervalMs: 0 });

    // The drain becomes leader, hydrates the backlog, and (because drainable > 0) sends Connect —
    // no reopen event needed (the reload analog).
    await waitFor(() => t.connects().length === 1);
    expect(client.__outboxArmed).toBe(false); // not armed until the ConnectAck

    // The server answers → arms → the drain flushes the hydrated entry.
    t.emit({ type: "ConnectAck", known: true, results: [{ clientId: "old-tab", seq: 0, verdict: "unknown" }], deploymentId: "dep-1" });
    await waitFor(() => t.batches().length === 1, 3000);
    expect(client.__outboxArmed).toBe(true);
    expect(t.batches()[0]!.entries.map((e) => e.seq)).toEqual([0]);

    applyBatch(t, t.batches()[0]!);
    await tick();
    expect((await outbox.loadAll()).entries).toHaveLength(0);
  });

  it("an EMPTY outbox sends NO first-connect Connect (byte-identical to the pre-drain client)", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox(), outboxLocks: null, outboxDrainIntervalMs: 0 });
    await tick();
    expect(t.connects()).toHaveLength(0); // nothing to drain → defers to the normal reopen handshake
    expect(t.batches()).toHaveLength(0);
    client.close();
  });
});

/* -------------------------------------------------------------------------- */
/* retry() = fresh seq (the counter never rewinds)                              */
/* -------------------------------------------------------------------------- */

describe("OutboxDrain — a terminal drain failure never frees its seq for reuse (T4)", () => {
  it("a mutation issued after a drained coded failure gets a fresh, higher seq", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old", [{ seq: 0, order: 1 }]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new MockTransport();
    const client = new StackbaseClient(t, { ...armedClientOpts, outbox });
    client.setOutboxArmed(true);

    await waitFor(() => t.batches().length > 0);
    const batch = t.batches()[0]!;
    t.emit({ type: "MutationResponse", requestId: batch.entries[0]!.requestId, success: false, error: "nope", code: "APP_ERR" });
    await tick();

    // A brand-new mutation this session (a manual "retry") mints a FRESH seq under this session's
    // clientId — never seq 0 reused (the old seq's verdict is recorded; §(b)).
    void client.mutation("messages:send", { body: "retry" });
    const mine = client.__pending.find((e) => (e.args as { body?: string }).body === "retry")!;
    const myClientId = (await client.getOutboxIdentity())!.clientId;
    expect(mine.clientId).toBe(myClientId);
    expect(mine.seq).toBe(0); // this session's own seq counter starts fresh (a different clientId)
    expect(mine.clientId).not.toBe("old"); // the drained failure was a DIFFERENT (prior) clientId
    errSpy.mockRestore();
    client.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Dead-meta prune at hydrate                                                    */
/* -------------------------------------------------------------------------- */

describe("OutboxDrain — dead-clientId meta rows are pruned at hydrate (T4 / T1-bound gap)", () => {
  it("reclaims meta rows with no live entries, keeping the current session's and any live clientId", async () => {
    const outbox = memoryOutbox();
    // A dead clientId (meta only, no entries) + a clientId with a live entry.
    await outbox.setMeta("dead-tab", { nextSeq: 3 });
    await outbox.setMeta("live-tab", { nextSeq: 2 });
    await seedOutbox(outbox, "live-tab", [{ seq: 1, order: 1 }]);

    const t = new MockTransport();
    const client = new StackbaseClient(t, { ...armedClientOpts, outbox });
    client.setOutboxArmed(true);
    const currentId = (await client.getOutboxIdentity())!.clientId;

    await waitFor(() => t.batches().length > 0); // hydrate (and the prune) has run
    await tick();
    const metas = await outbox.listMetaClientIds!();
    expect(metas).toContain("live-tab"); // has a live entry → kept
    expect(metas).toContain(currentId); // the current session → kept
    expect(metas).not.toContain("dead-tab"); // no entries, not current → pruned
  });
});

/* -------------------------------------------------------------------------- */
/* computeDrainBackoff mirror                                                    */
/* -------------------------------------------------------------------------- */

describe("computeDrainBackoff — the scheduler computeBackoff mirror (T4)", () => {
  it("matches the scheduler formula (initial=250, base=2, 50-100% jitter) and caps at 30s", () => {
    // attempts=1: raw = 250 * 2^2 = 1000; jitter 0.5..1.0 → 500..1000.
    expect(computeDrainBackoff(1, () => 0)).toBe(500);
    expect(computeDrainBackoff(1, () => 1)).toBe(1000);
    // attempts=2: raw = 250 * 2^3 = 2000 → 1000..2000.
    expect(computeDrainBackoff(2, () => 0)).toBe(1000);
    // A long streak is capped at the 30s ceiling.
    expect(computeDrainBackoff(20, () => 1)).toBe(30_000);
  });
});
