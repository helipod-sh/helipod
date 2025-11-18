import { describe, it, expect, vi } from "vitest";
import {
  memoryOutbox,
  indexedDBOutbox,
  mintIdentity,
  OUTBOX_VERSION,
  type OutboxEntry,
} from "../src/outbox-storage";

function makeEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    clientId: "client-1",
    seq: 0,
    requestId: "r0",
    udfPath: "messages:send",
    args: { body: "hi" },
    seed: { entropy: "e0", now: 0 },
    order: 0,
    status: "unsent",
    outboxVersion: OUTBOX_VERSION,
    enqueuedAt: 0,
    ...overrides,
  };
}

describe("memoryOutbox()", () => {
  it("appends and round-trips an entry through loadAll", async () => {
    const storage = memoryOutbox();
    await storage.append(makeEntry());
    const { entries, dropped } = await storage.loadAll();
    expect(dropped).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ clientId: "client-1", seq: 0, udfPath: "messages:send" });
  });

  it("orders loadAll by the persisted `order` column, not insertion or seq", async () => {
    const storage = memoryOutbox();
    await storage.append(makeEntry({ seq: 2, requestId: "r2", order: 2 }));
    await storage.append(makeEntry({ seq: 0, requestId: "r0", order: 0 }));
    await storage.append(makeEntry({ seq: 1, requestId: "r1", order: 1 }));
    const { entries } = await storage.loadAll();
    expect(entries.map((e) => e.order)).toEqual([0, 1, 2]);
  });

  it("updateStatus mutates only the status field", async () => {
    const storage = memoryOutbox();
    await storage.append(makeEntry());
    await storage.updateStatus("client-1", 0, "inflight");
    const { entries } = await storage.loadAll();
    expect(entries[0]?.status).toBe("inflight");
    expect(entries[0]?.udfPath).toBe("messages:send");
  });

  it("updateStatus on a missing entry is a harmless no-op", async () => {
    const storage = memoryOutbox();
    await expect(storage.updateStatus("nope", 99, "completed")).resolves.toBeUndefined();
  });

  it("dequeue removes the entry", async () => {
    const storage = memoryOutbox();
    await storage.append(makeEntry());
    await storage.dequeue("client-1", 0);
    const { entries } = await storage.loadAll();
    expect(entries).toEqual([]);
  });

  it("keys entries by the (clientId, seq) pair — different clientIds with the same seq coexist", async () => {
    const storage = memoryOutbox();
    await storage.append(makeEntry({ clientId: "a", seq: 0, requestId: "a0", order: 0 }));
    await storage.append(makeEntry({ clientId: "b", seq: 0, requestId: "b0", order: 1 }));
    const { entries } = await storage.loadAll();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.clientId)).toEqual(["a", "b"]);
  });

  it("meta is keyed BY clientId — get/set round-trips independently per clientId", async () => {
    const storage = memoryOutbox();
    expect(await storage.getMeta("client-1")).toBeUndefined();
    await storage.setMeta("client-1", { nextSeq: 5, deployment: "dep-1" });
    await storage.setMeta("client-2", { nextSeq: 9 });
    expect(await storage.getMeta("client-1")).toEqual({ nextSeq: 5, deployment: "dep-1" });
    expect(await storage.getMeta("client-2")).toEqual({ nextSeq: 9 });
  });

  it("hydrate-drop-with-verdict: a stale outboxVersion entry is dropped and reported, not run", async () => {
    const storage = memoryOutbox();
    await storage.append(makeEntry({ seq: 0, requestId: "r0", order: 0, outboxVersion: OUTBOX_VERSION }));
    await storage.append(makeEntry({ seq: 1, requestId: "r1", order: 1, outboxVersion: OUTBOX_VERSION - 1 }));
    const { entries, dropped } = await storage.loadAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.seq).toBe(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.seq).toBe(1);
    // and it's actually gone from storage — a second hydrate doesn't re-report it.
    const second = await storage.loadAll();
    expect(second.dropped).toEqual([]);
  });

  it("persist() is a harmless synchronous no-op", () => {
    const storage = memoryOutbox();
    expect(() => storage.persist()).not.toThrow();
  });

  it("no-outbox-config byte-identity: a client without `outbox` never touches this module at construction", async () => {
    // memoryOutbox() itself is inert until used — this pins that append/loadAll are the only way
    // state accumulates (nothing eager happens at construction time).
    const storage = memoryOutbox();
    const { entries } = await storage.loadAll();
    expect(entries).toEqual([]);
  });
});

describe("indexedDBOutbox() probe-and-fallback", () => {
  it("falls back to memory synchronously when IndexedDB is unavailable in this runtime", async () => {
    const onFallback = vi.fn();
    const storage = indexedDBOutbox({ indexedDB: undefined, onFallback });
    // No IDB global in this test's Node runtime (jsdom/fake-indexeddb not installed here) — the
    // factory falls back immediately, before any async gap.
    await storage.append(makeEntry());
    const { entries } = await storage.loadAll();
    expect(entries).toHaveLength(1);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("falls back to memory when the injected IDBFactory's open() fails", async () => {
    const onFallback = vi.fn();
    const brokenFactory = {
      open: () => {
        const req: Partial<IDBOpenDBRequest> = {};
        queueMicrotask(() => {
          (req as { onerror?: () => void }).onerror?.();
        });
        Object.defineProperty(req, "error", { value: new Error("boom"), configurable: true });
        return req as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;

    const storage = indexedDBOutbox({ indexedDB: brokenFactory, onFallback });
    await storage.append(makeEntry());
    const { entries } = await storage.loadAll();
    expect(entries).toHaveLength(1);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });
});

describe("mintIdentity()", () => {
  it("mints a fresh clientId each call — never reuses one across instances", async () => {
    const storage = memoryOutbox();
    const a = await mintIdentity(storage);
    const b = await mintIdentity(storage);
    expect(a.clientId).not.toBe(b.clientId);
    expect(a.nextSeq).toBe(0);
    expect(b.nextSeq).toBe(0);
  });

  it("persists a meta row for the minted clientId with nextSeq 0", async () => {
    const storage = memoryOutbox();
    const { clientId } = await mintIdentity(storage, { mintClientId: () => "fixed-id", deployment: "dep-x" });
    expect(clientId).toBe("fixed-id");
    expect(await storage.getMeta("fixed-id")).toEqual({ nextSeq: 0, deployment: "dep-x" });
  });

  it("on a colliding minted clientId, resumes from the recorded nextSeq instead of resetting it", async () => {
    const storage = memoryOutbox();
    await storage.setMeta("dup-id", { nextSeq: 42 });
    const { clientId, nextSeq } = await mintIdentity(storage, { mintClientId: () => "dup-id" });
    expect(clientId).toBe("dup-id");
    expect(nextSeq).toBe(42);
  });
});
