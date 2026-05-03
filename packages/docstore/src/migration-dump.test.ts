import { describe, it, expect } from "vitest";
import type { DocumentLogEntry, IndexWrite } from "./types";
import {
  MIGRATION_DUMP_FORMAT,
  MIGRATION_DUMP_VERSION,
  applyDumpToStore,
  assertImportableTableNumbers,
  decodeDumpRows,
  exportDumpFromStore,
  parseDump,
  serializeDump,
  DumpUnsupportedError,
  InvalidDumpError,
  TableNumberMismatchError,
  type MigrationDump,
} from "./migration-dump";

const idA = { tableNumber: 10001, internalId: new Uint8Array([1, 2, 3]) };
const idB = { tableNumber: 10002, internalId: new Uint8Array([9]) };

const docs: DocumentLogEntry[] = [
  { ts: 5n, id: idA, value: { id: idA, value: { _id: "a", _creationTime: 111, body: "hi", n: 42n } }, prev_ts: null },
  { ts: 7n, id: idB, value: { id: idB, value: { _id: "b", _creationTime: 222, tags: ["x", "y"] } }, prev_ts: 3n },
];
const idx: IndexWrite[] = [
  { ts: 5n, update: { indexId: "t1.by_id", key: new Uint8Array([1, 2, 3]), value: { type: "NonClustered", docId: idA } } },
  { ts: 7n, update: { indexId: "t1.by_id", key: new Uint8Array([255]), value: { type: "Deleted" } } },
];

function fakeStore() {
  return {
    dumpCurrentState: async () => ({ documents: docs, indexUpdates: idx }),
    maxTimestamp: async () => 7n,
  };
}

describe("migration-dump codec", () => {
  it("round-trips bigint ts/prev_ts, Uint8Array ids/keys, and Value fields exactly", async () => {
    const dump = await exportDumpFromStore(fakeStore(), { tableNumbers: { t1: 10001, t2: 10002 }, deploymentId: "dep-1" });
    expect(dump.format).toBe(MIGRATION_DUMP_FORMAT);
    expect(dump.version).toBe(MIGRATION_DUMP_VERSION);
    expect(dump.frontierTs).toBe("7");
    expect(dump.deploymentId).toBe("dep-1");

    const wire = serializeDump(dump);
    const decoded = decodeDumpRows(parseDump(wire));

    expect(decoded.documents).toEqual(docs); // deep equal incl. bigint 42n and Uint8Array bytes
    expect(decoded.indexUpdates).toEqual(idx);
  });

  it("rejects a non-dumpable store", async () => {
    await expect(exportDumpFromStore({}, { tableNumbers: {} })).rejects.toBeInstanceOf(DumpUnsupportedError);
  });

  it("rejects bad format / version", () => {
    expect(() => parseDump(JSON.stringify({ format: "nope", version: 1 }))).toThrow(InvalidDumpError);
    expect(() => parseDump(JSON.stringify({ format: MIGRATION_DUMP_FORMAT, version: 99, tableNumbers: {}, documents: [], indexUpdates: [], frontierTs: "0" }))).toThrow(InvalidDumpError);
  });
});

describe("table-number collision guard", () => {
  const dump: MigrationDump = {
    format: MIGRATION_DUMP_FORMAT,
    version: MIGRATION_DUMP_VERSION,
    deploymentId: null,
    tableNumbers: { messages: 10001, users: 10002 },
    frontierTs: "7",
    documents: [{ ts: 5n, id: idA, value: { id: idA, value: { _id: "a" } }, prev_ts: null }].map((e) => ({
      ts: e.ts.toString(),
      id: { tableNumber: e.id.tableNumber, internalId: btoa("\x01\x02\x03") },
      value: { id: { tableNumber: e.id.tableNumber, internalId: btoa("\x01\x02\x03") }, value: { _id: "a" } },
      prev_ts: null,
    })),
    indexUpdates: [],
  };

  it("accepts a target whose numbers match", () => {
    expect(() => assertImportableTableNumbers(dump, { messages: 10001, users: 10002 })).not.toThrow();
  });

  it("REJECTS a target where the same table has a different number (the clash)", () => {
    expect(() => assertImportableTableNumbers(dump, { messages: 10005, users: 10002 })).toThrow(TableNumberMismatchError);
  });

  it("REJECTS a target missing the table entirely", () => {
    expect(() => assertImportableTableNumbers(dump, { users: 10002 })).toThrow(TableNumberMismatchError);
  });

  it("applyDumpToStore runs the guard before writing", async () => {
    const writes: unknown[] = [];
    const target = { write: async (d: unknown) => void writes.push(d) };
    await expect(applyDumpToStore(target, dump, { messages: 10005 })).rejects.toBeInstanceOf(TableNumberMismatchError);
    expect(writes).toHaveLength(0); // nothing written on rejection
  });
});
