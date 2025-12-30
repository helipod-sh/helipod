/**
 * Task 3 — the `Connect` resume handshake, per-verdict settlement, the baseline-gated drop rule,
 * and `onClientReset`, through the REAL `StackbaseClient`. Two harnesses (the verdict §(h) split):
 *
 *  - `MockTransport` (the `reconnect.test.ts` / `outbox-enqueue.test.ts` pattern) for the frames the
 *    engine can't be coaxed to produce on demand: the exact `Connect` shape, each `ConnectAck`
 *    verdict, the baseline-await ORDERING (a spy proves no drop/drain frame precedes adoption), the
 *    drop rule's no-flicker (collected listener frames), and `known: false` reset semantics.
 *  - A real embedded-runtime loopback (the `gated-ledger.test.ts` pattern) wrapped in a
 *    reopen-capable transport, proving the shipped `SyncProtocolHandler` genuinely speaks
 *    `Connect`/`ConnectAck` — the client arms, surfaces the `deploymentId`, and drives the reset
 *    path end-to-end against the actual server.
 */
import { describe, it, expect, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
import type { IndexSpec } from "@stackbase/query-engine";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import {
  StackbaseClient,
  OfflineClientResetError,
  memoryOutbox,
  OUTBOX_VERSION,
  type ClientResetInfo,
  type ClientTransport,
} from "../src/index";
import type { OutboxEntry, OutboxStorage } from "../src/outbox-storage";
import type { ClientMessage, ServerMessage } from "@stackbase/sync";

/* -------------------------------------------------------------------------- */
/* MockTransport — full control over server frames + reopen synthesis          */
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
  connects(): Array<Extract<ClientMessage, { type: "Connect" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "Connect" }> => m.type === "Connect");
  }
  mutations(): Array<Extract<ClientMessage, { type: "Mutation" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "Mutation" }> => m.type === "Mutation");
  }
  batches(): Array<Extract<ClientMessage, { type: "MutationBatch" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "MutationBatch" }> => m.type === "MutationBatch");
  }
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Issue a mutation while the transport is synthetically closed → it retains as `unsent`, durably
 *  appended. Returns the (kept-pending) mutation promise SYNCHRONOUSLY (never awaited here — a bare
 *  `await` would flatten onto the never-settling promise); flush + await the append separately. */
function enqueueUnsent(client: StackbaseClient, body: string): Promise<unknown> {
  return client.mutation("messages:send", { body });
}

/* -------------------------------------------------------------------------- */
/* The Connect handshake shape                                                  */
/* -------------------------------------------------------------------------- */

describe("StackbaseClient — the Connect handshake on reopen (T3)", () => {
  it("no-outbox reopen sends only a capability-only Connect (no resume handshake); the naive unsent flush is unchanged", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);
    t.emitClose();
    void client.mutation("messages:send", { body: "A" });
    t.emitReopen();
    // DLR 2a: a no-outbox client advertises `supportsQueryDiff` via a capability-only Connect, but
    // NEVER the resume handshake — no clientId/held/ackedThrough (the dedup handshake is outbox-only).
    const connects = t.connects();
    expect(connects).toHaveLength(1);
    expect(connects[0]!.supportsQueryDiff).toBe(true);
    expect(connects[0]!.clientId).toBeUndefined();
    expect(connects[0]!.held).toBeUndefined();
    expect(connects[0]!.ackedThrough).toBeUndefined();
    // The one unsent mutation still flushed exactly as before.
    expect(t.mutations().map((m) => (m.args as { body: string }).body)).toEqual(["A"]);
  });

  it("sends Connect{clientId, held, ackedThrough} on reopen for a configured outbox — held = every unsettled durable entry, ackedThrough omitted when the lowest held seq is 0", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox() });
    client.setOutboxArmed(true);
    const cid = (await client.getOutboxIdentity())!.clientId;

    // A (seq0) sent then parked at close; B (seq1) enqueued while down.
    void client.mutation("messages:send", { body: "A" });
    await flushMicrotasks();
    t.emitClose(); // parks A (durable + armed)
    void enqueueUnsent(client, "B"); // seq1, unsent
    await flushMicrotasks();

    t.emitReopen();
    const conn = t.connects();
    expect(conn).toHaveLength(1);
    expect(conn[0]!.clientId).toBe(cid);
    expect(conn[0]!.held).toEqual([
      { clientId: cid, seq: 0 },
      { clientId: cid, seq: 1 },
    ]);
    // Lowest held seq is 0 → nothing has been contiguously settled → ackedThrough empty.
    expect(conn[0]!.ackedThrough).toEqual([]);
  });

  it("ackedThrough = (lowest held seq) - 1 once an earlier seq has settled and dequeued", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox() });
    const cid = (await client.getOutboxIdentity())!.clientId;

    // seq0 committed online → acked + dequeued + removed from the log.
    const p0 = client.mutation("messages:send", { body: "settled" });
    const req0 = client.__pending[0]!.requestId;
    t.emit({ type: "MutationResponse", requestId: req0, success: true, value: "id0", ts: 5 });
    await expect(p0).resolves.toBe("id0");

    // seq1 enqueued while down → unsent, held.
    t.emitClose();
    void enqueueUnsent(client, "held");
    await flushMicrotasks();

    t.emitReopen();
    const conn = t.connects()[0]!;
    expect(conn.held).toEqual([{ clientId: cid, seq: 1 }]);
    expect(conn.ackedThrough).toEqual([{ clientId: cid, seq: 0 }]); // 0 settled contiguously
  });
});

