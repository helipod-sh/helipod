/**
 * T-crosstab (browser-ux spec Part A) — cross-tab LIVE optimistic rendering: another tab's pending
 * durable mutation renders as an optimistic row in THIS tab's subscribed queries, not just
 * `pendingMutations()` status, and drops flicker-free when the commit is observed. Extends the
 * hydrate-time machinery (`addHydratedEntry`, proven in `outbox-registry.test.ts`) with live
 * broadcast-driven callers.
 *
 * Two `StackbaseClient`s share one `IDBFactory` (fake-indexeddb) — a faithful two-tab model — and
 * communicate over the REAL Node `BroadcastChannel` global (Node >= 18), exactly as two real
 * browser tabs on the same origin would. `MockTransport` gives each client full control over its
 * own wire frames (no real server), per the `gated-ledger.test.ts` precedent.
 */
import { describe, it, expect, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  StackbaseClient,
  indexedDBOutbox,
  memoryOutbox,
  type OptimisticLocalStore,
  type OptimisticUpdate,
  type OptimisticUpdateFn,
} from "../src/index";
import type { ClientMessage, ServerMessage } from "@stackbase/sync";

/* -------------------------------------------------------------------------------------------- */
/* MockTransport (the gated-ledger.test.ts / outbox-registry.test.ts pattern)                     */
/* -------------------------------------------------------------------------------------------- */

class MockTransport {
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
  close(): void {}
  emit(m: ServerMessage): void {
    for (const l of this.msg) l(m);
  }
}

/** Same-origin channel name both clients probe by default (no `location` global in Node ->
 *  `originTag()` falls back to `"app"`; no `outboxDeployment` passed -> `"default"`). Opening a
 *  raw channel under this exact name lets a test simulate an out-of-band leader broadcast without
 *  reaching into client internals. */
const CHANNEL_NAME = "stackbase:outbox:app:default:pending";

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Appends `{_id, body, marker}` to `messages:list` — `marker` proves WHICH updater ran; the id is
 *  the deterministic placeholder (`store.placeholderId`), compared across tabs for test 1. */
function makeUpdater(marker: string): OptimisticUpdateFn {
  return (store: OptimisticLocalStore, args) => {
    const { body } = args as { body: string };
    const list = (store.getQuery("messages:list", {}) as Array<{ _id: string; body: string; marker: string }> | undefined) ?? [];
    store.setQuery("messages:list", {}, [...list, { _id: store.placeholderId("messages"), body, marker }]);
  };
}

/** Subscribes to `messages:list` and answers the subscription with an empty base — the composed
 *  view is then whatever optimistic layers replay on top. Returns the frame log. */
function baseSubscribe(t: MockTransport, client: StackbaseClient): unknown[][] {
  const frames: unknown[][] = [];
  client.subscribe("messages:list", {}, (v) => frames.push(v as unknown[]));
  t.emit({
    type: "Transition",
    startVersion: { querySet: 0, ts: 0 },
    endVersion: { querySet: 1, ts: 0 },
    modifications: [{ type: "QueryUpdated", queryId: 1, value: [] }],
  });
  return frames;
}

type Row = { _id: string; body: string; marker: string };
const rows = (frame: unknown): Row[] => frame as Row[];

