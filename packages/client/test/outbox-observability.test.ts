/**
 * T5 — R9 observability (verdict §(d) "Observability"): `client.pendingMutations()` (a durable-store
 * snapshot, incl. `retry()`/`dismiss()`), `pendingSummary()` (hazard 2's client half), the
 * `onMutationFailed` refire (Lunora's `hadAwaiter` — never a double notification for a failure a
 * live promise already delivered THIS session; a fresh construction's "resume" scan refires for
 * every already-`"failed"` durable record unconditionally), the dev-mode loud `console.error`
 * default (no registered handler), and the cross-tab `BroadcastChannel` nudge (faked here — a real
 * one is exercised implicitly by every OTHER test in this suite via the ambient Node global, since
 * `outboxBroadcast` defaults to probing it).
 *
 * `usePendingMutations()` (the React hook) and the pending-tray recipe live in
 * `pending-tray-recipe.test.tsx` — this file is client-only.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  StackbaseClient,
  memoryOutbox,
  OUTBOX_VERSION,
  type MutationFailedInfo,
  type OutboxBroadcastLike,
  type OutboxEntry,
  type OutboxStorage,
} from "../src/index";
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
  close(): void {}
  emit(m: ServerMessage): void {
    for (const l of this.msg) l(m);
  }
  batches(): Array<Extract<ClientMessage, { type: "MutationBatch" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "MutationBatch" }> => m.type === "MutationBatch");
  }
  mutations(): Array<Extract<ClientMessage, { type: "Mutation" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "Mutation" }> => m.type === "Mutation");
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

async function seedOutbox(
  storage: OutboxStorage,
  clientId: string,
  rows: Array<{ seq: number; order: number; body?: string; status?: OutboxEntry["status"]; error?: OutboxEntry["error"] }>,
): Promise<void> {
  for (const r of rows) {
    const entry: OutboxEntry = {
      clientId,
      seq: r.seq,
      requestId: `old-${r.seq}`,
      udfPath: "messages:send",
      args: { body: r.body ?? `b${r.seq}` },
      seed: { entropy: `e${r.seq}`, now: 1000 + r.seq },
      order: r.order,
      status: r.status ?? "unsent",
      outboxVersion: OUTBOX_VERSION,
      enqueuedAt: 1000 + r.seq,
      error: r.error,
    };
    await storage.append(entry);
  }
}

/** Drives a seeded durable backlog through a real drain to a CODED terminal failure for seq 0 — the
 *  shared setup every "no live awaiter" (hadAwaiter=false) test needs. */
async function driveHydratedCodedFailure(opts: {
  outbox: OutboxStorage;
  onMutationFailed?: (info: MutationFailedInfo) => void;
}): Promise<{ t: MockTransport; client: StackbaseClient }> {
  await seedOutbox(opts.outbox, "old-client", [{ seq: 0, order: 0, body: "boom" }]);
  const t = new MockTransport();
  const client = new StackbaseClient(t, {
    outbox: opts.outbox,
    outboxLocks: null,
    outboxDrainIntervalMs: 0,
    onMutationFailed: opts.onMutationFailed,
    // This suite is single-instance R9 observability, not cross-tab behavior (that's its own
    // describe block below, using an isolated FakeBroadcastChannel bus) — every `it()` here reuses
    // the literal `"old-client"`/`seq 0` fixture and never closes its client, so left at the default
    // real ambient `BroadcastChannel` probe, T-crosstab's now-MEANINGFUL `settled`/`failed` payloads
    // would cross-talk between unrelated test cases that merely happen to share that fixture name.
    outboxBroadcast: null,
  });
  client.setOutboxArmed(true);
  await waitFor(() => t.batches().length > 0);
  const batch = t.batches()[0]!;
  t.emit({ type: "MutationResponse", requestId: batch.entries[0]!.requestId, success: false, error: "boom failed", code: "APP_ERR" });
  await tick();
  return { t, client };
}

/* -------------------------------------------------------------------------- */
/* pendingMutations() / pendingSummary()                                        */
/* -------------------------------------------------------------------------- */