/* -------------------------------------------------------------------------- */
/* Per-verdict settlement                                                       */
/* -------------------------------------------------------------------------- */

describe("StackbaseClient — ConnectAck verdict settlement (T3)", () => {
  function armedClient(outbox: OutboxStorage = memoryOutbox()): { t: MockTransport; client: StackbaseClient } {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox });
    return { t, client };
  }

  it("ConnectAck arms the S4 park swap and surfaces the deploymentId", async () => {
    const { t, client } = armedClient();
    expect(client.__outboxArmed).toBe(false);
    const cid = (await client.getOutboxIdentity())!.clientId;
    t.emit({ type: "ConnectAck", known: true, results: [], deploymentId: "dep-xyz" });
    expect(client.__outboxArmed).toBe(true);
    expect(client.getOutboxDeploymentId()).toBe("dep-xyz");
    void cid;
  });

  it("applied → the awaiting (parked) promise resolves with the recorded value, and the durable record is dequeued", async () => {
    const outbox = memoryOutbox();
    const { t, client } = armedClient(outbox);
    client.setOutboxArmed(true);
    const cid = (await client.getOutboxIdentity())!.clientId;

    const p = client.mutation("messages:send", { body: "hi" });
    await flushMicrotasks();
    t.emitClose(); // parks (durable + armed) — the promise stays pending
    expect(client.__pending[0]!.status.type).toBe("parked");

    t.emitReopen();
    t.emit({ type: "ConnectAck", known: true, results: [{ clientId: cid, seq: 0, verdict: "applied", commitTs: 7, value: "server-id" }], deploymentId: "d" });

    await expect(p).resolves.toBe("server-id");
    await flushMicrotasks();
    expect((await outbox.loadAll()).entries).toHaveLength(0); // dequeued on settle
    expect(client.__pending).toHaveLength(0); // dropped once baseline adopted (no subs → immediate)
  });

  it("applied with valueMissing resolves with null (the crash-window is tolerated)", async () => {
    const { t, client } = armedClient();
    client.setOutboxArmed(true);
    const cid = (await client.getOutboxIdentity())!.clientId;
    const p = client.mutation("messages:send", { body: "hi" });
    await flushMicrotasks();
    t.emitClose();
    t.emitReopen();
    t.emit({ type: "ConnectAck", known: true, results: [{ clientId: cid, seq: 0, verdict: "applied", commitTs: 7, valueMissing: true }], deploymentId: "d" });
    await expect(p).resolves.toBeNull();
  });

  it("failed → the promise rejects with the terminal code; stale → STALE_CLIENT; both persist `\"failed\"` durably (T5 R9)", async () => {
    const outbox = memoryOutbox();
    const { t, client } = armedClient(outbox);
    client.setOutboxArmed(true);
    const cid = (await client.getOutboxIdentity())!.clientId;

    const failP = client.mutation("messages:send", { body: "boom" });
    const staleP = client.mutation("messages:send", { body: "old" });
    await flushMicrotasks();
    t.emitClose();
    t.emitReopen();
    t.emit({
      type: "ConnectAck",
      known: true,
      results: [
        { clientId: cid, seq: 0, verdict: "failed", code: "APP_ERROR" },
        { clientId: cid, seq: 1, verdict: "stale", code: "STALE_CLIENT" },
      ],
      deploymentId: "d",
    });

    await expect(failP).rejects.toMatchObject({ code: "APP_ERROR" });
    await expect(staleP).rejects.toMatchObject({ code: "STALE_CLIENT" });
    await flushMicrotasks();
    // T5 (R9): a `failed`/`stale` ConnectAck verdict MARKS the durable record `"failed"` instead of
    // dequeuing it — "failed entries persist until dismissed/retried" (verdict §(d) Observability).
    const remaining = (await outbox.loadAll()).entries;
    expect(remaining).toHaveLength(2);
    expect(remaining.every((e) => e.status === "failed")).toBe(true);
    const bySeq = new Map(remaining.map((e) => [e.seq, e]));
    expect(bySeq.get(0)?.error).toMatchObject({ code: "APP_ERROR" });
    expect(bySeq.get(1)?.error).toMatchObject({ code: "STALE_CLIENT" });
    expect(client.__pending).toHaveLength(0);
  });

  it("unknown → the entry REMAINS in the log for the drain (T4); its promise stays pending", async () => {
    const { t, client } = armedClient();
    client.setOutboxArmed(true);
    const cid = (await client.getOutboxIdentity())!.clientId;
    const p = client.mutation("messages:send", { body: "never-seen" });
    await flushMicrotasks();
    t.emitClose();
    t.emitReopen();

    let settled = false;
    void p.then(() => (settled = true), () => (settled = true));
    t.emit({ type: "ConnectAck", known: true, results: [{ clientId: cid, seq: 0, verdict: "unknown" }], deploymentId: "d" });
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(client.__pending).toHaveLength(1); // still there, awaiting the drain
  });
});

