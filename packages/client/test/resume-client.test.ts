/**
 * Task 2 — the CLIENT half of subscription resume (design 2026-07-11): `Subscription.lastHash`
 * storage/clearing, `resync()`'s conditional `resultHash` echo, and `QueryUnchanged` ingest
 * (`markUnchanged` + `LayeredQueryStore.recompose`'s `forceNotify`).
 *
 * ---------------------------------------------------------------------------------------------
 * STEP 1 FINDING (mandatory-first, per the brief) — today's identical-value `QueryUpdated`
 * semantics:
 *
 * Reading `layered-store.ts`'s `setServerValue` + `recompose`, and `reconcile.ts`'s
 * `ingestTransition`:
 *
 *   - `setServerValue` UNCONDITIONALLY overwrites `sub.serverValue = value` — there is no
 *     content/deep-equality check anywhere in the ingest path.
 *   - `ingestTransition`'s `QueryUpdated` branch calls `jsonToConvex(mod.value)`, which for any
 *     object/array-shaped result (the common case) constructs a BRAND-NEW object on every single
 *     decode — even when the JSON bytes are byte-for-byte identical to the previous message.
 *   - `recompose`'s listener-firing loop compares `next !== sub.composedValue` by REFERENCE
 *     ("Change detection is by reference inequality, exactly as convex-js does." — the file's own
 *     header comment). Since `next` (= the freshly-decoded `serverValue`, absent any optimistic
 *     overlay) is a NEW reference every time, this comparison is TRUE on every `QueryUpdated` — it
 *     ALWAYS fires listeners, whether or not the content actually changed.
 *
 * CONCLUSION: today, a `QueryUpdated` whose value is deeply/content-equal to the current
 * `serverValue` STILL notifies listeners (recomputes `composedValue` to the new reference, calls
 * every `onUpdate`) — there is no dedup by content anywhere in this store. (The one exception is a
 * top-level JS *primitive* result — e.g. a bare number/string/boolean query — where two decodes of
 * the same primitive literal DO compare `===`; but the store doesn't special-case that either, it's
 * just incidental to how `!==` behaves on primitives. Object/array results, the common shape, always
 * mint a fresh reference.)
 *
 * MATCHING RULE for `QueryUnchanged`: because it carries no value on the wire, there is nothing to
 * swap in for a new reference — `serverValue`/`composedValue` are retained exactly as they were
 * (see `markUnchanged`'s doc). To introduce "no new observable difference for app code" (spec), the
 * listener-firing side must still behave like the always-fires case above: `recompose` gained a
 * `forceNotify` parameter (a set of subscription `hash`es) that fires listeners even when the
 * composed reference did NOT change. `reconcile.ts#ingestTransition` collects the `hash`es of every
 * `QueryUnchanged`-answered sub this pass and forwards them into `rebuild`/`recompose`. Test 3 below
 * pins this down directly: a `QueryUnchanged` fires the listener again with the (unchanged)
 * composed value, exactly as a content-identical `QueryUpdated` would.
 * ---------------------------------------------------------------------------------------------
 */
import { describe, it, expect } from "vitest";
import { LayeredQueryStore, queryHash, type OptimisticStoreView } from "../src/layered-store";
import { Reconciler } from "../src/reconcile";
import type { PendingMutation } from "../src/mutation-log";
import { StackbaseClient, memoryOutbox, OUTBOX_VERSION, type ClientTransport } from "../src/index";
import type { OutboxEntry, OutboxStorage } from "../src/outbox-storage";
import type { ClientMessage, ServerMessage } from "@stackbase/sync";

