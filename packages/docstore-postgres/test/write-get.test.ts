import { describe, it, expect, beforeEach } from "vitest";
import { PostgresDocStore } from "../src/postgres-docstore";
import { PgliteClient } from "./pglite-client";
import { newDocumentId, encodeStorageTableId } from "@helipod/id-codec";
import type { DocumentLogEntry, InternalDocumentId } from "@helipod/docstore";

const TABLE = 10001;
let store: PostgresDocStore;
beforeEach(async () => {
  store = new PostgresDocStore(new PgliteClient());
  await store.setupSchema();
});
function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body, n: ts } } };
}

describe("write + get (MVCC point read)", () => {
  it("reads the newest revision visible at a read timestamp and round-trips bigint", async () => {
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 1n, null, "v1")], [], "Error");
    await store.write([rev(id, 2n, 1n, "v2")], [], "Error");

    expect(await store.get(id, 0n)).toBeNull();
    expect((await store.get(id, 1n))!.value.value.body).toBe("v1");
    const latest = (await store.get(id))!;
    expect(latest.value.value.body).toBe("v2");
    expect(latest.ts).toBe(2n);           // bigint, not number/string
    expect(latest.prev_ts).toBe(1n);
    expect((latest.value.value as { n: bigint }).n).toBe(2n); // value fidelity: bigint preserved
  });

  it("hides a tombstoned document but preserves history", async () => {
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 1n, null, "v1")], [], "Error");
    await store.write([rev(id, 2n, 1n, null)], [], "Error"); // tombstone
    expect(await store.get(id)).toBeNull();
    expect((await store.get(id, 1n))!.value.value.body).toBe("v1");
  });

  it("Overwrite replaces a revision at the same ts; Error would collide", async () => {
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 1n, null, "a")], [], "Error");
    await store.write([rev(id, 1n, null, "b")], [], "Overwrite"); // same (table,id,ts) → replace
    expect((await store.get(id, 1n))!.value.value.body).toBe("b");
  });
});