describe("client.pendingMutations() / pendingSummary() (T5 R9)", () => {
  it("resolves [] / a zeroed summary without an outbox configured", async () => {
    const client = new StackbaseClient(new MockTransport());
    expect(await client.pendingMutations()).toEqual([]);
    expect(await client.pendingSummary()).toEqual({ count: 0, oldestEnqueuedAt: undefined, oldestAgeMs: undefined });
  });

  it("reflects the durable store — clientId/seq/udfPath/status/enqueuedAt", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old-client", [
      { seq: 0, order: 0, body: "a" },
      { seq: 1, order: 1, body: "b" },
    ]);
    const client = new StackbaseClient(new MockTransport(), { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, outboxBroadcast: null });
    await tick();
    const entries = await client.pendingMutations();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.seq).sort()).toEqual([0, 1]);
    for (const e of entries) {
      expect(e.clientId).toBe("old-client");
      expect(e.udfPath).toBe("messages:send");
      expect(typeof e.enqueuedAt).toBe("number");
      expect(["unsent", "inflight"]).toContain(e.status);
    }
  });

  it("pendingSummary() surfaces count + the OLDEST enqueuedAt/age", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "c", [
      { seq: 0, order: 0 }, // enqueuedAt 1000 — the oldest
      { seq: 1, order: 1 }, // enqueuedAt 1001
    ]);
    const client = new StackbaseClient(new MockTransport(), { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, outboxBroadcast: null });
    await tick();
    const summary = await client.pendingSummary();
    expect(summary.count).toBe(2);
    expect(summary.oldestEnqueuedAt).toBe(1000);
    expect(summary.oldestAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("a terminally-FAILED entry persists in pendingMutations() (status \"failed\", with .error) until dismissed/retried", async () => {
    const outbox = memoryOutbox();
    const { client } = await driveHydratedCodedFailure({ outbox });
    const entries = await client.pendingMutations();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ seq: 0, status: "failed", error: { message: 'mutation "messages:send" failed', code: "APP_ERR" } });
  });

  it("dismiss() permanently removes a FAILED entry without retrying", async () => {
    const outbox = memoryOutbox();
    const { client } = await driveHydratedCodedFailure({ outbox });
    const [failed] = await client.pendingMutations();
    await failed!.dismiss();
    await tick();
    expect(await client.pendingMutations()).toEqual([]);
  });

  it("retry() re-enqueues under a FRESH seq — the old seq's record IS its verdict, never resurrected", async () => {
    const outbox = memoryOutbox();
    const { t, client } = await driveHydratedCodedFailure({ outbox });
    const [failed] = await client.pendingMutations();
    expect(failed!.seq).toBe(0);
    await failed!.retry();
    await tick();

    const entries = await client.pendingMutations();
    expect(entries).toHaveLength(1);
    // never the SAME (clientId, seq) pair as the old, verdict-holding record — a fresh identity
    // (`retry()` stamps the CURRENT session's own clientId, so seq 0 under a brand-new clientId is
    // legitimate: it is not a reuse of THAT clientId's seq 0, which never existed until now).
    expect(`${entries[0]!.clientId}:${entries[0]!.seq}`).not.toBe(`${failed!.clientId}:${failed!.seq}`);
    expect(entries[0]!.status).not.toBe("failed"); // a fresh attempt, not a resurrection
    expect(entries[0]!.udfPath).toBe("messages:send");
    void t;
  });

  it("retry()/dismiss() on a non-failed entry are harmless no-ops", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "c", [{ seq: 0, order: 0 }]);
    const client = new StackbaseClient(new MockTransport(), { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, outboxBroadcast: null });
    await tick();
    const [unsent] = await client.pendingMutations();
    expect(unsent!.status).not.toBe("failed");
    await expect(unsent!.retry()).resolves.toBeUndefined();
    await expect(unsent!.dismiss()).resolves.toBeUndefined();
    await tick();
    // Untouched — still exactly the one original entry, at its original seq.
    const after = await client.pendingMutations();
    expect(after).toHaveLength(1);
    expect(after[0]!.seq).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* onMutationFailed — hadAwaiter gating + resume refire                        */
/* -------------------------------------------------------------------------- */