/* -------------------------------------------------------------------------- */
/* MockTransport — the outbox-handshake.test.ts / reconnect.test.ts pattern     */
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
  batches(): Array<Extract<ClientMessage, { type: "MutationBatch" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "MutationBatch" }> => m.type === "MutationBatch");
  }
  modifyQuerySets(): Array<Extract<ClientMessage, { type: "ModifyQuerySet" }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "ModifyQuerySet" }> => m.type === "ModifyQuerySet");
  }
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A `PendingMutation` stand-in with a real optimistic `update` closure (mirrors
 *  `optimistic-store.test.ts`'s `makeEntry`). */
function makeEntry(requestId: string, update: PendingMutation["update"]): PendingMutation {
  return {
    requestId,
    udfPath: "messages:send",
    args: null,
    update,
    seed: { entropy: "e", now: 0 },
    touched: new Set(),
    status: { type: "unsent" },
  };
}

/* -------------------------------------------------------------------------- */
/* Test 1 — lastHash storage/clearing                                          */
/* -------------------------------------------------------------------------- */

describe("Subscription.lastHash — stored/cleared from QueryUpdated.hash", () => {
  it("a hash-bearing QueryUpdated stores it verbatim; a hash-less one (old-server shape) clears it", () => {
    const store = new LayeredQueryStore();
    const reconciler = new Reconciler(store);
    const hash = queryHash("messages:list", {});
    const sub = store.create(1, "messages:list", {}, hash);

    reconciler.ingestTransition([{ type: "QueryUpdated", queryId: 1, value: ["a"], hash: "sha256:aaa" }], 1);
    expect(sub.lastHash).toBe("sha256:aaa");

    // A second, freshly-hashed QueryUpdated replaces it (not accumulated/merged).
    reconciler.ingestTransition([{ type: "QueryUpdated", queryId: 1, value: ["b"], hash: "sha256:bbb" }], 2);
    expect(sub.lastHash).toBe("sha256:bbb");

    // A hash-less QueryUpdated (old server, or a hand-constructed wire-compat message) clears it —
    // an old-server session must never echo a stale hash on a future resync.
    reconciler.ingestTransition([{ type: "QueryUpdated", queryId: 1, value: ["c"] }], 3);
    expect(sub.lastHash).toBeUndefined();
  });

  it("STEP 1 GROUND TRUTH: a content-identical QueryUpdated still fires listeners today (reference inequality, no content dedup)", () => {
    const store = new LayeredQueryStore();
    const reconciler = new Reconciler(store);
    const hash = queryHash("messages:list", {});
    const sub = store.create(1, "messages:list", {}, hash);
    const frames: unknown[] = [];
    sub.listeners.add({ onUpdate: (v) => frames.push(v) });

    reconciler.ingestTransition([{ type: "QueryUpdated", queryId: 1, value: [{ body: "same" }], hash: "sha256:aaa" }], 1);
    expect(frames).toHaveLength(1);
    const firstRef = sub.serverValue;

    // Same JSON content, re-sent (as a real server would on an unrelated re-run producing the
    // identical row set) — a NEW object reference every decode, per the finding above.
    reconciler.ingestTransition([{ type: "QueryUpdated", queryId: 1, value: [{ body: "same" }], hash: "sha256:aaa" }], 2);
    expect(frames).toHaveLength(2); // fired again, despite identical content
    expect(sub.serverValue).not.toBe(firstRef); // a fresh reference, not the same object
    expect(sub.serverValue).toEqual(firstRef); // but deep-equal
  });
});

/* -------------------------------------------------------------------------- */
/* Test 2 — resync()'s conditional resultHash echo                             */
/* -------------------------------------------------------------------------- */

describe("StackbaseClient — resync() echoes resultHash only for answered+defined+hashed subs", () => {
  it("an answered sub with a stored hash echoes it; a failed sub and a never-answered sub echo nothing", () => {
    const t = new MockTransport();
    const client = new StackbaseClient(t);

    client.subscribe("messages:a", {}, () => {}); // queryId 1 — will be answered with a hash
    client.subscribe("messages:b", {}, () => {}, () => {}); // queryId 2 — will FAIL
    client.subscribe("messages:c", {}, () => {}); // queryId 3 — never answered

    t.emit({
      type: "Transition",
      startVersion: { querySet: 0, ts: 0 },
      endVersion: { querySet: 1, ts: 1 },
      modifications: [
        { type: "QueryUpdated", queryId: 1, value: ["x"], hash: "sha256:aaa" },
        { type: "QueryFailed", queryId: 2, error: "boom" },
      ],
    });

    // A version-bracket gap forces `resync()` (`onServerMessage`'s guard: `!versionsEqual(...)`),
    // the exact mechanism `gated-ledger.test.ts`'s "resync-with-pending-layers" test uses — no need
    // for a full transport close/reopen dance to exercise `resync()`'s echo logic in isolation.
    t.emit({ type: "Transition", startVersion: { querySet: 99, ts: 99 }, endVersion: { querySet: 99, ts: 99 }, modifications: [] });

    const resyncMsg = t.modifyQuerySets().at(-1)!;
    const byPath = new Map(resyncMsg.add.map((e) => [e.udfPath, e]));
    expect(byPath.get("messages:a")?.resultHash).toBe("sha256:aaa");
    expect(byPath.get("messages:b")?.resultHash).toBeUndefined(); // failed — no serverValue, nothing to echo
    expect(byPath.get("messages:c")?.resultHash).toBeUndefined(); // never answered — nothing to echo
  });
});

/* -------------------------------------------------------------------------- */
/* Test 3 — QueryUnchanged ingest                                              */
/* -------------------------------------------------------------------------- */

describe("Reconciler#ingestTransition — QueryUnchanged counts as a full delivery", () => {
  it("sets answered=true, retains serverValue (SAME reference) + lastHash, and fires listeners matching the Step-1 always-fires finding", () => {
    const store = new LayeredQueryStore();
    const reconciler = new Reconciler(store);
    const hash = queryHash("messages:list", {});
    const sub = store.create(1, "messages:list", {}, hash);
    const frames: unknown[] = [];
    sub.listeners.add({ onUpdate: (v) => frames.push(v) });

    reconciler.ingestTransition([{ type: "QueryUpdated", queryId: 1, value: [{ body: "seed" }], hash: "sha256:aaa" }], 1);
    expect(frames).toHaveLength(1);
    expect(sub.answered).toBe(true);
    const baseRef = sub.serverValue;

    reconciler.ingestTransition([{ type: "QueryUnchanged", queryId: 1 }], 2);

    expect(sub.answered).toBe(true); // still (already-)answered
    expect(sub.serverValue).toBe(baseRef); // the EXACT same reference — nothing to overwrite it with
    expect(sub.lastHash).toBe("sha256:aaa"); // retained, not cleared
    expect(frames).toHaveLength(2); // fired again — matches "today always fires" (Step 1)
    expect(frames[1]).toBe(baseRef); // fired with the (unchanged) composed value
  });

  it("a stray QueryUnchanged for an untracked queryId is ignored, exactly like a stray QueryUpdated today", () => {
    const store = new LayeredQueryStore();
    const reconciler = new Reconciler(store);
    // No subscription created at all — this must not throw or otherwise misbehave.
    expect(() => reconciler.ingestTransition([{ type: "QueryUnchanged", queryId: 999 }], 1)).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Test 4 — optimistic layers over an unchanged base still compose             */
/* -------------------------------------------------------------------------- */

describe("Reconciler — optimistic layers over a QueryUnchanged-resumed base", () => {
  it("an inflight mutation's layer is visible BEFORE and AFTER a QueryUnchanged resume", () => {
    const store = new LayeredQueryStore();
    const reconciler = new Reconciler(store);
    const hash = queryHash("messages:list", {});
    const sub = store.create(1, "messages:list", {}, hash);
    const frames: unknown[] = [];
    sub.listeners.add({ onUpdate: (v) => frames.push(v) });

    reconciler.ingestTransition([{ type: "QueryUpdated", queryId: 1, value: [{ body: "seed" }], hash: "sha256:aaa" }], 1);

    const appendOpt = (view: OptimisticStoreView): void => {
      const list = view.getQuery("messages:list", {}) as Array<{ body: string }> | undefined;
      view.setQuery("messages:list", {}, [...(list ?? []), { body: "opt" }]);
    };
    reconciler.initiate(makeEntry("r1", appendOpt));

    expect(frames.at(-1)).toEqual([{ body: "seed" }, { body: "opt" }]); // BEFORE: layer composes

    reconciler.ingestTransition([{ type: "QueryUnchanged", queryId: 1 }], 2);

    expect(frames.at(-1)).toEqual([{ body: "seed" }, { body: "opt" }]); // AFTER: layer still composes
    expect(reconciler.entries()).toHaveLength(1); // the entry itself is untouched by the resume
  });
});

/* -------------------------------------------------------------------------- */
/* Test 5 — RED-FIRST: the drain-gate composition regression                   */
/* -------------------------------------------------------------------------- */

describe("StackbaseClient — QueryUnchanged vs. the first-connect drain gate (Task 2 regression)", () => {
  /** Wraps a real `OutboxStorage` so `loadAll` (the drain's hydrate) hangs until released —
   *  simulates a slow IndexedDB open / a hydrate that hasn't resolved yet on a fresh page load.
   *  (Identical to `outbox-handshake.test.ts`'s helper of the same name.) */
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

  it("a subscription answered with QueryUnchanged (not QueryUpdated/QueryFailed) BEFORE hydrate completes does not starve whenBaselineAdopted() forever", async () => {
    // This is the SAME shape as outbox-handshake.test.ts's two "T4 bug fix" / "re-review FIX 2"
    // tests (QueryUpdated and QueryFailed pre-arm answers respectively), with the pre-arm answer
    // now QueryUnchanged. RED-FIRST (run against the pre-Task-2 client): `ingestTransition`'s
    // modification switch had no `case "QueryUnchanged"` at all, so it fell through to the
    // unhandled default — `sub.answered` never flips to `true`. `hasUndeliveredSubscription()`
    // (the drain's `ensureInitialHandshake` gate) then reports "still undelivered" forever, so
    // `expectTransition=true`, `beginBaselineAwait` arms an await for a Transition that will NEVER
    // arrive on this quiet deployment, and the drain deadlocks (armed=true, drained=false, forever)
    // — the exact starvation shape the client-ids slice fixed for QueryFailed. GREEN
    // post-implementation: `markUnchanged` sets `answered = true` the same way `setServerValue`/
    // `markAnswered` do, so `hasUndeliveredSubscription()` correctly sees nothing outstanding, the
    // baseline adopts immediately, and the drain proceeds.
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

    // Natural app-code ordering: subscribe immediately on construction, well before the drain's
    // queued `becomeLeader` microtask even runs. The server resumes this subscription as
    // UNCHANGED while hydrate is still pending.
    client.subscribe("messages:list", {}, () => {});
    t.emit({ type: "Transition", startVersion: { querySet: 0, ts: 0 }, endVersion: { querySet: 1, ts: 1 }, modifications: [{ type: "QueryUnchanged", queryId: 1 }] });
    await flushMicrotasks();

    // Now let hydrate complete — the drain becomes leader for real and, seeing a durable backlog,
    // fires the first-connect handshake.
    releaseLoad();
    await waitFor(() => t.connects().length === 1, 3000);
    t.emit({ type: "ConnectAck", known: true, results: [{ clientId: "old-tab", seq: 0, verdict: "unknown" }], deploymentId: "dep-1" });
    await waitFor(() => client.__outboxArmed, 3000);

    // Bounded waitFor: pre-fix this never resolves (timeout -> visibly RED); post-fix the drain
    // flushes the seeded backlog promptly.
    await waitFor(() => t.batches().length === 1, 3000);
    expect(t.batches()[0]!.entries.map((e) => e.seq)).toEqual([0]);

    t.emit({ type: "MutationResponse", requestId: t.batches()[0]!.entries[0]!.requestId, success: true, value: "srv-0", ts: 5 });
    await flushMicrotasks();
    expect((await real.loadAll()).entries).toHaveLength(0);
    client.close();
  });
});
