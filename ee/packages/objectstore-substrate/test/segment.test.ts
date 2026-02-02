import { describe, expect, it } from "vitest";
import { generateInternalId } from "@stackbase/id-codec";
import type { DocumentLogEntry, IndexWrite } from "@stackbase/docstore";
import { decodeSegment, encodeSegment, type SegmentPayload } from "../src/segment";

function docId(tableNumber: number) {
  return { tableNumber, internalId: generateInternalId() };
}

describe("segment codec", () => {
  it("round-trips a SegmentPayload with real DocumentLogEntry/IndexWrite rows", () => {
    const insertedId = docId(7);
    const tombstonedId = docId(7);

    const documents: DocumentLogEntry[] = [
      // a live document — bigint ts, prev_ts null, a ResolvedDocument with mixed Value fields
      // (including a nested bigint and bytes to exercise convexToJson's full tagging).
      {
        ts: 12345678901234567890n,
        id: insertedId,
        prev_ts: null,
        value: {
          id: insertedId,
          value: {
            _id: "doc1",
            _creationTime: 1752345600000,
            name: "hello",
            count: 42n,
            tags: ["a", "b", "c"],
            nested: { flag: true, blob: new TextEncoder().encode("bytes!").buffer as ArrayBuffer },
            nothing: null,
          },
        },
      },
      // an updated revision chained via prev_ts
      {
        ts: 20n,
        id: insertedId,
        prev_ts: 10n,
        value: { id: insertedId, value: { _id: "doc1", _creationTime: 1752345600000, name: "hello2" } },
      },
      // a tombstone — value: null must round-trip as null, not disappear
      {
        ts: 30n,
        id: tombstonedId,
        prev_ts: 5n,
        value: null,
      },
    ];

    const indexUpdates: IndexWrite[] = [
      {
        ts: 12345678901234567890n,
        update: {
          indexId: "by_creation_time",
          key: new Uint8Array([0, 1, 2, 253, 254, 255]),
          value: { type: "NonClustered", docId: insertedId },
        },
      },
      {
        ts: 30n,
        update: {
          indexId: "by_creation_time",
          key: new Uint8Array([9, 8, 7]),
          value: { type: "Deleted" },
        },
      },
    ];

    const payload: SegmentPayload = { documents, indexUpdates };
    const decoded = decodeSegment(encodeSegment(payload));

    expect(decoded).toEqual(payload);

    // bigints are real bigints, not strings/numbers that happen to look equal
    expect(typeof decoded.documents[0]!.ts).toBe("bigint");
    expect(decoded.documents[0]!.ts).toBe(12345678901234567890n);
    expect(decoded.documents[1]!.prev_ts).toBe(10n);
    expect(decoded.documents[2]!.value).toBeNull();
    expect(decoded.documents[2]!.prev_ts).toBe(5n);

    // id bytes preserved exactly (not just structurally equal via toEqual on typed arrays)
    expect(decoded.documents[0]!.id.internalId).toEqual(insertedId.internalId);
    expect(decoded.documents[0]!.id.tableNumber).toBe(7);

    // index key bytes preserved exactly, including boundary byte values
    expect(decoded.indexUpdates[0]!.update.key).toEqual(new Uint8Array([0, 1, 2, 253, 254, 255]));
    expect(decoded.indexUpdates[0]!.update.value).toEqual({ type: "NonClustered", docId: insertedId });
    expect(decoded.indexUpdates[1]!.update.value).toEqual({ type: "Deleted" });
    expect(typeof decoded.indexUpdates[0]!.ts).toBe("bigint");

    // nested Value fields (bigint, bytes) inside a document's own value round-trip too
    const nestedValue = decoded.documents[0]!.value!.value as Record<string, unknown>;
    expect(nestedValue.count).toBe(42n);
    const nested = nestedValue.nested as Record<string, unknown>;
    expect(nested.flag).toBe(true);
    expect(nested.blob).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(nested.blob as ArrayBuffer)).toEqual(new TextEncoder().encode("bytes!"));
  });

  it("round-trips an empty payload", () => {
    const payload: SegmentPayload = { documents: [], indexUpdates: [] };
    expect(decodeSegment(encodeSegment(payload))).toEqual(payload);
  });

  it("produces a Uint8Array of UTF-8 JSON bytes", () => {
    const payload: SegmentPayload = { documents: [], indexUpdates: [] };
    const bytes = encodeSegment(payload);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(() => JSON.parse(new TextDecoder().decode(bytes))).not.toThrow();
  });
});