/* -------------------------------------------------------------------------- */
/* The baseline await — ordering                                                */
/* -------------------------------------------------------------------------- */

describe("StackbaseClient — the baseline await (T3 / spec decision 5)", () => {
  it("whenBaselineAdopted() and the applied-drop fire ONLY after the first post-Connect Transition is adopted — never before", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox() });
    client.setOutboxArmed(true);
    const cid = (await client.getOutboxIdentity())!.clientId;

    // A live subscription so the reopen's resync actually awaits a re-baseline Transition.
    client.subscribe("messages:list", {}, () => {});
    // Establish the initial session baseline (contiguous), then a parked entry.
    t.emit({ type: "Transition", startVersion: { querySet: 0, ts: 0 }, endVersion: { querySet: 1, ts: 1 }, modifications: [{ type: "QueryUpdated", queryId: 1, value: [] }] });
    void client.mutation("messages:send", { body: "hi" });
    await flushMicrotasks();
    t.emitClose(); // parks

    // Reopen begins the handshake + baseline await.
    t.emitReopen();

    let baselineResolved = false;
    void client.whenBaselineAdopted().then(() => (baselineResolved = true));

    // ConnectAck (applied) arrives BEFORE the baseline Transition.
    t.emit({ type: "ConnectAck", known: true, results: [{ clientId: cid, seq: 0, verdict: "applied", commitTs: 3, value: "x" }], deploymentId: "d" });
    await flushMicrotasks();
    // The drain gate is still closed and the deferred drop has NOT executed — the entry lingers.
    expect(baselineResolved).toBe(false);
    expect(client.__pending).toHaveLength(1);

    // The baseline Transition adopts (resync reply) → gate opens, deferred drop fires.
    t.emit({ type: "Transition", startVersion: { querySet: 1, ts: 1 }, endVersion: { querySet: 2, ts: 4 }, modifications: [{ type: "QueryUpdated", queryId: 1, value: [] }] });
    await flushMicrotasks();
    expect(baselineResolved).toBe(true);
    expect(client.__pending).toHaveLength(0);
  });

  it("with no live subscriptions the baseline is adopted immediately (nothing to re-baseline)", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox() });
    t.emitReopen(); // no subs → resync no-ops → baseline immediate
    await expect(client.whenBaselineAdopted()).resolves.toBeUndefined();
  });

  it("the drop rule fires as an S3 reconcile event only after adoption — spied", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox() });
    client.setOutboxArmed(true);
    const cid = (await client.getOutboxIdentity())!.clientId;
    const spy = vi.spyOn((client as unknown as { reconciler: { onVerdictAfterBaseline: (r: string) => void } }).reconciler, "onVerdictAfterBaseline");

    client.subscribe("messages:list", {}, () => {});
    t.emit({ type: "Transition", startVersion: { querySet: 0, ts: 0 }, endVersion: { querySet: 1, ts: 1 }, modifications: [{ type: "QueryUpdated", queryId: 1, value: [] }] });
    void client.mutation("messages:send", { body: "hi" });
    await flushMicrotasks();
    t.emitClose();
    t.emitReopen();
    t.emit({ type: "ConnectAck", known: true, results: [{ clientId: cid, seq: 0, verdict: "applied", commitTs: 3, value: "x" }], deploymentId: "d" });
    await flushMicrotasks();
    expect(spy).not.toHaveBeenCalled(); // deferred — baseline not yet adopted

    t.emit({ type: "Transition", startVersion: { querySet: 1, ts: 1 }, endVersion: { querySet: 2, ts: 4 }, modifications: [{ type: "QueryUpdated", queryId: 1, value: [] }] });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* First-connect deadlock repro (T4 bug fix): subscribe-before-arm             */
