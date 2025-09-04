/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PostgresDocStore } from "@stackbase/docstore-postgres";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type { DocumentLogEntry, IndexWrite, InternalDocumentId } from "@stackbase/docstore";
import type { EmbeddedWriteFanoutAdapter, EmbeddedWriteFanoutPayload, FanoutListener } from "@stackbase/runtime-embedded";
import { PgliteClient } from "./pglite-client";
import { CommitTailer, NotifyingFanoutAdapter, type DerivedInvalidation } from "../src/commit-notifier";

const TABLE = "10001";
const INDEX_ID = "10001:by_key";

function docId(n: number): InternalDocumentId {
  return { tableNumber: 10001, internalId: new Uint8Array([n]) };
}
function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body } } };
}
function idxPut(id: InternalDocumentId, key: Uint8Array, ts: bigint): IndexWrite {
  return { ts, update: { indexId: INDEX_ID, key, value: { type: "NonClustered", docId: id } } };
}
function idxDel(key: Uint8Array, ts: bigint): IndexWrite {
  return { ts, update: { indexId: INDEX_ID, key, value: { type: "Deleted" } } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("CommitTailer (poll path)", () => {
  let store: PostgresDocStore;
  let client: PgliteClient;
  let tailer: CommitTailer | undefined;

  beforeEach(async () => {
    client = new PgliteClient();
    store = new PostgresDocStore(client);
    await store.setupSchema();
  });

  afterEach(async () => {
    if (tailer) await tailer.stop();
    await store.close();
  });

  it("seeds the watermark at start(), derives only the range since then, and stops cleanly", async () => {
    const a = docId(1);
    const b = docId(2);
    const ka = encodeIndexKey(["a"]);
    const kb = encodeIndexKey(["b"]);
    // Two writes BEFORE start() — these must never be redelivered (watermark seeded at t2).
    await store.write([rev(a, 1n, null, "A")], [idxPut(a, ka, 1n)], "Error");
    await store.write([rev(b, 2n, 1n, "B")], [idxPut(b, kb, 2n)], "Error");

    const invalidations: DerivedInvalidation[] = [];
    tailer = new CommitTailer(client as unknown as never, store, {
      pollMs: 20,
      onInvalidation: async (inv) => {
        invalidations.push(inv);
      },
    });
    await tailer.start();

    // Give the poll loop a couple of ticks with nothing new — must NOT fire.
    await new Promise((r) => setTimeout(r, 60));
    expect(invalidations).toHaveLength(0);

    // Third write AFTER start() — this is the one that must be derived.
    const c = docId(3);
    const kc = encodeIndexKey(["c"]);
    await store.write([rev(c, 3n, null, "C")], [idxPut(c, kc, 3n)], "Error");

    await waitFor(() => invalidations.length > 0);
    expect(invalidations).toHaveLength(1);
    const inv = invalidations[0]!;
    expect(inv.newMaxTs).toBe(3n);
    expect(inv.writtenTables).toEqual([TABLE]);
    expect(inv.writtenKeys).toHaveLength(1);
    expect(inv.writtenKeys[0]!.indexId).toBe(INDEX_ID);
    expect(inv.writtenKeys[0]!.key).toEqual(kc);
    expect(inv.writtenDocs).toEqual([{ tableId: TABLE, internalId: c.internalId }]);

    await tailer.stop();
    const countAfterStop = invalidations.length;

    // A write after stop() must not be picked up.
    const d = docId(4);
    const kd = encodeIndexKey(["d"]);
    await store.write([rev(d, 4n, null, "D")], [idxPut(d, kd, 4n)], "Error");
    await new Promise((r) => setTimeout(r, 60));
    expect(invalidations).toHaveLength(countAfterStop);
  });

  it("a pure-tombstone commit (table_id NULL on the index row) does not leak a bogus table id", async () => {
    const a = docId(1);
    const ka = encodeIndexKey(["a"]);
    await store.write([rev(a, 1n, null, "A")], [idxPut(a, ka, 1n)], "Error");

    const invalidations: DerivedInvalidation[] = [];
    tailer = new CommitTailer(client as unknown as never, store, {
      pollMs: 20,
      onInvalidation: async (inv) => {
        invalidations.push(inv);
      },
    });
    await tailer.start();

    // Tombstone: document deleted + index entry marked Deleted (table_id/internal_id NULL).
    await store.write([rev(a, 2n, 1n, null)], [idxDel(ka, 2n)], "Error");

    await waitFor(() => invalidations.length > 0);
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]!.writtenTables).toEqual([]); // no NonClustered entry in this commit
    expect(invalidations[0]!.writtenKeys).toEqual([{ indexId: INDEX_ID, key: ka }]);
    // The gap this fix closes: a subscription reading via bare `ctx.db.get(id)` reads the
    // DOCUMENT keyspace, not any index keyspace — so it must still be invalidated here even
    // though the index-derived `writtenTables`/`writtenKeys` carry nothing usable for it. The
    // `documents` table records the tombstone write unconditionally, independent of `indexes`.
    expect(invalidations[0]!.writtenDocs).toEqual([{ tableId: TABLE, internalId: a.internalId }]);
  });

  it("a doc write with multiple indexed fields yields exactly ONE writtenDocs entry (dedup — a doc with 3 indexes is still 1 doc range)", async () => {
    const a = docId(1);
    const k1 = encodeIndexKey(["a"]);
    const k2 = encodeIndexKey(["b"]);
    const k3 = encodeIndexKey(["c"]);

    const invalidations: DerivedInvalidation[] = [];
    tailer = new CommitTailer(client as unknown as never, store, {
      pollMs: 20,
      onInvalidation: async (inv) => {
        invalidations.push(inv);
      },
    });
    await tailer.start();

    // One document write, three index entries maintained alongside it (three declared indexes).
    await store.write(
      [rev(a, 1n, null, "A")],
      [
        { ts: 1n, update: { indexId: "10001:by_a", key: k1, value: { type: "NonClustered", docId: a } } },
        { ts: 1n, update: { indexId: "10001:by_b", key: k2, value: { type: "NonClustered", docId: a } } },
        { ts: 1n, update: { indexId: "10001:by_c", key: k3, value: { type: "NonClustered", docId: a } } },
      ],
      "Error",
    );

    await waitFor(() => invalidations.length > 0);
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]!.writtenKeys).toHaveLength(3); // one index-keyspace range per index row
    expect(invalidations[0]!.writtenDocs).toEqual([{ tableId: TABLE, internalId: a.internalId }]); // deduped to ONE doc-keyspace range
  });
});

