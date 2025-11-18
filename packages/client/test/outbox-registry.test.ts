/**
 * T5 — the `optimisticUpdates` registry (verdict §(d) "Reload and rendering", spec §(k)6): a live
 * call-site closure ALWAYS wins for a live `mutation()` call (the registry is never even consulted);
 * the registry is consulted ONLY when a durable cross-reload entry is hydrated, via the SAME
 * `LayeredQueryStore.recompose` pipeline every other optimistic layer goes through (`entry.update`
 * is populated BEFORE `reconciler.addHydrated` runs — see `client.ts#addHydratedEntry`); a registry
 * MISS warns once per udfPath (not once per entry) and the entry still drains fine, only its
 * rendering is skipped.
 */
import { describe, it, expect, vi } from "vitest";
import type { Value } from "@stackbase/values";
import {
  StackbaseClient,
  memoryOutbox,
  OUTBOX_VERSION,
  type OptimisticLocalStore,
  type OptimisticUpdate,
  type OptimisticUpdateFn,
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
}

async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Seed a durable outbox as if a PRIOR tab-session left it behind — the `seed`/`args` a fresh client
 *  hydrates and (if registered) replays through a registered updater. */
async function seedOutbox(storage: OutboxStorage, clientId: string, seq: number, order: number, body: string): Promise<void> {
  const entry: OutboxEntry = {
    clientId,
    seq,
    requestId: `old-${seq}`,
    udfPath: "messages:send",
    args: { body },
    seed: { entropy: `fixed-e-${seq}`, now: 1000 + seq },
    order,
    status: "unsent",
    outboxVersion: OUTBOX_VERSION,
    enqueuedAt: 1000 + seq,
  };
  await storage.append(entry);
}

/** Appends a `{marker, body}` row tagged with `marker` — used to prove WHICH updater ran (the live
 *  call-site closure or the registry's) without any other observable difference between them. */
function makeUpdater(marker: string): OptimisticUpdateFn {
  return (store: OptimisticLocalStore, args: Value) => {
    const { body } = args as { body: string };
    const list = (store.getQuery("messages:list", {}) as Array<{ _id: string; body: string; marker: string }> | undefined) ?? [];
    store.setQuery("messages:list", {}, [...list, { _id: store.placeholderId("messages"), body, marker }]);
  };
}

describe("optimisticUpdates registry — precedence (T5)", () => {
  it("a live call-site closure wins; the registry is NEVER consulted for a live mutation()", () => {
    const t = new MockTransport();
    const registryFn = vi.fn(makeUpdater("registry"));
    const liveFn = makeUpdater("live");
    const client = new StackbaseClient(t, { optimisticUpdates: { "messages:send": registryFn } });

    const seen: unknown[] = [];
    client.subscribe("messages:list", {}, (v) => seen.push(v));
    // The client's own untyped string-path overload expects the internal `OptimisticUpdate` shape
    // (`OptimisticStoreView`-based); `useMutation(...).withOptimisticUpdate` casts identically
    // (`react.tsx#createMutationCallback`) — same bridge, same cast, here for the raw client API.
    void client.mutation("messages:send", { body: "hi" }, { optimisticUpdate: liveFn as unknown as OptimisticUpdate });

    expect(registryFn).not.toHaveBeenCalled();
    const last = seen.at(-1) as Array<{ marker: string; body: string }>;
    expect(last.map((r) => ({ marker: r.marker, body: r.body }))).toEqual([{ marker: "live", body: "hi" }]);
  });

  it("a registered udfPath with NO live optimisticUpdate stays layerless for a live call (the registry doesn't retroactively apply)", () => {
    const t = new MockTransport();
    const registryFn = vi.fn(makeUpdater("registry"));
    const client = new StackbaseClient(t, { optimisticUpdates: { "messages:send": registryFn } });

    const seen: unknown[] = [];
    client.subscribe("messages:list", {}, (v) => seen.push(v));
    void client.mutation("messages:send", { body: "hi" }); // no { optimisticUpdate }

    expect(registryFn).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0); // nothing ever wrote to "messages:list" — no layer at all
  });
});

