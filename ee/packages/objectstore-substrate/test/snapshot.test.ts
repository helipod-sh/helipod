import { describe, expect, it } from "vitest";
import { generateInternalId } from "@helipod/id-codec";
import type { DocumentLogEntry, IndexWrite } from "@helipod/docstore";
import { MemoryObjectStore } from "@helipod/objectstore/test-support/memory-objectstore";
import { decodeSnapshot, encodeSnapshot, readSnapshot, snapshotKey, writeSnapshot, type SnapshotPayload } from "../src/snapshot";

function docId(tableNumber: number) {
  return { tableNumber, internalId: generateInternalId() };
}

function samplePayload(): SnapshotPayload {
  const liveId = docId(9);
  return {
    frontierTs: "42",
    segBase: 3,
    documents: [
      {
        ts: 12345678901234567890n,
        id: liveId,
        prev_ts: 10n,
        value: {
          id: liveId,
          value: {
            _id: "doc1",
            _creationTime: 1752345600000,
            name: "hello",
            count: 42n,
            blob: new TextEncoder().encode("bytes!").buffer as ArrayBuffer,
          },
        },
      },
    ] satisfies DocumentLogEntry[],
    indexUpdates: [
      {
        ts: 12345678901234567890n,
        update: {
          indexId: "by_creation_time",
          key: new Uint8Array([0, 1, 2, 253, 254, 255]),
          value: { type: "NonClustered", docId: liveId },
        },
      },
      {
        ts: 20n,
        update: { indexId: "by_creation_time", key: new Uint8Array([9, 8, 7]), value: { type: "Deleted" } },
      },
    ] satisfies IndexWrite[],
  };
}

describe("snapshot codec", () => {
  it("round-trips a SnapshotPayload (frontierTs/segBase + bigint/bytes-bearing rows)", () => {
    const payload = samplePayload();
    const decoded = decodeSnapshot(encodeSnapshot(payload));

    expect(decoded).toEqual(payload);
    expect(decoded.frontierTs).toBe("42");
    expect(decoded.segBase).toBe(3);
    expect(typeof decoded.documents[0]!.ts).toBe("bigint");
    expect(decoded.documents[0]!.ts).toBe(12345678901234567890n);
    expect(decoded.documents[0]!.prev_ts).toBe(10n);
    expect(decoded.documents[0]!.id.internalId).toEqual(payload.documents[0]!.id.internalId);
    expect(decoded.indexUpdates[0]!.update.key).toEqual(new Uint8Array([0, 1, 2, 253, 254, 255]));
    expect(decoded.indexUpdates[1]!.update.value).toEqual({ type: "Deleted" });

    const nested = decoded.documents[0]!.value!.value as Record<string, unknown>;
    expect(nested.count).toBe(42n);
    expect(nested.blob).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(nested.blob as ArrayBuffer)).toEqual(new TextEncoder().encode("bytes!"));
  });

  it("round-trips an empty payload", () => {
    const payload: SnapshotPayload = { frontierTs: "0", segBase: -1, documents: [], indexUpdates: [] };
    expect(decodeSnapshot(encodeSnapshot(payload))).toEqual(payload);
  });

  it("produces a Uint8Array of UTF-8 JSON bytes", () => {
    const payload: SnapshotPayload = { frontierTs: "0", segBase: -1, documents: [], indexUpdates: [] };
    const bytes = encodeSnapshot(payload);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(() => JSON.parse(new TextDecoder().decode(bytes))).not.toThrow();
  });
});

describe("snapshotKey", () => {
  it("formats as s{shard}/snap/{ts}", () => {
    expect(snapshotKey("0", "42")).toBe("s0/snap/42");
    expect(snapshotKey("3", "0")).toBe("s3/snap/0");
  });
});

describe("writeSnapshot / readSnapshot", () => {
  it("writes a snapshot object under snapshotKey(shard, frontierTs) and reads it back decoded", async () => {
    const os = new MemoryObjectStore();
    const payload = samplePayload();

    await writeSnapshot(os, "0", payload);

    const raw = await os.get(snapshotKey("0", payload.frontierTs));
    expect(raw).not.toBeNull();

    const read = await readSnapshot(os, "0", payload.frontierTs);
    expect(read).toEqual(payload);
  });

  it("readSnapshot returns null for a missing snapshot", async () => {
    const os = new MemoryObjectStore();
    expect(await readSnapshot(os, "0", "999")).toBeNull();
  });

  it("is scoped per-shard", async () => {
    const os = new MemoryObjectStore();
    const payload = samplePayload();
    await writeSnapshot(os, "0", payload);

    expect(await readSnapshot(os, "1", payload.frontierTs)).toBeNull();
  });
});
