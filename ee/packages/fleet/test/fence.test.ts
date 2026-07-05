/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * Fenced Frontier B1 (Task 3) integration: `shard_leases` acquisition/heartbeat + the epoch-fenced
 * commit guard, exercised TOGETHER against a real `PostgresDocStore` over PGlite (real Postgres
 * semantics, in-process) — proving `installCommitGuard` (node.ts) actually advances/fences the
 * SAME row `LeaseManager` reads/writes, not just each half in isolation. `lease.test.ts` covers
 * `LeaseManager` alone; `lease-monitor.test.ts` covers `LeaseMonitor.fenced()` alone; this file is
 * the seam between them — the heartbeat-as-probe and commit-guard wiring `node.ts` installs.
 */
import { describe, it, expect, vi } from "vitest";
import { newDocumentId, type InternalDocumentId } from "@helipod/id-codec";
import type { DocumentLogEntry } from "@helipod/docstore";
import { PostgresDocStore } from "@helipod/docstore-postgres";
import { LeaseManager } from "../src/lease";
import { LeaseMonitor } from "../src/lease-monitor";
import { FencedError } from "../src/fenced-error";
import { installCommitGuard } from "../src/node";
import { PgliteClient } from "./pglite-client";

const TABLE = 20002;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  // ts arrives as the 0n placeholder — commitWrite overwrites it.
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}

async function makeFencedStore(
  advertiseUrl = "http://node-a:4000",
): Promise<{ client: PgliteClient; pgStore: PostgresDocStore; lease: LeaseManager }> {
  const client = new PgliteClient();
  const pgStore = new PostgresDocStore(client);
  await pgStore.setupSchema();
  const lease = new LeaseManager(client, { advertiseUrl });
  await lease.setup();
  return { client, pgStore, lease };
}