describe("optimisticUpdates registry — hydrate-only consultation (T5)", () => {
  it("a hydrated cross-reload entry rebuilds its layer via the NORMAL recompose (a registry hit)", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old-client", 0, 0, "hi");
    const t = new MockTransport();
    const registryFn = makeUpdater("registry");
    const client = new StackbaseClient(t, {
      outbox,
      outboxLocks: null,
      outboxDrainIntervalMs: 0,
      optimisticUpdates: { "messages:send": registryFn },
    });

    const seen: unknown[] = [];
    client.subscribe("messages:list", {}, (v) => seen.push(v));
    await tick();

    const last = seen.at(-1) as Array<{ marker: string; body: string }> | undefined;
    expect(last?.map((r) => ({ marker: r.marker, body: r.body }))).toEqual([{ marker: "registry", body: "hi" }]);
  });

  it("the SAME persisted seed mints IDENTICAL placeholders across two client instances (a simulated reload)", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old-client", 0, 0, "hi");
    const registryFn = makeUpdater("registry");

    const t1 = new MockTransport();
    const client1 = new StackbaseClient(t1, { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, optimisticUpdates: { "messages:send": registryFn } });
    const seen1: unknown[] = [];
    client1.subscribe("messages:list", {}, (v) => seen1.push(v));
    await tick();
    const placeholder1 = (seen1.at(-1) as Array<{ _id: string }>)[0]!._id;

    // "reload": a FRESH client instance over the SAME durable storage — the seeded entry was never
    // drained/acked (no ConnectAck ever went out), so it's still there, under its ORIGINAL seed.
    const t2 = new MockTransport();
    const client2 = new StackbaseClient(t2, { outbox, outboxLocks: null, outboxDrainIntervalMs: 0, optimisticUpdates: { "messages:send": registryFn } });
    const seen2: unknown[] = [];
    client2.subscribe("messages:list", {}, (v) => seen2.push(v));
    await tick();
    const placeholder2 = (seen2.at(-1) as Array<{ _id: string }>)[0]!._id;

    expect(placeholder2).toBe(placeholder1);
    expect(placeholder1).toBe("fixed-e-0:messages:0"); // createOptimisticLocalStore's format, pinned
  });

  it("a hydrate-time registry MISS warns exactly ONCE per udfPath, not once per entry — the entry still drains fine", async () => {
    const outbox = memoryOutbox();
    await seedOutbox(outbox, "old-client", 0, 0, "a");
    await seedOutbox(outbox, "old-client", 1, 1, "b");
    await seedOutbox(outbox, "old-client", 2, 2, "c");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new MockTransport();
    const client = new StackbaseClient(t, { outbox, outboxLocks: null, outboxDrainIntervalMs: 0 }); // no registry at all
    await tick();

    const misses = warn.mock.calls.filter((c) => String(c[0]).includes("no optimisticUpdates registered"));
    expect(misses).toHaveLength(1);
    expect(String(misses[0]![0])).toContain('"messages:send"');
    // The entry still drains fine — all three hydrated into the log, none dropped.
    expect(client.__pending).toHaveLength(3);
    warn.mockRestore();
  });

  it("a registry miss on udfPath A does not suppress the warning for a DIFFERENT unregistered udfPath B", async () => {
    const outbox = memoryOutbox();
    const entryA: OutboxEntry = {
      clientId: "c",
      seq: 0,
      requestId: "r0",
      udfPath: "messages:send",
      args: { body: "a" },
      seed: { entropy: "eA", now: 1 },
      order: 0,
      status: "unsent",
      outboxVersion: OUTBOX_VERSION,
      enqueuedAt: 1,
    };
    const entryB: OutboxEntry = { ...entryA, seq: 1, requestId: "r1", udfPath: "notes:add", seed: { entropy: "eB", now: 2 }, order: 1, enqueuedAt: 2 };
    await outbox.append(entryA);
    await outbox.append(entryB);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new MockTransport();
    new StackbaseClient(t, { outbox, outboxLocks: null, outboxDrainIntervalMs: 0 });
    await tick();

    const misses = warn.mock.calls.filter((c) => String(c[0]).includes("no optimisticUpdates registered"));
    expect(misses).toHaveLength(2);
    warn.mockRestore();
  });
});