describe("cross-tab live optimistic rendering (T-crosstab)", () => {
  it("1. tab A enqueues (durable) -> tab B renders the pending row, with EQUAL placeholder ids (deterministic seed replay)", async () => {
    const idb = new IDBFactory();
    const registryFn = makeUpdater("mine");

    const tA = new MockTransport();
    const clientA = new StackbaseClient(tA, { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: null, outboxDrainIntervalMs: 0 });
    const framesA = baseSubscribe(tA, clientA);

    const tB = new MockTransport();
    const clientB = new StackbaseClient(tB, {
      outbox: indexedDBOutbox({ indexedDB: idb }),
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      optimisticUpdates: { "messages:send": registryFn },
    });
    const framesB = baseSubscribe(tB, clientB);

    // A's own live render uses the call-site closure (the registry is never consulted for a live
    // call) — the SAME function as B's registry, so only the persisted `seed` can make the ids differ.
    void clientA.mutation("messages:send", { body: "hi" }, { optimisticUpdate: registryFn as unknown as OptimisticUpdate }).catch(() => {});

    await waitFor(() => rows(framesA.at(-1)).length === 1);
    await waitFor(() => rows(framesB.at(-1)).length === 1);

    const rowA = rows(framesA.at(-1))[0]!;
    const rowB = rows(framesB.at(-1))[0]!;
    expect(rowB.marker).toBe("mine");
    expect(rowB.body).toBe("hi");
    expect(rowB._id).toBe(rowA._id); // deterministic seed replay: identical placeholder ids

    clientA.close();
    clientB.close();
  });

  it("2. registry miss in B -> no layer, accessor status only, exactly one console.warn", async () => {
    const idb = new IDBFactory();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tA = new MockTransport();
      const clientA = new StackbaseClient(tA, { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: null, outboxDrainIntervalMs: 0 });
      baseSubscribe(tA, clientA);

      const tB = new MockTransport();
      const clientB = new StackbaseClient(tB, { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: null, outboxDrainIntervalMs: 0 }); // no registry
      const framesB = baseSubscribe(tB, clientB);

      void clientA.mutation("messages:send", { body: "hi" }).catch(() => {});
      // Wait for the actual side effect of B's broadcast-triggered `mirrorFromStore()` — merely
      // seeing the durable record (a direct, independent read of the SHARED store) proves nothing
      // about whether B's mirroring has run yet.
      await waitFor(() => warn.mock.calls.some((c) => String(c[0]).includes("no optimisticUpdates registered")));

      // No layer ever rendered — B's composed view stays at its empty base.
      expect(rows(framesB.at(-1))).toHaveLength(0);
      // The entry is still visible via the accessor (status-only), just never rendered.
      expect((await clientB.pendingMutations()).some((e) => e.udfPath === "messages:send")).toBe(true);

      const misses = warn.mock.calls.filter((c) => String(c[0]).includes("no optimisticUpdates registered"));
      expect(misses).toHaveLength(1);

      clientA.close();
      clientB.close();
    } finally {
      warn.mockRestore();
    }
  });

  it("3. leader-settle: B's layer becomes completed and drops ONLY when B's own feed observes commitTs (flicker-free)", async () => {
    const idb = new IDBFactory();
    const registryFn = makeUpdater("mine");

    const tA = new MockTransport();
    const clientA = new StackbaseClient(tA, { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: null, outboxDrainIntervalMs: 0 });
    baseSubscribe(tA, clientA);

    const tB = new MockTransport();
    const clientB = new StackbaseClient(tB, {
      outbox: indexedDBOutbox({ indexedDB: idb }),
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      optimisticUpdates: { "messages:send": registryFn },
    });
    const framesB = baseSubscribe(tB, clientB);

    void clientA.mutation("messages:send", { body: "hi" }).catch(() => {});
    await waitFor(() => rows(framesB.at(-1)).length === 1);

    const [entry] = await clientA.pendingMutations();
    const { clientId, seq } = entry!;

    const leader = new BroadcastChannel(CHANNEL_NAME);
    try {
      leader.postMessage({ kind: "settled", clientId, seq, commitTs: 42 });
      // Give the real BroadcastChannel a moment to dispatch, then prove the row is STILL rendered —
      // B has not yet observed a Transition covering ts=42.
      await new Promise((r) => setTimeout(r, 20));
      expect(rows(framesB.at(-1))).toHaveLength(1);

      // A Transition BELOW commitTs must not drop it either (the gate is `>=`, not "any transition").
      tB.emit({ type: "Transition", startVersion: { querySet: 1, ts: 0 }, endVersion: { querySet: 1, ts: 10 }, modifications: [] });
      expect(rows(framesB.at(-1))).toHaveLength(1);

      // A Transition covering commitTs drops it flicker-free.
      tB.emit({ type: "Transition", startVersion: { querySet: 1, ts: 10 }, endVersion: { querySet: 1, ts: 42 }, modifications: [] });
      expect(rows(framesB.at(-1))).toHaveLength(0);
    } finally {
      leader.close();
      clientA.close();
      clientB.close();
    }
  });

  it("4. a failed broadcast marks B's mirrored entry failed and fires onMutationFailed (dev-loud default, no live awaiter)", async () => {
    const idb = new IDBFactory();
    const registryFn = makeUpdater("mine");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const tA = new MockTransport();
      const clientA = new StackbaseClient(tA, { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: null, outboxDrainIntervalMs: 0 });
      baseSubscribe(tA, clientA);

      const tB = new MockTransport();
      const clientB = new StackbaseClient(tB, {
        outbox: indexedDBOutbox({ indexedDB: idb }),
        outboxLocks: null,
        outboxDrainIntervalMs: 0,
        optimisticUpdates: { "messages:send": registryFn },
      }); // no onMutationFailed handler registered -> the dev-loud console.error default
      const framesB = baseSubscribe(tB, clientB);

      void clientA.mutation("messages:send", { body: "hi" }).catch(() => {});
      await waitFor(() => rows(framesB.at(-1)).length === 1);

      const [entry] = await clientA.pendingMutations();
      const { clientId, seq } = entry!;

      const leader = new BroadcastChannel(CHANNEL_NAME);
      leader.postMessage({ kind: "failed", clientId, seq, code: "BOOM", message: "send rejected" });
      leader.close();

      await waitFor(() => rows(framesB.at(-1)).length === 0);

      const loud = errSpy.mock.calls.filter((c) => String(c[0]).includes("no onMutationFailed handler registered"));
      expect(loud).toHaveLength(1);
      expect(String(loud[0]![0])).toContain("BOOM");

      clientA.close();
      clientB.close();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("5. own-tab ignore: a settled broadcast naming an entry A initiated LIVE does not double-settle A", async () => {
    const idb = new IDBFactory();
    const registryFn = makeUpdater("mine");

    const tA = new MockTransport();
    const clientA = new StackbaseClient(tA, { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: null, outboxDrainIntervalMs: 0 });
    baseSubscribe(tA, clientA);

    // A's own live mutation — sent directly over the wire (inflight); never acked in this test, so
    // its promise is still pending and its reconciler entry is still "inflight".
    void clientA.mutation("messages:send", { body: "hi" }, { optimisticUpdate: registryFn as unknown as OptimisticUpdate }).catch(() => {});
    await waitFor(() => clientA.__pending.length === 1);
    const own = clientA.__pending[0]!;
    expect(own.status.type).toBe("inflight");

    await waitFor(async () => (await clientA.pendingMutations()).length === 1);
    const [entry] = await clientA.pendingMutations();
    const { clientId, seq } = entry!;

    // A positive synchronization point (finding 6): count A's unconditional accessor nudge, which
    // fires SYNCHRONOUSLY inside `onmessage` for every broadcast (before any typed dispatch) — a
    // real `BroadcastChannel` delivers same-channel messages in FIFO order, so once the SECOND
    // (sentinel) message's nudge has been observed, the FIRST message's (synchronous) handling —
    // including whatever `onCrossTabSettle` would have done to A's own entry — is GUARANTEED to have
    // already run to completion. This replaces a blind `setTimeout` negative-assertion window with
    // an actual round-trip proof.
    let nudges = 0;
    const unsubscribe = clientA.onOutboxChange(() => nudges++);

    const leader = new BroadcastChannel(CHANNEL_NAME);
    try {
      // A settled broadcast for A's OWN (clientId, seq) — must be ignored: A's own wire response
      // drives it, never a broadcast.
      leader.postMessage({ kind: "settled", clientId, seq, commitTs: 999 });
      leader.postMessage({ kind: "enqueued" }); // sentinel round-trip
      await waitFor(() => nudges >= 2);

      expect(clientA.__pending).toHaveLength(1);
      expect(clientA.__pending[0]!.status.type).toBe("inflight"); // untouched by the broadcast
    } finally {
      unsubscribe();
      leader.close();
      clientA.close();
    }
  });

  it("6. missed-settle backstop: an entry deleted from the store directly drops on the next enqueued re-read", async () => {
    const idb = new IDBFactory();
    const registryFn = makeUpdater("mine");

    const outboxA = indexedDBOutbox({ indexedDB: idb });
    const tA = new MockTransport();
    const clientA = new StackbaseClient(tA, { outbox: outboxA, outboxLocks: null, outboxDrainIntervalMs: 0 });
    baseSubscribe(tA, clientA);

    const tB = new MockTransport();
    const clientB = new StackbaseClient(tB, {
      outbox: indexedDBOutbox({ indexedDB: idb }),
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      optimisticUpdates: { "messages:send": registryFn },
    });
    const framesB = baseSubscribe(tB, clientB);

    void clientA.mutation("messages:send", { body: "hi" }).catch(() => {});
    await waitFor(() => rows(framesB.at(-1)).length === 1);

    const [entry] = await clientA.pendingMutations();
    const { clientId, seq } = entry!;

    // Simulate "a settle B never heard": the durable record is gone (as if the leader had already
    // dequeued it), but no targeted `settled`/`failed` broadcast ever reached B.
    await outboxA.dequeue(clientId, seq);

    const leader = new BroadcastChannel(CHANNEL_NAME);
    try {
      leader.postMessage({ kind: "enqueued" });
      await waitFor(() => rows(framesB.at(-1)).length === 0);
    } finally {
      leader.close();
      clientA.close();
      clientB.close();
    }
  });

  it("7. legacy compat: a bare `1` payload still nudges accessor listeners, mirrors nothing, throws nothing", async () => {
    const idb = new IDBFactory();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tB = new MockTransport();
      const clientB = new StackbaseClient(tB, { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: null, outboxDrainIntervalMs: 0 });
      const framesB = baseSubscribe(tB, clientB);
      const changeSpy = vi.fn();
      clientB.onOutboxChange(changeSpy);

      const legacy = new BroadcastChannel(CHANNEL_NAME);
      try {
        expect(() => legacy.postMessage(1)).not.toThrow();
        await waitFor(() => changeSpy.mock.calls.length > 0);
      } finally {
        legacy.close();
      }

      // Nothing mirrored, nothing thrown/logged as an error.
      expect(rows(framesB.at(-1))).toHaveLength(0);
      expect(errSpy).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();

      clientB.close();
    } finally {
      errSpy.mockRestore();
      warn.mockRestore();
    }
  });

  it("8. memory-outbox client: no shared store, no mirroring, unaffected by another tab's broadcasts", async () => {
    const idb = new IDBFactory();
    const registryFn = makeUpdater("mine");

    const tA = new MockTransport();
    const clientA = new StackbaseClient(tA, { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: null, outboxDrainIntervalMs: 0 });
    baseSubscribe(tA, clientA);

    // Shares the SAME broadcast channel name (default origin/deployment) but its OWN private,
    // non-shared `memoryOutbox()` — the durable-offline verdict's "non-durable clients share
    // nothing" rule.
    const tC = new MockTransport();
    const clientC = new StackbaseClient(tC, {
      outbox: memoryOutbox(),
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      optimisticUpdates: { "messages:send": registryFn },
    });
    const framesC = baseSubscribe(tC, clientC);

    void clientA.mutation("messages:send", { body: "hi" }).catch(() => {});
    await waitFor(async () => (await clientA.pendingMutations()).length === 1);
    // Give the broadcast (real BroadcastChannel + async loadAll) time to have done nothing.
    await new Promise((r) => setTimeout(r, 50));

    expect(rows(framesC.at(-1))).toHaveLength(0);
    expect(await clientC.pendingMutations()).toHaveLength(0);

    clientA.close();
    clientC.close();
  });

  /* ------------------------------------------------------------------------------------------
   * Task 1 review findings — the backstop must respect the gate, not the store.
   * ---------------------------------------------------------------------------------------- */

  it("9. [CRITICAL] the missed-settle backstop must NOT force-drop a COMPLETED-gated layer: the real drainSettleApplied ordering is settled -> dequeue -> enqueued", async () => {
    const idb = new IDBFactory();
    const registryFn = makeUpdater("mine");

    const outboxA = indexedDBOutbox({ indexedDB: idb });
    const tA = new MockTransport();
    const clientA = new StackbaseClient(tA, { outbox: outboxA, outboxLocks: null, outboxDrainIntervalMs: 0 });
    baseSubscribe(tA, clientA);

    const tB = new MockTransport();
    const clientB = new StackbaseClient(tB, {
      outbox: indexedDBOutbox({ indexedDB: idb }),
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      optimisticUpdates: { "messages:send": registryFn },
    });
    const framesB = baseSubscribe(tB, clientB);

    void clientA.mutation("messages:send", { body: "hi" }).catch(() => {});
    await waitFor(() => rows(framesB.at(-1)).length === 1);

    const [entry] = await clientA.pendingMutations();
    const { clientId, seq } = entry!;

    const leader = new BroadcastChannel(CHANNEL_NAME);
    try {
      // Step 1 (drainSettleApplied's first act, modulo resolvePending): the targeted `settled`
      // broadcast. B gates the layer `completed`, holding it until ITS OWN feed observes commitTs.
      leader.postMessage({ kind: "settled", clientId, seq, commitTs: 42 });
      await new Promise((r) => setTimeout(r, 20));
      expect(rows(framesB.at(-1))).toHaveLength(1); // still gated — no Transition covering 42 yet.

      // Step 2: the leader's OWN drainSettleApplied dequeues the durable record right after
      // broadcasting `settled` (`client.ts`'s `drainSettleApplied`).
      await outboxA.dequeue(clientId, seq);

      // Step 3: that dequeue's own write-behind `.then()` ALWAYS posts `{kind: "enqueued"}`
      // (`notifyOutboxChange`) moments later — B's backstop re-read sees the entry store-absent.
      leader.postMessage({ kind: "enqueued" });
      leader.postMessage({ kind: "enqueued" }); // sentinel round-trip — a real sync point, not a sleep guess
      await new Promise((r) => setTimeout(r, 30));

      // THE CRITICAL ASSERTION: the backstop must skip a `completed` layer — it is gate-owned, not
      // store-owned. Pre-fix this drops to 0 here (dropAfterBaseline'd before commitTs was observed).
      expect(rows(framesB.at(-1))).toHaveLength(1);

      // A Transition covering commitTs=42 is what actually drops it — flicker-free, exactly once.
      tB.emit({ type: "Transition", startVersion: { querySet: 1, ts: 0 }, endVersion: { querySet: 1, ts: 42 }, modifications: [] });
      expect(rows(framesB.at(-1))).toHaveLength(0);
    } finally {
      leader.close();
      clientA.close();
      clientB.close();
    }
  });

  it("10. own-tab regression: a foreign `enqueued` broadcast must not backstop-drop THIS tab's own post-ack gated layer", async () => {
    const idb = new IDBFactory();
    const registryFn = makeUpdater("mine");

    const tA = new MockTransport();
    const clientA = new StackbaseClient(tA, {
      outbox: indexedDBOutbox({ indexedDB: idb }),
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      optimisticUpdates: { "messages:send": registryFn },
    });
    const framesA = baseSubscribe(tA, clientA);

    // A's own LIVE mutation, direct-send (not through the drain) — acked by the mock server with a
    // ts, exactly like `gated-ledger.test.ts`'s "completed, not yet gated" fixtures.
    void clientA.mutation("messages:send", { body: "hi" }, { optimisticUpdate: registryFn as unknown as OptimisticUpdate }).catch(() => {});
    await waitFor(() => rows(framesA.at(-1)).length === 1);
    const sent = tA.sent.find((m) => m.type === "Mutation") as Extract<ClientMessage, { type: "Mutation" }>;
    tA.emit({ type: "MutationResponse", requestId: sent.requestId, success: true, value: "id", ts: 42 }); // ack -> completed, gated

    // The MutationResponse handler deletes `pendingMutationCallbacks` for this requestId immediately
    // on ack — this is EXACTLY the window (finding 2) where `isMirroredEntry` can no longer tell A's
    // own gated layer apart from a true cross-tab mirror.
    await waitFor(() => rows(framesA.at(-1)).length === 1); // still rendered — gated, not yet observed.

    // A foreign `enqueued` broadcast (as if some OTHER tab enqueued something unrelated) must not
    // touch A's own gated layer.
    const foreign = new BroadcastChannel(CHANNEL_NAME);
    try {
      foreign.postMessage({ kind: "enqueued" });
      foreign.postMessage({ kind: "enqueued" }); // sentinel round-trip
      await new Promise((r) => setTimeout(r, 30));

      expect(rows(framesA.at(-1))).toHaveLength(1); // survives — gate-owned, not store-owned.

      // Only A's own feed observing ts=42 drops it.
      tA.emit({ type: "Transition", startVersion: { querySet: 1, ts: 0 }, endVersion: { querySet: 1, ts: 42 }, modifications: [] });
      expect(rows(framesA.at(-1))).toHaveLength(0);
    } finally {
      foreign.close();
      clientA.close();
    }
  });

  it("11. a mirror whose backing record flipped to FAILED (a missed `failed` broadcast) is backstop-settled failed, not left as a permanent phantom row", async () => {
    const idb = new IDBFactory();
    const registryFn = makeUpdater("mine");

    const outboxA = indexedDBOutbox({ indexedDB: idb });
    const tA = new MockTransport();
    const clientA = new StackbaseClient(tA, { outbox: outboxA, outboxLocks: null, outboxDrainIntervalMs: 0 });
    baseSubscribe(tA, clientA);

    const failures: Array<{ clientId?: string; seq?: number; udfPath: string; error: { message: string; code?: string } }> = [];
    const tB = new MockTransport();
    const clientB = new StackbaseClient(tB, {
      outbox: indexedDBOutbox({ indexedDB: idb }),
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      optimisticUpdates: { "messages:send": registryFn },
      onMutationFailed: (info) => failures.push(info),
    });
    const framesB = baseSubscribe(tB, clientB);

    void clientA.mutation("messages:send", { body: "hi" }).catch(() => {});
    await waitFor(() => rows(framesB.at(-1)).length === 1);

    const [entry] = await clientA.pendingMutations();
    const { clientId, seq } = entry!;

    // Simulate a MISSED `failed` broadcast: the record itself flips to `failed` directly (R9 — never
    // dequeued on a terminal failure) with no targeted broadcast ever reaching B.
    await outboxA.updateStatus(clientId, seq, "failed", { message: "send rejected", code: "BOOM" });

    const leader = new BroadcastChannel(CHANNEL_NAME);
    try {
      leader.postMessage({ kind: "enqueued" }); // the only broadcast B ever gets for this record
      await waitFor(() => rows(framesB.at(-1)).length === 0);

      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ clientId, seq, udfPath: "messages:send", error: { message: "send rejected", code: "BOOM" } });
    } finally {
      leader.close();
      clientA.close();
      clientB.close();
    }
  });

  it("12. a mirrorFromStore rejection (fail-stopped outbox) routes to the console floor, never an unhandled promise rejection", async () => {
    const idb = new IDBFactory();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const outbox = indexedDBOutbox({ indexedDB: idb });
      const tB = new MockTransport();
      const clientB = new StackbaseClient(tB, { outbox, outboxLocks: null, outboxDrainIntervalMs: 0 });
      baseSubscribe(tB, clientB);
      // Let construction-time work (identity mint, the R9 resume scan) settle on the REAL outbox
      // before breaking it — this test targets `mirrorFromStore`'s rejection specifically, not those.
      await new Promise((r) => setTimeout(r, 20));

      const boom = new Error("disk gone");
      outbox.loadAll = () => Promise.reject(boom);

      const chan = new BroadcastChannel(CHANNEL_NAME);
      try {
        chan.postMessage({ kind: "enqueued" });
        await waitFor(() => errSpy.mock.calls.some((c) => String(c[0]).includes("durable outbox mirrorFromStore failed")));
      } finally {
        chan.close();
      }
      // Give a genuine unhandled rejection a real chance to surface before asserting its absence.
      await new Promise((r) => setTimeout(r, 30));

      expect(unhandled).toHaveLength(0);
      clientB.close();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      errSpy.mockRestore();
    }
  });
});