/* -------------------------------------------------------------------------- */

describe("StackbaseClient — first-connect handshake vs. a subscription delivered before hydrate finishes (T4 bug fix)", () => {
  /** Wraps a real `OutboxStorage` so `loadAll` (the drain's hydrate) hangs until released —
   *  simulates a slow IndexedDB open / a hydrate that hasn't resolved yet on a fresh page load. */
  function delayedLoadAllOutbox(real: OutboxStorage): { outbox: OutboxStorage; release: () => void } {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      outbox: {
        ...real,
        loadAll: async () => {
          await gate;
          return real.loadAll();
        },
      },
      release,
    };
  }

  it("a subscription created (and answered) BEFORE hydrate completes does not starve whenBaselineAdopted() forever", async () => {
    const real = memoryOutbox();
    // A prior tab-session left one durable entry behind — the drain must hydrate + drain it.
    const seeded: OutboxEntry = {
      clientId: "old-tab",
      seq: 0,
      requestId: "old-0",
      udfPath: "messages:send",
      args: { body: "queued" },
      seed: { entropy: "e0", now: 1000 },
      order: 1,
      status: "unsent",
      outboxVersion: OUTBOX_VERSION,
      enqueuedAt: 1000,
    };
    await real.append(seeded);
    const { outbox: delayed, release: releaseLoad } = delayedLoadAllOutbox(real);

    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: delayed, outboxLocks: null, outboxDrainIntervalMs: 0 });

    // NATURAL app-code ordering: subscribe immediately on construction, well before the drain's
    // queued `becomeLeader` microtask even runs. The server answers with the initial Transition
    // WHILE hydrate is still pending — this subscription's baseline has already arrived by the time
    // the drain gets around to arming.
    client.subscribe("messages:list", {}, () => {});
    t.emit({ type: "Transition", startVersion: { querySet: 0, ts: 0 }, endVersion: { querySet: 1, ts: 1 }, modifications: [{ type: "QueryUpdated", queryId: 1, value: [] }] });
    await flushMicrotasks();

    // Now let hydrate complete — the drain becomes leader for real and, seeing a durable backlog,
    // fires the first-connect handshake.
    releaseLoad();
    await waitFor(() => t.connects().length === 1, 3000);
    t.emit({ type: "ConnectAck", known: true, results: [{ clientId: "old-tab", seq: 0, verdict: "unknown" }], deploymentId: "dep-1" });
    await waitFor(() => client.__outboxArmed, 3000);

    // Pre-fix: `expectTransition` was `byId.size > 0` — true, because the subscription is registered,
    // even though ITS Transition already landed. No further Transition ever arrives on this quiet
    // deployment, so `whenBaselineAdopted()` never resolves and the drain deadlocks (armed=true,
    // drained=false, forever). Post-fix, `hasUndeliveredSubscription()` correctly reports nothing is
    // still awaiting delivery, so the baseline adopts immediately and the drain flushes.
    await waitFor(() => t.batches().length === 1, 3000);
    expect(t.batches()[0]!.entries.map((e) => e.seq)).toEqual([0]);

    t.emit({ type: "MutationResponse", requestId: t.batches()[0]!.entries[0]!.requestId, success: true, value: "srv-0", ts: 5 });
    await flushMicrotasks();
    expect((await real.loadAll()).entries).toHaveLength(0);
    client.close();
  });

  it("a subscription answered with QueryFailed (not QueryUpdated) BEFORE hydrate completes does not starve whenBaselineAdopted() forever (re-review FIX 2)", async () => {
    // Same T4 shape as the test above, but the pre-arm answer is a FAILURE. `hasUndeliveredSubscription()`
    // used to key off `sub.serverValue === undefined` — a QueryFailed answer never sets `serverValue`
    // (reconcile.ts's QueryFailed branch only fires `onError`), so a failed-but-answered subscription
    // still counted as "undelivered" → `expectTransition=true` → the awaited Transition never comes on
    // a quiet deployment → the same drain deadlock as the T4 bug, just via the failed-query shape.
    const real = memoryOutbox();
    const seeded: OutboxEntry = {
      clientId: "old-tab",
      seq: 0,
      requestId: "old-0",
      udfPath: "messages:send",
      args: { body: "queued" },
      seed: { entropy: "e0", now: 1000 },
      order: 1,
      status: "unsent",
      outboxVersion: OUTBOX_VERSION,
      enqueuedAt: 1000,
    };
    await real.append(seeded);
    const { outbox: delayed, release: releaseLoad } = delayedLoadAllOutbox(real);

    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: delayed, outboxLocks: null, outboxDrainIntervalMs: 0 });

    // Natural app-code ordering: subscribe immediately, well before the drain's hydrate resolves.
    // The server answers with a QueryFailed WHILE hydrate is still pending — this subscription has
    // already been "answered" (with a failure) by the time the drain gets around to arming.
    client.subscribe("messages:list", {}, () => {}, () => {});
    t.emit({ type: "Transition", startVersion: { querySet: 0, ts: 0 }, endVersion: { querySet: 1, ts: 1 }, modifications: [{ type: "QueryFailed", queryId: 1, error: "bad args" }] });
    await flushMicrotasks();

    releaseLoad();
    await waitFor(() => t.connects().length === 1, 3000);
    t.emit({ type: "ConnectAck", known: true, results: [{ clientId: "old-tab", seq: 0, verdict: "unknown" }], deploymentId: "dep-1" });
    await waitFor(() => client.__outboxArmed, 3000);

    // Pre-fix: the failed-but-answered subscription still reported "undelivered" (serverValue never
    // set on QueryFailed) → no further Transition ever arrives on this quiet deployment →
    // `whenBaselineAdopted()` never resolves → the drain deadlocks. Post-fix: an `answered` flag set
    // on BOTH QueryUpdated and QueryFailed correctly reports nothing is still awaiting delivery, so
    // the baseline adopts immediately and the drain flushes.
    await waitFor(() => t.batches().length === 1, 3000);
    expect(t.batches()[0]!.entries.map((e) => e.seq)).toEqual([0]);

    t.emit({ type: "MutationResponse", requestId: t.batches()[0]!.entries[0]!.requestId, success: true, value: "srv-0", ts: 5 });
    await flushMicrotasks();
    expect((await real.loadAll()).entries).toHaveLength(0);
    client.close();
  });
});