describe("Fenced Frontier B1: shard_leases + epoch-fenced commit guard (Task 3)", () => {
  it("acquisition creates the row with epoch 1 and all D2 columns (frontier/prev seeded to 0)", async () => {
    const { client, lease } = await makeFencedStore();
    const state = await lease.tryAcquire();
    expect(state).toEqual({ epoch: 1n, writerUrl: "http://node-a:4000", frontierTs: 0n });

    const row = await lease.read();
    expect(row).toMatchObject({ epoch: 1n, writerUrl: "http://node-a:4000", frontierTs: 0n, prevTs: 0n });
    await client.close();
  });

  it("re-acquisition bumps the epoch without resetting frontier_ts/prev_ts", async () => {
    const { client, lease } = await makeFencedStore();
    await lease.tryAcquire();
    const second = await lease.tryAcquire();
    expect(second).toEqual({ epoch: 2n, writerUrl: "http://node-a:4000", frontierTs: 0n });
    expect(await lease.read()).toMatchObject({ epoch: 2n, frontierTs: 0n, prevTs: 0n });
    await client.close();
  });

  it("heartbeat(currentEpoch) succeeds (1 row) for the current epoch", async () => {
    const { client, lease } = await makeFencedStore();
    const acquired = await lease.tryAcquire();
    expect(await lease.heartbeat(acquired!.epoch)).toBe(1);
    await client.close();
  });

  it("a stale-epoch heartbeat returns 0 rows — the probe wrapper turns this into a FencedError that reaches the monitor", async () => {
    const { client, lease } = await makeFencedStore();
    const first = await lease.tryAcquire(); // epoch 1
    await lease.tryAcquire(); // epoch 2 — supersedes epoch 1 (e.g. another node re-acquired)

    const onExit = vi.fn();
    const monitor = new LeaseMonitor({ probe: vi.fn(async () => {}), onExit });
    monitor.start();

    // Mirrors node.ts's startWriterMonitor probe verbatim: heartbeat(myEpoch) -> 0 rows ->
    // monitor.fenced() -> throw FencedError.
    const probe = async (): Promise<void> => {
      const n = await lease.heartbeat(first!.epoch);
      if (n === 0) {
        monitor.fenced("heartbeat found 0 rows for this node's epoch");
        throw new FencedError("writer lease fenced: heartbeat found 0 rows for this node's epoch");
      }
    };
    await expect(probe()).rejects.toThrow(FencedError);
    expect(onExit).toHaveBeenCalledTimes(1); // monitor.fenced() → onExit once immediately
    expect(String(onExit.mock.calls[0]![0])).toContain("fenced");
    await client.close();
  });

  it("installCommitGuard: a commitWrite on the current epoch advances frontier_ts/prev_ts on the SAME lease row", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    await lease.tryAcquire(); // epoch 1

    installCommitGuard(pgStore, lease, () => {});

    const id1 = newDocumentId(TABLE);
    const commit1 = await pgStore.commitWrite([doc(id1, "a")], []);
    let row = await lease.read();
    expect(row?.frontierTs).toBe(commit1);
    expect(row?.prevTs).toBe(0n); // first commit's chain step is off the seeded 0

    const id2 = newDocumentId(TABLE);
    const commit2 = await pgStore.commitWrite([doc(id2, "b")], []);
    row = await lease.read();
    expect(row?.frontierTs).toBe(commit2);
    expect(row?.prevTs).toBe(commit1); // the chain step: prev_ts becomes the PRIOR frontier

    await client.close();
  });

  it("installCommitGuard: a stale (superseded) epoch aborts the WHOLE commit — zero rows land — and fires the fenced callback", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    await lease.tryAcquire(); // node-a acquires epoch 1; its guard checks against ITS lease.currentEpoch()

    const fenced = vi.fn();
    installCommitGuard(pgStore, lease, fenced);

    // A competing node re-acquires — epoch bumps to 2, fencing node-a out from under it. node-a's
    // own `lease.currentEpoch()` still (correctly) reports 1 — it never re-acquired — so the guard's
    // epoch-predicated UPDATE now matches 0 rows against the real (epoch-2) row.
    const other = new LeaseManager(client, { advertiseUrl: "http://node-b:4001" });
    await other.tryAcquire(); // epoch 2

    const id = newDocumentId(TABLE);
    await expect(pgStore.commitWrite([doc(id, "x")], [])).rejects.toThrow(FencedError);
    expect(fenced).toHaveBeenCalledTimes(1);

    // Both the document insert and the sequence allocation roll back with the transaction — the
    // whole commit aborted, nothing landed (mirrors packages/docstore-postgres/test/commit-guard.test.ts).
    const docs = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(docs[0]!.n)).toBe(0);

    // The lease row itself is unaffected by the aborted commit — still epoch 2, frontier untouched.
    const row = await other.read();
    expect(row?.epoch).toBe(2n);
    expect(row?.frontierTs).toBe(0n);
    expect(row?.prevTs).toBe(0n);

    await client.close();
  });

  it("installCommitGuard: no acquired epoch (currentEpoch() null) fences defensively rather than allowing an unfenced commit", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    // Deliberately never acquired — currentEpoch() is null.
    const fenced = vi.fn();
    installCommitGuard(pgStore, lease, fenced);

    const id = newDocumentId(TABLE);
    await expect(pgStore.commitWrite([doc(id, "x")], [])).rejects.toThrow(FencedError);
    expect(fenced).toHaveBeenCalledTimes(1);

    const docs = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(docs[0]!.n)).toBe(0);
    await client.close();
  });

  it("monitor.fenced() → onExit exactly once, immediately (the probe-wrapper's + commit-guard's shared routing target)", () => {
    const onExit = vi.fn();
    const monitor = new LeaseMonitor({ probe: vi.fn(async () => {}), onExit });
    monitor.start();

    monitor.fenced("heartbeat found 0 rows for this node's epoch");
    monitor.fenced("a second, unrelated fence"); // must not double-fire

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(String(onExit.mock.calls[0]![0])).toContain("fenced");
  });
});