describe("onMutationFailed — hadAwaiter-style refire (T5 R9)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does NOT fire for a failure whose promise already rejected THIS session (a live awaiter)", async () => {
    const onMutationFailed = vi.fn();
    const outbox = memoryOutbox();
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, onMutationFailed, outboxBroadcast: null });
    client.setOutboxArmed(true);

    const p = client.mutation("messages:send", { body: "hi" });
    p.catch(() => {}); // a live awaiter exists
    await tick();
    const sent = t.mutations()[0]!;
    t.emit({ type: "MutationResponse", requestId: sent.requestId, success: false, error: "boom", code: "APP_ERR" });
    await expect(p).rejects.toMatchObject({ code: "APP_ERR" });
    await tick();

    expect(onMutationFailed).not.toHaveBeenCalled();
    // But the durable record still persists as "failed" — R9 doesn't depend on who was awaiting.
    const entries = await client.pendingMutations();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("failed");
  });

  it("DOES fire for a no-live-awaiter failure (a hydrated cross-reload entry settling this session)", async () => {
    const onMutationFailed = vi.fn();
    const outbox = memoryOutbox();
    await driveHydratedCodedFailure({ outbox, onMutationFailed });

    expect(onMutationFailed).toHaveBeenCalledTimes(1);
    expect(onMutationFailed).toHaveBeenCalledWith({
      clientId: "old-client",
      seq: 0,
      udfPath: "messages:send",
      error: { message: 'mutation "messages:send" failed', code: "APP_ERR" },
    });
  });

  it("refires on RESUME (construction) for every already-\"failed\" durable record left behind by a prior session", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old-client", [{ seq: 0, order: 0, status: "failed", error: { message: "left over", code: "APP_ERR" } }]);
    const onMutationFailed = vi.fn();
    new StackbaseClient(new MockTransport(), { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, onMutationFailed, outboxBroadcast: null });
    await tick();

    expect(onMutationFailed).toHaveBeenCalledTimes(1);
    expect(onMutationFailed).toHaveBeenCalledWith({ clientId: "old-client", seq: 0, udfPath: "messages:send", error: { message: "left over", code: "APP_ERR" } });
  });

  it("never double-fires: a subsequent unrelated outbox change does not re-trigger the resume refire", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old-client", [{ seq: 0, order: 0, status: "failed", error: { message: "left over", code: "APP_ERR" } }]);
    const onMutationFailed = vi.fn();
    const client = new StackbaseClient(new MockTransport(), { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, onMutationFailed, outboxBroadcast: null });
    await tick();
    expect(onMutationFailed).toHaveBeenCalledTimes(1);

    // An unrelated mutation, enqueued and left unsent — an outbox change, but not a failure.
    void client.mutation("messages:send", { body: "unrelated" });
    await tick();
    expect(onMutationFailed).toHaveBeenCalledTimes(1); // still just the one resume-time refire
  });

  it("dev-mode loud console.error default: fires when no onMutationFailed is registered", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const outbox = memoryOutbox();
    await driveHydratedCodedFailure({ outbox }); // no onMutationFailed

    const loud = errSpy.mock.calls.filter((c) => String(c[0]).includes("no onMutationFailed handler registered"));
    expect(loud).toHaveLength(1);
    expect(String(loud[0]![0])).toContain("messages:send");
    expect(String(loud[0]![0])).toContain("APP_ERR");
    errSpy.mockRestore();
  });

  it("dev-mode loud default stays SILENT in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const outbox = memoryOutbox();
    await driveHydratedCodedFailure({ outbox });

    const loud = errSpy.mock.calls.filter((c) => String(c[0]).includes("no onMutationFailed handler registered"));
    expect(loud).toHaveLength(0);
    errSpy.mockRestore();
  });

  it("the loud default stays silent when a handler IS registered (no double-reporting)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const outbox = memoryOutbox();
    await driveHydratedCodedFailure({ outbox, onMutationFailed: () => {} });

    const loud = errSpy.mock.calls.filter((c) => String(c[0]).includes("no onMutationFailed handler registered"));
    expect(loud).toHaveLength(0);
    errSpy.mockRestore();
  });
});

/* -------------------------------------------------------------------------- */
/* onOutboxChange + the BroadcastChannel cross-tab nudge (faked)                */
/* -------------------------------------------------------------------------- */

class FakeBroadcastBus {
  readonly channels = new Set<FakeBroadcastChannel>();
}

class FakeBroadcastChannel implements OutboxBroadcastLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(private readonly bus: FakeBroadcastBus) {
    bus.channels.add(this);
  }
  postMessage(message: unknown): void {
    for (const c of this.bus.channels) {
      if (c !== this) c.onmessage?.({ data: message });
    }
  }
  close(): void {
    this.bus.channels.delete(this);
  }
}

describe("client.onOutboxChange — same-instance + cross-tab BroadcastChannel nudge (T5 R9)", () => {
  it("fires locally on every outbox-mutating op (durable append)", async () => {
    const outbox = memoryOutbox();
    const client = new StackbaseClient(new MockTransport(), { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, outboxBroadcast: null });
    const spy = vi.fn();
    client.onOutboxChange(spy);
    void client.mutation("messages:send", { body: "hi" });
    await tick();
    expect(spy).toHaveBeenCalled();
  });

  it("a change in tab A nudges tab B via a FAKED BroadcastChannel sharing the SAME durable store", async () => {
    const outbox = memoryOutbox(); // simulates the shared IndexedDB an app would really use
    const bus = new FakeBroadcastBus();
    const clientA = new StackbaseClient(new MockTransport(), {
      outbox,
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      outboxBroadcast: new FakeBroadcastChannel(bus),
    });
    const clientB = new StackbaseClient(new MockTransport(), {
      outbox,
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      outboxBroadcast: new FakeBroadcastChannel(bus),
    });
    const spyB = vi.fn();
    clientB.onOutboxChange(spyB);

    void clientA.mutation("messages:send", { body: "from A" });
    await tick();

    expect(spyB).toHaveBeenCalled();
    // And B's OWN read reflects A's write — they share one durable store.
    const seenByB = await clientB.pendingMutations();
    expect(seenByB.some((e) => e.udfPath === "messages:send")).toBe(true);
  });

  it("outboxBroadcast: null disables the cross-tab nudge (same-instance observability still works)", async () => {
    const outbox = memoryOutbox();
    const bus = new FakeBroadcastBus();
    const clientA = new StackbaseClient(new MockTransport(), { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, outboxBroadcast: null });
    const clientB = new StackbaseClient(new MockTransport(), {
      outbox,
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      outboxBroadcast: new FakeBroadcastChannel(bus),
    });
    const spyB = vi.fn();
    clientB.onOutboxChange(spyB);

    void clientA.mutation("messages:send", { body: "from A" }); // A never posts — its channel is disabled
    await tick();
    expect(spyB).not.toHaveBeenCalled();
  });
});