/* -------------------------------------------------------------------------- */
/* The drop rule — no-flicker (collected frames)                                */
/* -------------------------------------------------------------------------- */

describe("StackbaseClient — the applied-drop is flicker-free (T3)", () => {
  it("dropping a cross-session applied layer never blinks the authoritative row away — the baseline already renders it", async () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox: memoryOutbox() });
    const cid = (await client.getOutboxIdentity())!.clientId;

    const frames: unknown[][] = [];
    client.subscribe("messages:list", {}, (v) => frames.push(v as unknown[]));

    // Base [] arrives.
    t.emit({ type: "Transition", startVersion: { querySet: 0, ts: 0 }, endVersion: { querySet: 1, ts: 1 }, modifications: [{ type: "QueryUpdated", queryId: 1, value: [] }] });

    // An optimistic mutation appends the row (its layer is live).
    void client.mutation(
      "messages:send",
      { body: "hello" },
      {
        optimisticUpdate: (store) => {
          const list = (store.getQuery("messages:list", {}) as unknown[] | undefined) ?? [];
          store.setQuery("messages:list", {}, [...list, { _id: "temp", body: "hello" }] as never);
        },
      },
    );
    // The committed row lands in the base (baseline already renders the effect); layer still live
    // → composed briefly duplicates.
    t.emit({
      type: "Transition",
      startVersion: { querySet: 1, ts: 1 },
      endVersion: { querySet: 1, ts: 2 },
      modifications: [{ type: "QueryUpdated", queryId: 1, value: [{ _id: "real", body: "hello" }] }],
    });

    // The applied verdict drops the layer (baseline adopted already — no reopen, gate open).
    t.emit({ type: "ConnectAck", known: true, results: [{ clientId: cid, seq: 0, verdict: "applied", commitTs: 2, value: "real" }], deploymentId: "d" });
    await flushMicrotasks();

    // Every frame from the optimistic apply onward contains a "hello" row — it NEVER disappears.
    const withRow = frames.slice(1);
    expect(withRow.length).toBeGreaterThan(0);
    for (const f of withRow) expect(f.some((r) => (r as { body?: string }).body === "hello")).toBe(true);
    // The final frame is the de-duplicated authoritative base (layer gone).
    expect(frames.at(-1)).toEqual([{ _id: "real", body: "hello" }]);
  });
});

