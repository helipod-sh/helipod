import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDBOutboxStorage,
  OUTBOX_DB_NAME,
  openIndexedDBOutbox,
} from "../src/outbox-idb";
import { indexedDBOutbox } from "../src/outbox-storage";
import { runOutboxStorageContract, makeEntry } from "./outbox-contract";

// A fresh `IDBFactory` per test — genuine isolation, no shared global state and no need to
// delete-database between tests.
let idb: IDBFactory;

beforeEach(() => {
  idb = new IDBFactory();
});

runOutboxStorageContract("indexedDBOutbox (fake-indexeddb)", async () => {
  const factory = new IDBFactory(); // per this file's existing fake-indexeddb import style
  return { storage: indexedDBOutbox({ indexedDB: factory }) };
});

describe("IndexedDBOutboxStorage — schema", () => {
  it("opens ONE database named stackbase-outbox with both `entries` and `meta` stores (hazard 1: co-eviction is structural)", async () => {
    expect(OUTBOX_DB_NAME).toBe("stackbase-outbox");
    await openIndexedDBOutbox(idb, OUTBOX_DB_NAME);
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(OUTBOX_DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(Array.from(raw.objectStoreNames).sort()).toEqual(["entries", "meta"]);
    raw.close();
  });

  it("entries is keyed by the compound [clientId, seq] pair with order and status indexes", async () => {
    await openIndexedDBOutbox(idb, OUTBOX_DB_NAME);
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(OUTBOX_DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = raw.transaction("entries", "readonly");
    const store = tx.objectStore("entries");
    expect(store.keyPath).toEqual(["clientId", "seq"]);
    expect(Array.from(store.indexNames).sort()).toEqual(["order", "status"]);
    raw.close();
  });

  it("meta is keyed by clientId directly (no compound key)", async () => {
    await openIndexedDBOutbox(idb, OUTBOX_DB_NAME);
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(OUTBOX_DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const store = raw.transaction("meta", "readonly").objectStore("meta");
    expect(store.keyPath).toBe("clientId");
    raw.close();
  });
});

describe("IndexedDBOutboxStorage — durability across reopen (not covered by the shared contract, which never reopens a backend)", () => {
  it("dequeue removes the entry durably — survives a fresh open() against the same IDBFactory", async () => {
    const storage = await openIndexedDBOutbox(idb);
    await storage.append(makeEntry());
    await storage.dequeue("c1", 0);
    expect((await storage.loadAll()).entries).toEqual([]);
    // Re-open the database from scratch to prove it's durable, not just evicted from an in-memory cache.
    const reopened = await openIndexedDBOutbox(idb);
    expect((await reopened.loadAll()).entries).toEqual([]);
  });

  it("survives a fresh open() against the same IDBFactory — genuine durability, not process memory", async () => {
    const first = await openIndexedDBOutbox(idb);
    await first.append(makeEntry());
    await first.setMeta("c1", { nextSeq: 3 });

    const second = await openIndexedDBOutbox(idb);
    expect((await second.loadAll()).entries).toHaveLength(1);
    expect(await second.getMeta("c1")).toEqual({ nextSeq: 3 });
  });

  it("close() flushes a still-pending write-behind batch before closing — a batched op is never lost (the binding constraint)", async () => {
    const dbName = "close-flush-check";
    const first = await openIndexedDBOutbox(idb, dbName);
    // Deliberately NOT awaited: the write-behind flush is scheduled on a microtask, so at the
    // moment close() is called the append is still sitting in the in-memory queue, unflushed.
    void first.append(makeEntry());
    await first.close();
    // A second close() must also be safe — IndexedDBOutboxStorage documents close() as
    // idempotent-safe (flush() no-ops on an empty queue, and closing an already-closed
    // IDBDatabase connection is a spec-legal no-op).
    await first.close();

    const reopened = await openIndexedDBOutbox(idb, dbName);
    expect((await reopened.loadAll()).entries).toHaveLength(1);
  });
});

describe("IndexedDBOutboxStorage — write-behind batching", () => {
  it("N synchronous appends in one microtask turn flush through exactly one transaction", async () => {
    const storage = await openIndexedDBOutbox(idb);
    expect(storage).toBeInstanceOf(IndexedDBOutboxStorage);
    const before = storage.txnCount;

    const writes = Promise.all([
      storage.append(makeEntry({ seq: 0, requestId: "r0", order: 0 })),
      storage.append(makeEntry({ seq: 1, requestId: "r1", order: 1 })),
      storage.append(makeEntry({ seq: 2, requestId: "r2", order: 2 })),
    ]);
    // Not yet flushed — the flush is scheduled on a microtask, not run synchronously inline.
    await writes;

    expect(storage.txnCount).toBe(before + 1);
    const { entries } = await storage.loadAll();
    expect(entries).toHaveLength(3);
  });

  it("appends issued across separate microtask turns each get their own transaction", async () => {
    const storage = await openIndexedDBOutbox(idb);
    const before = storage.txnCount;

    await storage.append(makeEntry({ seq: 0, requestId: "r0", order: 0 }));
    await storage.append(makeEntry({ seq: 1, requestId: "r1", order: 1 }));

    expect(storage.txnCount).toBe(before + 2);
  });

  it("mixed same-turn ops (append + updateStatus + setMeta) still flush through one transaction", async () => {
    const storage = await openIndexedDBOutbox(idb);
    await storage.append(makeEntry());
    const before = storage.txnCount;

    await Promise.all([
      storage.updateStatus("client-1", 0, "completed"),
      storage.setMeta("client-1", { nextSeq: 1 }),
      storage.append(makeEntry({ seq: 1, requestId: "r1", order: 1 })),
    ]);

    expect(storage.txnCount).toBe(before + 1);
  });
});

describe("IndexedDBOutboxStorage — persist() (hazard 3: advisory only)", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true });
  });

  it("requests navigator.storage.persist() but never awaits or branches on it", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    Object.defineProperty(globalThis, "navigator", {
      value: { storage: { persist } },
      configurable: true,
    });
    const storage = await openIndexedDBOutbox(idb);
    const result = storage.persist();
    expect(result).toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("a denied or rejected persist() request never throws or surfaces anywhere", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(globalThis, "navigator", {
      value: { storage: { persist } },
      configurable: true,
    });
    const storage = await openIndexedDBOutbox(idb);
    expect(() => storage.persist()).not.toThrow();
    // let the rejected promise's .catch() run — an unhandled rejection would fail this test file.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("is a no-op when navigator.storage doesn't exist at all", async () => {
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
    const storage = await openIndexedDBOutbox(idb);
    expect(() => storage.persist()).not.toThrow();
  });
});

describe("indexedDBOutbox() wired to a real (fake) IndexedDB end to end", () => {
  it("uses the real adapter, not the memory fallback, when IndexedDB is present and healthy", async () => {
    const onFallback = vi.fn();
    const storage = indexedDBOutbox({ indexedDB: idb, onFallback, dbName: "e2e-check" });
    await storage.append(makeEntry());
    const { entries } = await storage.loadAll();
    expect(entries).toHaveLength(1);
    expect(onFallback).not.toHaveBeenCalled();

    // Prove it's really durable via this adapter — open the same db name directly.
    const direct = await openIndexedDBOutbox(idb, "e2e-check");
    expect((await direct.loadAll()).entries).toHaveLength(1);
  });
});
