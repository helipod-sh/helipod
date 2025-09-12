/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Node lifecycle (Fleet slice 2, Task 4) — the pieces of `prepareFleetNode`/`startFleetNode` that
 * are unit-testable in isolation:
 *
 *   (a) `openSyncReplica` — a sync node's local file-backed replica behind a `SwitchableDocStore`,
 *       at `<dataDir>/fleet-replica.db`.
 *   (b) `promoteFleetNode` — the CRITICAL PROMOTION ORDER, asserted via instrumented spies (the
 *       real full lifecycle over a live runtime + real Postgres is the Task-5/`fleet-e2e` ship gate).
 *   (c) corrupted replica file → delete + retry once + warn → boots.
 *   (d) restart resume — a fresh replica on the same file seeds its watermark from the persisted
 *       max and does NOT re-deliver already-applied entries.
 *
 * `prepareFleetNode`/`startFleetNode` as a whole build a real `NodePgClient` from a connection
 * string and contend a Postgres advisory lock (writer-vs-sync election), so the integrated path is
 * proven only through the real `stackbase serve --fleet` E2E; here we exercise their extracted,
 * side-effect-free seams directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresDocStore } from "@stackbase/docstore-postgres";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { newDocumentId, encodeStorageIndexId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type { DocStore, DocumentLogEntry, IndexWrite, InternalDocumentId } from "@stackbase/docstore";
import { PgliteClient } from "./pglite-client";
import { ReplicaTailer, type AppliedInvalidation } from "../src/replica-tailer";
import { SwitchableDocStore } from "../src/switchable-store";
import { openSyncReplica, promoteFleetNode, REPLICA_DB_FILENAME } from "../src/node";

const T1 = 10001;
const INDEX_ID_T1 = encodeStorageIndexId(T1, "by_key");

function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body } } };
}
function idxPut(id: InternalDocumentId, key: Uint8Array, ts: bigint): IndexWrite {
  return { ts, update: { indexId: INDEX_ID_T1, key, value: { type: "NonClustered", docId: id } } };
}

describe("fleet node lifecycle", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fleet-node-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("(a) openSyncReplica returns a SwitchableDocStore over a file at <dataDir>/fleet-replica.db", async () => {
    const path = join(tmp, REPLICA_DB_FILENAME);
    const { replica, switchable } = await openSyncReplica(path);
    try {
      expect(switchable).toBeInstanceOf(SwitchableDocStore);
      expect(switchable.current()).toBe(replica); // switchable forwards to the replica initially
      expect(existsSync(path)).toBe(true); // real on-disk SQLite file
      expect(await replica.maxTimestamp()).toBe(0n); // schema set up, fresh (nothing applied yet)
    } finally {
      await replica.close();
    }
  });

  it("(b) promoteFleetNode runs the critical order: observeTimestamp→setWritable→swapTo→promote→tailer.stop→startDrivers", async () => {
    const order: string[] = [];
    let observed: bigint | undefined;
    let swappedTo: unknown;
    const pgStore = {
      maxTimestamp: async () => 42n, // the oracle must be advanced past ALL primary history
      setWritable: () => void order.push("setWritable"),
    };
    const runtime = {
      observeTimestamp: (ts: bigint) => {
        observed = ts;
        order.push("observeTimestamp");
      },
      startDrivers: async () => void order.push("startDrivers"),
    };
    const switchable = {
      swapTo: (next: DocStore) => {
        swappedTo = next;
        order.push("swapTo");
      },
    };
    const forwarder = { promote: () => void order.push("promote") };
    const tailer = { stop: async () => void order.push("tailer.stop") };
    const replica = { close: async () => void order.push("replica.close") };

    await promoteFleetNode({ runtime, pgStore, switchable, forwarder, tailer, replica });

    // The documented critical order (replica.close falls between tailer.stop and startDrivers —
    // the tailer must have stopped writing to the replica before it's closed).
    expect(order).toEqual([
      "observeTimestamp",
      "setWritable",
      "swapTo",
      "promote",
      "tailer.stop",
      "replica.close",
      "startDrivers",
    ]);
    expect(observed).toBe(42n); // observeTimestamp got the primary's maxTimestamp()
    expect(swappedTo).toBe(pgStore); // the runtime store repoints at the (now writable) pg store
  });

  it("(c) a corrupted replica file is deleted, rebuilt on one retry, and boots (with a warning)", async () => {
    const path = join(tmp, REPLICA_DB_FILENAME);
    // Garbage bytes → not a valid SQLite database → open/setupSchema throws on the first attempt.
    writeFileSync(path, Buffer.from("this is definitely not a sqlite database header"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { replica, switchable } = await openSyncReplica(path);
      try {
        expect(switchable.current()).toBe(replica);
        expect(await replica.maxTimestamp()).toBe(0n); // fresh, usable replica after the rebuild
        expect(warn).toHaveBeenCalledTimes(1); // the delete+retry was reported
        expect(String(warn.mock.calls[0]![0])).toContain("failed to open");
      } finally {
        await replica.close();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("(d) restart resume: a fresh replica on the same file seeds the watermark and skips old entries", async () => {
    const client = new PgliteClient();
    const primary = new PostgresDocStore(client);
    await primary.setupSchema();
    const path = join(tmp, REPLICA_DB_FILENAME);

    const a = newDocumentId(T1);
    const b = newDocumentId(T1);
    await primary.write([rev(a, 1n, null, "A1")], [idxPut(a, encodeIndexKey(["a"]), 1n)], "Error");
    await primary.write([rev(b, 2n, null, "B1")], [idxPut(b, encodeIndexKey(["b"]), 2n)], "Error");

    // First run: tail the two entries onto a file-backed replica, then dispose.
    const r1 = new SqliteDocStore(new NodeSqliteAdapter({ path }));
    await r1.setupSchema();
    const t1 = new ReplicaTailer(client, primary, r1, { pollMs: 20, onInvalidation: async () => {} });
    await t1.start();
    expect(await r1.maxTimestamp()).toBe(2n); // caught up
    await t1.stop();
    await r1.close();

    // Second run: re-open the SAME file. The persisted watermark (2) must be seeded so the already
    // -applied (0, 2] range is NOT re-delivered — onInvalidation stays silent, watermark starts at 2.
    const r2 = new SqliteDocStore(new NodeSqliteAdapter({ path }));
    await r2.setupSchema();
    expect(await r2.maxTimestamp()).toBe(2n); // watermark survived the restart on disk
    const invs: AppliedInvalidation[] = [];
    const t2 = new ReplicaTailer(client, primary, r2, {
      pollMs: 20,
      onInvalidation: async (inv) => void invs.push(inv),
    });
    await t2.start();
    expect(t2.watermark()).toBe(2n); // seeded from the replica, not 0
    // Give the poll loop a couple of ticks with nothing new — the old range must not re-fire.
    await new Promise((r) => setTimeout(r, 80));
    expect(invs).toEqual([]);

    await t2.stop();
    await r2.close();
    await primary.close();
  });
});