/* -------------------------------------------------------------------------- */
/* onClientReset (known: false)                                                 */
/* -------------------------------------------------------------------------- */

describe("StackbaseClient — onClientReset on ConnectAck{known:false} (T3)", () => {
  it("re-mints the clientId, re-enqueues unsent under NEW seqs, rejects parked LOUDLY, and fires the callback", async () => {
    const outbox = memoryOutbox();
    const resets: ClientResetInfo[] = [];
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox, onClientReset: (i) => resets.push(i) });
    client.setOutboxArmed(true);
    const oldCid = (await client.getOutboxIdentity())!.clientId;

    // A parked entry (in-flight-at-disconnect) + an unsent entry (never hit the wire).
    const parkedP = client.mutation("messages:send", { body: "parked" });
    void parkedP.catch(() => {}); // attach a handler NOW — the rejection fires synchronously on emit
    await flushMicrotasks();
    t.emitClose(); // parks seq0
    const unsentP = enqueueUnsent(client, "unsent"); // seq1, unsent
    await flushMicrotasks();
    t.emitReopen();

    let unsentSettled = false;
    void unsentP.then(() => (unsentSettled = true), () => (unsentSettled = true));

    t.emit({ type: "ConnectAck", known: false, results: [], deploymentId: "dep-new" });
    await flushMicrotasks();

    // The parked promise rejected loudly with the coded reset error.
    await expect(parkedP).rejects.toBeInstanceOf(OfflineClientResetError);
    await expect(parkedP).rejects.toMatchObject({ code: "OFFLINE_CLIENT_RESET" });

    // The callback fired with the accounting.
    expect(resets).toHaveLength(1);
    expect(resets[0]!.oldClientId).toBe(oldCid);
    expect(resets[0]!.newClientId).not.toBe(oldCid);
    expect(resets[0]!.parkedRejected).toBe(1);
    expect(resets[0]!.unsentReEnqueued).toBe(1);

    // The clientId changed; the surviving unsent entry was re-keyed onto it under a fresh seq 0,
    // and its promise is NOT settled (safe to re-enqueue — never applied).
    const newCid = (await client.getOutboxIdentity())!.clientId; // still the constructor promise
    void newCid;
    const survivor = client.__pending.find((e) => e.args && (e.args as { body?: string }).body === "unsent")!;
    expect(survivor.clientId).toBe(resets[0]!.newClientId);
    expect(survivor.clientId).not.toBe(oldCid);
    expect(survivor.seq).toBe(0); // fresh seq under the new identity
    expect(unsentSettled).toBe(false);

    // The fresh meta row exists under the new clientId.
    expect(await outbox.getMeta(resets[0]!.newClientId)).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Real embedded-runtime loopback — the shipped handler speaks Connect/ConnectAck */
/* -------------------------------------------------------------------------- */

const MESSAGES = 20001;
const byNothing: IndexSpec = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "all",
  fields: ["body"],
  indexId: encodeStorageIndexId(MESSAGES, "all"),
};
const realModules: Record<string, RegisteredFunction> = {
  "messages:send": mutation<{ body: string }, string>({
    handler: (ctx, { body }) => ctx.db.insert("messages", { body }),
  }),
  "messages:list": query<Record<string, never>, unknown[]>({
    handler: (ctx) => ctx.db.query("messages", "all").collect(),
  }),
};

/** A reopen-capable wrapper over a real embedded loopback connection: synthetic close/reopen while
 *  the underlying server session stays alive, so the client's reopen sequence (SetAuth → resync →
 *  Connect) is driven against the real `SyncProtocolHandler`. */
function reopenableLoopback(conn: { send: (m: ClientMessage) => unknown; onMessage: (l: (m: ServerMessage) => void) => () => void; close: () => void }): {
  transport: ClientTransport;
  emitClose: () => void;
  emitReopen: () => void;
} {
  const closers = new Set<() => void>();
  const reopeners = new Set<() => void>();
  let down = false;
  const transport: ClientTransport = {
    send: (m) => {
      if (!down) void Promise.resolve(conn.send(m));
    },
    onMessage: (l) => conn.onMessage(l),
    onClose: (l) => {
      closers.add(l);
      return () => closers.delete(l);
    },
    onReopen: (l) => {
      reopeners.add(l);
      return () => reopeners.delete(l);
    },
    close: () => {
      for (const l of closers) l();
      conn.close();
    },
  };
  return {
    transport,
    emitClose: () => {
      down = true;
      for (const l of closers) l();
    },
    emitReopen: () => {
      down = false;
      for (const l of reopeners) l();
    },
  };
}

describe("StackbaseClient — Connect/ConnectAck against the REAL SyncProtocolHandler (T3)", () => {
  let runtime: EmbeddedRuntime;

  async function boot(): Promise<void> {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const catalog = new SimpleIndexCatalog().addIndex(byNothing);
    runtime = await createEmbeddedRuntime({ store, catalog, modules: realModules });
  }

  it("the real handler answers a client's Connect with a ConnectAck: the client arms + surfaces a non-empty deploymentId", async () => {
    await boot();
    const wrap = reopenableLoopback(runtime.connect("sess-arm"));
    const client = new StackbaseClient(wrap.transport, { outbox: memoryOutbox() });
    await client.getOutboxIdentity();

    // No held entries — a bare Connect still proves capability (known:true, empty results).
    wrap.emitReopen();
    await waitFor(() => client.__outboxArmed);
    expect(client.__outboxArmed).toBe(true);
    const dep = client.getOutboxDeploymentId();
    expect(typeof dep).toBe("string");
    expect((dep ?? "").length).toBeGreaterThan(0);
  });

  it("an unsent seq the server never saw classifies as a foreign timeline → known:false → onClientReset, end-to-end", async () => {
    await boot();
    const resets: ClientResetInfo[] = [];
    const wrap = reopenableLoopback(runtime.connect("sess-reset"));
    const client = new StackbaseClient(wrap.transport, { outbox: memoryOutbox(), onClientReset: (i) => resets.push(i) });
    const oldCid = (await client.getOutboxIdentity())!.clientId;

    // Enqueue while down → unsent, held, but the server has no record/floor for this clientId.
    wrap.emitClose();
    void client.mutation("messages:send", { body: "orphan" });
    await flushMicrotasks();

    wrap.emitReopen();
    await waitFor(() => resets.length > 0, 3000);
    expect(resets[0]!.oldClientId).toBe(oldCid);
    expect(resets[0]!.newClientId).not.toBe(oldCid);
    expect(resets[0]!.unsentReEnqueued).toBe(1);
    expect(client.__outboxArmed).toBe(true); // the ConnectAck (even known:false) proved capability
  });
});