describe("NotifyingFanoutAdapter", () => {
  it("delegates publish/subscribe to the inner adapter and NOTIFYs stackbase_commits per publish", () => {
    const published: EmbeddedWriteFanoutPayload[] = [];
    const listeners = new Set<FanoutListener>();
    const inner: EmbeddedWriteFanoutAdapter = {
      publish: vi.fn((payload: EmbeddedWriteFanoutPayload) => {
        published.push(payload);
        for (const l of listeners) l(payload);
      }),
      subscribe: vi.fn((listener: FanoutListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const notify = vi.fn(async (_channel: string, _payload: string) => {});
    const client = { notify } as unknown as never;

    const adapter = new NotifyingFanoutAdapter(inner, client);

    const received: EmbeddedWriteFanoutPayload[] = [];
    const unsubscribe = adapter.subscribe((p) => received.push(p));
    expect(inner.subscribe).toHaveBeenCalledTimes(1);

    const payload: EmbeddedWriteFanoutPayload = {
      commitTs: 42,
      tables: ["10001"],
      ranges: [],
      originId: "origin-a",
    };
    adapter.publish(payload);

    expect(inner.publish).toHaveBeenCalledWith(payload);
    expect(published).toEqual([payload]);
    expect(received).toEqual([payload]); // delegated subscribe also observes it
    expect(notify).toHaveBeenCalledWith("stackbase_commits", "42");

    unsubscribe();
  });
});
