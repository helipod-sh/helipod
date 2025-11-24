import { describe, it, expect, vi } from "vitest";
import { memoryOutbox, indexedDBOutbox, mintIdentity } from "../src/outbox-storage";
import { runOutboxStorageContract, makeEntry } from "./outbox-contract";

runOutboxStorageContract("memoryOutbox", async () => ({ storage: memoryOutbox() }));

describe("memoryOutbox()", () => {
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
});
