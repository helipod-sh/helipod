import { describe, it, expect, beforeEach } from "vitest";
import { PostgresDocStore } from "../src/postgres-docstore";
import { PgliteClient } from "./pglite-client";
import { newDocumentId, encodeStorageTableId } from "@helipod/id-codec";
import type { DocumentLogEntry, InternalDocumentId } from "@helipod/docstore";

const TABLE = 10001;
const TABLE_ID = encodeStorageTableId(TABLE);
let store: PostgresDocStore;
beforeEach(async () => { store = new PostgresDocStore(new PgliteClient()); await store.setupSchema(); });
function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body, n: ts } } };
}

describe("scan / count / maxTimestamp / globals", () => {
  it("scan returns newest live rows only, tombstones excluded, ordered by internal_id", async () => {
    const a = newDocumentId(TABLE), b = newDocumentId(TABLE);
    await store.write([rev(a, 1n, null, "a1")], [], "Error");
    await store.write([rev(b, 2n, null, "b1")], [], "Error");
    await store.write([rev(a, 3n, 1n, null)], [], "Error"); // delete a
    const live = await store.scan(TABLE_ID);
    expect(live.map((d) => d.value.value.body)).toEqual(["b1"]);
    expect(await store.count(TABLE_ID)).toBe(1);
    // snapshot read before the delete still sees both
    expect((await store.scan(TABLE_ID, 2n)).length).toBe(2);
  });

  it("maxTimestamp is the highest committed ts, 0 when empty", async () => {
    expect(await store.maxTimestamp()).toBe(0n);
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 7n, null, "x")], [], "Error");
    expect(await store.maxTimestamp()).toBe(7n);
  });

  it("globals: write/read/if-absent", async () => {
    expect(await store.getGlobal("k")).toBeNull();
    await store.writeGlobal("k", { a: 1 });
    expect(await store.getGlobal("k")).toEqual({ a: 1 });
    expect(await store.writeGlobalIfAbsent("k", { a: 2 })).toBe(false); // already present
    expect(await store.writeGlobalIfAbsent("k2", { b: 3 })).toBe(true);
    expect(await store.getGlobal("k")).toEqual({ a: 1 }); // unchanged
  });
});
