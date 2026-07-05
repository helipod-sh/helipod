/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * Direct unit coverage for `applySnapshotState` (Tier 3 Slice 5 re-review fix) — the shared
 * diff+tombstone snapshot-restore helper both `replica-tailer.ts`'s `#materializeRound` and
 * `object-doc-store.ts`'s `materializeTo` now call instead of duplicating the logic. See that
 * helper's own doc comment (`src/apply-snapshot.ts`) for the full "why": an overlay
 * `write(..., "Overwrite")` alone can't express a doc a snapshot silently dropped. This file
 * proves the helper itself in isolation, independent of either call site's own plumbing.
 */
import { describe, expect, it } from "vitest";
import { newDocumentId, type InternalDocumentId } from "@helipod/id-codec";
import type { DocumentLogEntry } from "@helipod/docstore";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@helipod/docstore-sqlite";
import type { SnapshotPayload } from "../src/snapshot";
import { applySnapshotState } from "../src/apply-snapshot";

const TABLE = 30001;

function row(id: InternalDocumentId, ts: bigint, body: string, prevTs: bigint | null = null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: { id, value: { body } } };
}

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

describe("applySnapshotState", () => {
  it("tombstones a doc the local store holds LIVE that the snapshot doesn't mention, applies the snapshot's own rows, and returns the tombstone", async () => {
    const local = freshLocal();
    await local.setupSchema();

    const idA = newDocumentId(TABLE);
    const idB = newDocumentId(TABLE);
    // Seed {A, B} both LIVE — simulates a store already materialized ahead of (or independently
    // of) the snapshot about to be restored onto it (the writer-catch-up / stale-replica shape).
    await local.write([row(idA, 1n, "a"), row(idB, 2n, "b")], [], "Overwrite");
    expect((await local.get(idA))?.value.value.body).toBe("a");
    expect((await local.get(idB))?.value.value.body).toBe("b");

    // A snapshot containing ONLY B (a fresh row) — A is silently absent, exactly as a real
    // snapshot's `dumpCurrentState` source would look if A had since been deleted upstream.
    const snap: SnapshotPayload = {
      frontierTs: "20",
      segBase: 5,
      documents: [row(idB, 10n, "b2", 2n)],
      indexUpdates: [],
    };

    const { deletedDocs } = await applySnapshotState(local, snap, 20n);

    // The returned tombstone is exactly A, at the given frontier.
    expect(deletedDocs).toHaveLength(1);
    expect(deletedDocs[0]!.id).toEqual(idA);
    expect(deletedDocs[0]!.value).toBeNull();
    expect(deletedDocs[0]!.ts).toBe(20n);
    expect(deletedDocs[0]!.prev_ts).toBe(1n);

    // A is gone on the store — NOT resurrected by the snapshot overlay.
    expect(await local.get(idA)).toBeNull();
    // B reflects the snapshot's own row (not the pre-existing one it overlays).
    expect((await local.get(idB))?.value.value.body).toBe("b2");

    await local.close();
  });

  it("is a no-op diff on an EMPTY local store (the common fresh-open path — no behavior change)", async () => {
    const local = freshLocal();
    await local.setupSchema();

    const idB = newDocumentId(TABLE);
    const snap: SnapshotPayload = { frontierTs: "5", segBase: 3, documents: [row(idB, 5n, "b")], indexUpdates: [] };

    const { deletedDocs } = await applySnapshotState(local, snap, 5n);

    expect(deletedDocs).toEqual([]);
    expect((await local.get(idB))?.value.value.body).toBe("b");

    await local.close();
  });

  it("does not tombstone a doc the snapshot DOES still mention", async () => {
    const local = freshLocal();
    await local.setupSchema();

    const idA = newDocumentId(TABLE);
    await local.write([row(idA, 1n, "a")], [], "Overwrite");

    const snap: SnapshotPayload = { frontierTs: "9", segBase: 4, documents: [row(idA, 9n, "a2", 1n)], indexUpdates: [] };
    const { deletedDocs } = await applySnapshotState(local, snap, 9n);

    expect(deletedDocs).toEqual([]);
    expect((await local.get(idA))?.value.value.body).toBe("a2");

    await local.close();
  });
});
