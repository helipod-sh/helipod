/** Shared OutboxStorage contract — run verbatim against every backend (memory, IDB, fs).
 *  Backend-specific behavior (IDB schema/batching, fs journal/lock) stays in the backend's file. */
import { describe, it, expect } from "vitest";
import type { OutboxEntry, OutboxStorage } from "../src/outbox-storage";
import { mintIdentity } from "../src/outbox-storage";
import { OUTBOX_VERSION } from "../src/outbox-idb";

export function makeEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    clientId: "c1",
    seq: 0,
    requestId: "r-0",
    udfPath: "messages:send",
    args: { body: "hi" },
    seed: { entropy: "e", now: 1 },
    order: 0,
    status: "unsent",
    outboxVersion: OUTBOX_VERSION,
    enqueuedAt: 1,
    ...overrides,
  };
}

export function runOutboxStorageContract(
  name: string,
  factory: () => Promise<{ storage: OutboxStorage; cleanup?: () => Promise<void> }>,
): void {
  describe(`OutboxStorage contract — ${name}`, () => {
    async function withStorage(fn: (s: OutboxStorage) => Promise<void>) {
      const { storage, cleanup } = await factory();
      try {
        await fn(storage);
      } finally {
        await storage.close?.();
        await cleanup?.();
      }
    }

    it("append + loadAll roundtrips entries in persisted order across clientIds", () =>
      withStorage(async (s) => {
        await s.append(makeEntry({ clientId: "b", seq: 0, order: 1 }));
        await s.append(makeEntry({ clientId: "a", seq: 0, order: 0 }));
        await s.append(makeEntry({ clientId: "a", seq: 1, order: 2 }));
        const { entries, dropped } = await s.loadAll();
        expect(dropped).toEqual([]);
        expect(entries.map((e) => [e.clientId, e.seq])).toEqual([["a", 0], ["b", 0], ["a", 1]]);
        expect(entries[0]).toMatchObject({ udfPath: "messages:send", args: { body: "hi" } });
      }));

    it("updateStatus changes only status; error is recorded on failed and absent otherwise", () =>
      withStorage(async (s) => {
        await s.append(makeEntry());
        await s.updateStatus("c1", 0, "inflight");
        let [e] = (await s.loadAll()).entries;
        expect(e!.status).toBe("inflight");
        expect(e!.error).toBeUndefined();
        expect(e!.args).toEqual({ body: "hi" });
        await s.updateStatus("c1", 0, "failed", { message: "boom", code: "X" });
        [e] = (await s.loadAll()).entries;
        expect(e!.status).toBe("failed");
        expect(e!.error).toEqual({ message: "boom", code: "X" });
      }));

    it("updateStatus / dequeue for a missing (clientId, seq) are silent no-ops", () =>
      withStorage(async (s) => {
        await s.updateStatus("ghost", 9, "parked");
        await s.dequeue("ghost", 9);
        expect((await s.loadAll()).entries).toEqual([]);
      }));

    it("dequeue removes exactly the one entry", () =>
      withStorage(async (s) => {
        await s.append(makeEntry({ seq: 0, order: 0 }));
        await s.append(makeEntry({ seq: 1, order: 1 }));
        await s.dequeue("c1", 0);
        const { entries } = await s.loadAll();
        expect(entries.map((e) => e.seq)).toEqual([1]);
      }));

    it("loadAll drops stale-outboxVersion entries, deletes them from storage, and reports them", () =>
      withStorage(async (s) => {
        await s.append(makeEntry({ seq: 0, order: 0 }));
        await s.append(makeEntry({ seq: 1, order: 1, outboxVersion: OUTBOX_VERSION - 1 }));
        const first = await s.loadAll();
        expect(first.entries.map((e) => e.seq)).toEqual([0]);
        expect(first.dropped.map((e) => e.seq)).toEqual([1]);
        const second = await s.loadAll();
        expect(second.entries.map((e) => e.seq)).toEqual([0]);
        expect(second.dropped).toEqual([]);
      }));

    it("meta roundtrips; getMeta of an unknown clientId is undefined; deleteMeta removes; list enumerates", () =>
      withStorage(async (s) => {
        expect(await s.getMeta("nope")).toBeUndefined();
        await s.setMeta("c1", { nextSeq: 3, deployment: "dep" });
        await s.setMeta("c2", { nextSeq: 0 });
        expect(await s.getMeta("c1")).toEqual({ nextSeq: 3, deployment: "dep" });
        expect((await s.listMetaClientIds?.())?.sort()).toEqual(["c1", "c2"]);
        await s.deleteMeta?.("c1");
        expect(await s.getMeta("c1")).toBeUndefined();
      }));

    it("mintIdentity mints a fresh clientId at nextSeq 0 and resumes a colliding clientId's cursor", () =>
      withStorage(async (s) => {
        const a = await mintIdentity(s, { mintClientId: () => "fixed" });
        expect(a).toEqual({ clientId: "fixed", nextSeq: 0 });
        await s.setMeta("fixed", { nextSeq: 7 });
        const b = await mintIdentity(s, { mintClientId: () => "fixed" });
        expect(b.nextSeq).toBe(7);
      }));

    it("close() (when present) is idempotent-safe to call after use", () =>
      withStorage(async (s) => {
        await s.append(makeEntry());
        await s.close?.();
      }));
  });
}
