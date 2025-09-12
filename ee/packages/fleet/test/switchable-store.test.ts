/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
import { describe, it, expect, beforeEach } from "vitest";
import { NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { newDocumentId, encodeStorageTableId, encodeStorageIndexId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type { DocumentLogEntry, InternalDocumentId } from "@stackbase/docstore";
import { SwitchableDocStore } from "../src/switchable-store";

const TABLE = 10001;
const TABLE_ID = encodeStorageTableId(TABLE);
const INDEX_ID = encodeStorageIndexId(TABLE, "by_body");

function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: { id, value: { body } } };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

async function makeStore(): Promise<SqliteDocStore> {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  return store;
}

describe("SwitchableDocStore", () => {
  let storeA: SqliteDocStore;
  let storeB: SqliteDocStore;
  let sameId: InternalDocumentId;

  beforeEach(async () => {
    storeA = await makeStore();
    storeB = await makeStore();
    sameId = newDocumentId(TABLE);

    // Same logical id/table/index-key written with distinct content into two independent
    // physical stores, so which store answered a call is unambiguous from the body text.
    await storeA.write(
      [rev(sameId, 1n, null, "from-A-1"), rev(sameId, 2n, 1n, "from-A-2")],
      [
        { ts: 1n, update: { indexId: INDEX_ID, key: encodeIndexKey(["k"]), value: { type: "NonClustered", docId: sameId } } },
      ],
      "Error",
    );
    await storeA.writeGlobal("cursor", "A-global");

    await storeB.write(
      [rev(sameId, 1n, null, "from-B-1"), rev(sameId, 2n, 1n, "from-B-2"), rev(sameId, 3n, 2n, "from-B-3")],
      [
        { ts: 1n, update: { indexId: INDEX_ID, key: encodeIndexKey(["k"]), value: { type: "NonClustered", docId: sameId } } },
      ],
      "Error",
    );
    await storeB.writeGlobal("cursor", "B-global");
  });

  it("current() reflects the constructor-supplied delegate, then the swapped-to one", () => {
    const sw = new SwitchableDocStore(storeA);
    expect(sw.current()).toBe(storeA);
    sw.swapTo(storeB);
    expect(sw.current()).toBe(storeB);
  });

  it("get() answers from A before swap, from B after", async () => {
    const sw = new SwitchableDocStore(storeA);
    expect((await sw.get(sameId))!.value.value.body).toBe("from-A-2");

    sw.swapTo(storeB);
    expect((await sw.get(sameId))!.value.value.body).toBe("from-B-3");
  });

  it("maxTimestamp() answers from A before swap, from B after", async () => {
    const sw = new SwitchableDocStore(storeA);
    expect(await sw.maxTimestamp()).toBe(2n);

    sw.swapTo(storeB);
    expect(await sw.maxTimestamp()).toBe(3n);
  });

  it("getGlobal()/writeGlobal() delegate to the current store", async () => {
    const sw = new SwitchableDocStore(storeA);
    expect(await sw.getGlobal("cursor")).toBe("A-global");

    await sw.writeGlobal("cursor", "A-global-updated");
    expect(await storeA.getGlobal("cursor")).toBe("A-global-updated");
    expect(await storeB.getGlobal("cursor")).toBe("B-global"); // untouched

    sw.swapTo(storeB);
    expect(await sw.getGlobal("cursor")).toBe("B-global");

    await sw.writeGlobal("cursor", "B-global-updated");
    expect(await storeB.getGlobal("cursor")).toBe("B-global-updated");
    expect(await storeA.getGlobal("cursor")).toBe("A-global-updated"); // untouched
  });

  it("writeGlobalIfAbsent() delegates to the current store", async () => {
    const sw = new SwitchableDocStore(storeA);
    expect(await sw.writeGlobalIfAbsent("fresh-key", "v1")).toBe(true);
    expect(await sw.writeGlobalIfAbsent("fresh-key", "v2")).toBe(false);
    expect(await storeA.getGlobal("fresh-key")).toBe("v1");
    expect(await storeB.getGlobal("fresh-key")).toBeNull();

    sw.swapTo(storeB);
    expect(await sw.writeGlobalIfAbsent("fresh-key", "vB")).toBe(true);
    expect(await storeB.getGlobal("fresh-key")).toBe("vB");
  });

  it("scan() and count() answer from A before swap, from B after", async () => {
    const sw = new SwitchableDocStore(storeA);
    let rows = await sw.scan(TABLE_ID);
    expect(rows.map((r) => r.value.value.body)).toEqual(["from-A-2"]);
    expect(await sw.count(TABLE_ID)).toBe(1);

    sw.swapTo(storeB);
    rows = await sw.scan(TABLE_ID);
    expect(rows.map((r) => r.value.value.body)).toEqual(["from-B-3"]);
    expect(await sw.count(TABLE_ID)).toBe(1);
  });

  it("previous_revisions() answers from A before swap, from B after", async () => {
    const sw = new SwitchableDocStore(storeA);
    const atA = await sw.previous_revisions([{ id: sameId, ts: 1n }]);
    expect([...atA.values()][0]!.value!.value.body).toBe("from-A-1");

    sw.swapTo(storeB);
    const atB = await sw.previous_revisions([{ id: sameId, ts: 1n }]);
    expect([...atB.values()][0]!.value!.value.body).toBe("from-B-1");
  });

  it("index_scan() answers from A before swap, from B after", async () => {
    const sw = new SwitchableDocStore(storeA);
    const interval = { start: encodeIndexKey([]), end: null };

    const fromA = await collect(sw.index_scan(INDEX_ID, TABLE_ID, 2n, interval, "asc"));
    expect(fromA.map(([, doc]) => doc.value.value.body)).toEqual(["from-A-2"]);

    sw.swapTo(storeB);
    const fromB = await collect(sw.index_scan(INDEX_ID, TABLE_ID, 3n, interval, "asc"));
    expect(fromB.map(([, doc]) => doc.value.value.body)).toEqual(["from-B-3"]);
  });

  it("load_documents() answers from A before swap, from B after", async () => {
    const sw = new SwitchableDocStore(storeA);
    const range = { minInclusive: 0n, maxExclusive: 100n };

    const fromA = await collect(sw.load_documents(range, "asc"));
    expect(fromA.map((e) => e.value!.value.body)).toEqual(["from-A-1", "from-A-2"]);

    sw.swapTo(storeB);
    const fromB = await collect(sw.load_documents(range, "asc"));
    expect(fromB.map((e) => e.value!.value.body)).toEqual(["from-B-1", "from-B-2", "from-B-3"]);
  });

  it("a load_documents() generator started before swapTo() keeps draining the OLD delegate to completion", async () => {
    const sw = new SwitchableDocStore(storeA);
    const range = { minInclusive: 0n, maxExclusive: 100n };

    const gen = sw.load_documents(range, "asc");
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value!.value!.value.body).toBe("from-A-1");

    // Swap mid-iteration — the in-flight generator must NOT jump to B.
    sw.swapTo(storeB);

    const rest: DocumentLogEntry[] = [];
    for (let step = await gen.next(); !step.done; step = await gen.next()) {
      rest.push(step.value);
    }
    expect(rest.map((e) => e.value!.value.body)).toEqual(["from-A-2"]);

    // A brand-new call made after the swap sees B in full, confirming the swap did take effect
    // for subsequent calls even though the in-flight one above was unaffected.
    const afterSwap = await collect(sw.load_documents(range, "asc"));
    expect(afterSwap.map((e) => e.value!.value.body)).toEqual(["from-B-1", "from-B-2", "from-B-3"]);
  });

  it("write() delegates to the current store only", async () => {
    const sw = new SwitchableDocStore(storeA);
    const newId = newDocumentId(TABLE);
    await sw.write([rev(newId, 10n, null, "written-via-wrapper-to-A")], [], "Error");
    expect((await storeA.get(newId))!.value.value.body).toBe("written-via-wrapper-to-A");
    expect(await storeB.get(newId)).toBeNull();

    sw.swapTo(storeB);
    const newId2 = newDocumentId(TABLE);
    await sw.write([rev(newId2, 10n, null, "written-via-wrapper-to-B")], [], "Error");
    expect((await storeB.get(newId2))!.value.value.body).toBe("written-via-wrapper-to-B");
    expect(await storeA.get(newId2)).toBeNull();
  });

  it("setupSchema() delegates to the current store (idempotent no-throw)", async () => {
    const sw = new SwitchableDocStore(storeA);
    await expect(sw.setupSchema()).resolves.toBeUndefined();
    sw.swapTo(storeB);
    await expect(sw.setupSchema()).resolves.toBeUndefined();
  });

  it("close() closes only the CURRENT delegate, not one swapped out earlier", async () => {
    const sw = new SwitchableDocStore(storeA);
    sw.swapTo(storeB);

    await sw.close();

    // B (current at close time) is now closed — an operation against it throws.
    await expect(storeB.get(sameId)).rejects.toThrow();
    // A (swapped out before close) was left alone — still fully usable.
    expect((await storeA.get(sameId))!.value.value.body).toBe("from-A-2");
  });
});
