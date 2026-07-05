/**
 * DLR Stage 2c Task 7 — the page (`.paginate()`) `QueryDiff` round-trip, proven end-to-end through a
 * REAL `helipod dev` server over a REAL WebSocket with a REAL `@helipod/client`. Models
 * `range-diff-e2e.test.ts` (Stage 2b Task 8) but exercises the PAGE differ instead of the plain range
 * differ: `ctx.db.query(table, index).eq(...).order("desc").paginate({ pageSize })` returned
 * UNMODIFIED (a pure passthrough — the executor's DIFFABLE_PAGE classification requirement).
 *
 * ORDERING NOTE (why `order: "desc"`, not the default `"asc"`): the index is
 * `(channelId, _creationTime, _id)`, so a NEW insert always has the highest key of its channel (the
 * newest `_creationTime`). With `desc` ordering, a page's pinned bounds (`query-runtime.ts#paginate`'s
 * `pageBoundsRange` for a non-final desc page) are `[lastIncluded, interval.end)` — i.e. from the
 * page's own lowest-included row UP TO the (per-channel-unbounded) top of the keyspace. A brand-new
 * insert's key is always >= that top, so it ALWAYS falls in-bounds and grows page 1 — the canonical
 * live-feed case (assertion 2). There is therefore no way to make a *new* insert land out-of-bounds
 * under desc order (every insert is the newest row, and the bounds' open end is unbounded upward for
 * this channel) — so the out-of-bounds case (assertion 5) instead exercises a WRITE (an in-place
 * `setN` edit, not an insert) to a row that was already below the page-1 boundary at subscribe time:
 * one of two rows seeded beyond the first 3 (so the initial page is non-final, `hasMore: true`, and a
 * real pinned `nextCursor` exists to test against). This is the "seed >3 rows, write to a below-bound
 * one" option the task brief calls out as the cleanest reachable path for both cases.
 */
import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@helipod/values";
import { query, mutation } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, webSocketTransport, anyApi, type ClientTransport } from "@helipod/client";
import type { ServerMessage } from "@helipod/sync";
import { loadProject, startDevServer, type DevServer } from "../src/index";

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

/** Modifications carried by a message (empty for non-Transitions). */
function mods(m: ServerMessage): Array<{ type: string; reset?: unknown }> {
  return m.type === "Transition" ? (m.modifications as Array<{ type: string; reset?: unknown }>) : [];
}
/** True if any message in `inbound` carries a modification of `type`. */
function anyMod(inbound: ServerMessage[], type: string): boolean {
  return inbound.some((m) => mods(m).some((mod) => mod.type === type));
}
/** All modifications of `type` across `inbound`, in arrival order. */
function allMods(inbound: ServerMessage[], type: string): Array<{ type: string; reset?: unknown }> {
  return inbound.flatMap((m) => mods(m).filter((mod) => mod.type === type));
}

/**
 * Wraps a transport, recording every inbound `ServerMessage` and outbound `ClientMessage`. Optional
 * hooks let a scenario (a) strip the outbound capability `Connect` (old-client back-compat) and
 * (b) corrupt the FIRST inbound `QueryDiff`'s checksum (self-heal injection).
 */
function recordingTransport(
  inner: ClientTransport,
  opts: { stripConnect?: boolean; corruptFirstDiffChecksum?: boolean } = {},
): { transport: ClientTransport; inbound: ServerMessage[]; outbound: Array<{ type: string }> } {
  const inbound: ServerMessage[] = [];
  const outbound: Array<{ type: string }> = [];
  let corrupted = false;
  const transport: ClientTransport = {
    send(m) {
      outbound.push(m);
      if (opts.stripConnect && m.type === "Connect") return; // never advertise the capability
      inner.send(m);
    },
    onMessage(listener) {
      return inner.onMessage((msg) => {
        let delivered = msg;
        if (opts.corruptFirstDiffChecksum && !corrupted && msg.type === "Transition") {
          const diff = msg.modifications.find((mod) => mod.type === "QueryDiff");
          if (diff) {
            corrupted = true;
            // Corrupt only the checksum, in-transit — the changes are still correct, so the client
            // applies the right value but must DETECT drift and resync anyway.
            delivered = { ...msg, modifications: msg.modifications.map((mod) => (mod === diff ? { ...mod, checksum: "deadbeef" } : mod)) };
          }
        }
        inbound.push(delivered);
        listener(delivered);
      });
    },
    onClose: (l) => inner.onClose(l),
    onReopen: inner.onReopen ? (l) => inner.onReopen!(l) : undefined,
    close: () => inner.close(),
  };
  return { transport, inbound, outbound };
}

const itemsSchema = defineSchema({
  items: defineTable({ channelId: v.string(), n: v.number() }).index("by_channel", ["channelId"]),
});

type ItemDoc = { _id: string; channelId: string; n: number };
type PageResult = { page: ItemDoc[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean };

const itemsModule = {
  add: mutation<{ channelId: string; n: number }, string>({
    handler: (ctx, { channelId, n }) => ctx.db.insert("items", { channelId, n }),
  }),
  setN: mutation<{ id: string; n: number }, null>({
    handler: async (ctx, { id, n }) => {
      const existing = (await ctx.db.get(id as never)) as ItemDoc | null;
      if (!existing) throw new Error("not found");
      await ctx.db.replace(id as never, { channelId: existing.channelId, n });
      return null;
    },
  }),
  del: mutation<{ id: string }, null>({
    handler: async (ctx, { id }) => {
      await ctx.db.delete(id as never);
      return null;
    },
  }),
  // Pure passthrough paginate, `order: "desc"` — see the file-header ORDERING NOTE. Must stay an
  // unmodified passthrough (no `.page` unwrap, no spread) for the executor to classify it
  // DIFFABLE_PAGE (see `packages/executor/test/diffable-page.test.ts`).
  page: query<{ channelId: string }, unknown>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (ctx, { channelId }) => (ctx.db.query("items", "by_channel") as any).eq("channelId", channelId).order("desc").paginate({ pageSize: 3 }),
  }),
};

const api = anyApi as {
  items: {
    add: { __path: string };
    setN: { __path: string };
    del: { __path: string };
    page: { __path: string };
  };
};

async function startItemsServer(): Promise<{ server: DevServer; runtime: EmbeddedRuntime; wsUrl: string }> {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const project = loadProject({ schema: itemsSchema, modules: { items: itemsModule } });
  const runtime = await createEmbeddedRuntime({ store, catalog: project.catalog, modules: project.moduleMap, tableNumbers: project.tableNumbers });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  return { server, runtime, wsUrl: `ws://127.0.0.1:${server.port}/api/sync` };
}

describe("DLR 2c E2E — page QueryDiff round-trip through the real dev server", () => {
  it("(1)(2)(3)(4)(5) initial page reset, incremental grow/edit/shrink, and an out-of-bounds write no-op", async () => {
    const { server, runtime } = await startItemsServer();
    const recorded = recordingTransport(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }));
    const client = new HelipodClient(recorded.transport);
    try {
      // Seed 5 rows in channel "c" BEFORE subscribing (insertion order n=1..5 == creationTime order,
      // oldest to newest), so the initial desc pageSize:3 page is NON-FINAL (hasMore: true, a real
      // pinned nextCursor) and rows n=1/n=2 sit below the page-1 boundary for assertion 5.
      const id1 = (await client.mutation(api.items.add, { channelId: "c", n: 1 })) as string;
      const id2 = (await client.mutation(api.items.add, { channelId: "c", n: 2 })) as string;
      const id3 = (await client.mutation(api.items.add, { channelId: "c", n: 3 })) as string;
      const id4 = (await client.mutation(api.items.add, { channelId: "c", n: 4 })) as string;
      const id5 = (await client.mutation(api.items.add, { channelId: "c", n: 5 })) as string;

      const frames: PageResult[] = [];
      const beforeSub = recorded.inbound.length;
      client.subscribe(api.items.page, { channelId: "c" }, (val) => frames.push(val as PageResult));
      await waitFor(() => frames.length >= 1, 5000, "initial page");

      // --- (1) initial answer: ordered 3-row page (newest-first, desc), delivered via a page
      // QueryDiff reset — never QueryUpdated ---
      expect(frames.at(-1)?.page.map((d) => d._id)).toEqual([id5, id4, id3]);
      expect(frames.at(-1)?.hasMore).toBe(true);
      expect(typeof frames.at(-1)?.nextCursor).toBe("string");
      expect(frames.at(-1)?.scanCapped).toBe(false);
      const pinnedCursor = frames.at(-1)!.nextCursor;
      const pinnedHasMore = frames.at(-1)!.hasMore;
      const afterSub = recorded.inbound.slice(beforeSub);
      const resetDiffs = allMods(afterSub, "QueryDiff").filter((m) => (m.reset as { mode?: string } | undefined)?.mode === "page");
      expect(resetDiffs.length).toBeGreaterThan(0);
      expect(anyMod(afterSub, "QueryUpdated")).toBe(false);

      // --- (2) an in-bounds add (desc order -> new row is newest -> always at/above the page's own
      // pinned lastIncluded boundary): incremental QueryDiff add, page GROWS to 4, nextCursor/hasMore
      // UNCHANGED (pinned metadata, not re-derived from the row-map) ---
      const beforeAdd = recorded.inbound.length;
      const id6 = (await client.mutation(api.items.add, { channelId: "c", n: 6 })) as string;
      await waitFor(() => frames.at(-1)?.page.length === 4, 5000, "add fanout");
      expect(frames.at(-1)?.page.map((d) => d._id)).toEqual([id6, id5, id4, id3]);
      expect(frames.at(-1)?.nextCursor).toBe(pinnedCursor);
      expect(frames.at(-1)?.hasMore).toBe(pinnedHasMore);
      const afterAdd = recorded.inbound.slice(beforeAdd);
      expect(anyMod(afterAdd, "QueryDiff")).toBe(true);
      expect(anyMod(afterAdd, "QueryUpdated")).toBe(false);
      const addChanges = afterAdd.flatMap((m) =>
        mods(m)
          .filter((mod) => mod.type === "QueryDiff")
          .flatMap((mod) => (mod as unknown as { changes: Array<{ t: string }> }).changes ?? []),
      );
      expect(addChanges.some((c) => c.t === "add")).toBe(true);

      // --- (3) in-place edit of an in-page row: QueryDiff edit, array updates in place (order/count
      // unchanged) ---
      const beforeEdit = recorded.inbound.length;
      await client.mutation(api.items.setN, { id: id4, n: 44 });
      await waitFor(() => frames.at(-1)?.page.find((d) => d._id === id4)?.n === 44, 5000, "edit fanout");
      expect(frames.at(-1)?.page.map((d) => d._id)).toEqual([id6, id5, id4, id3]);
      const afterEdit = recorded.inbound.slice(beforeEdit);
      expect(anyMod(afterEdit, "QueryDiff")).toBe(true);
      expect(anyMod(afterEdit, "QueryUpdated")).toBe(false);
      const editChanges = afterEdit.flatMap((m) =>
        mods(m)
          .filter((mod) => mod.type === "QueryDiff")
          .flatMap((mod) => (mod as unknown as { changes: Array<{ t: string }> }).changes ?? []),
      );
      expect(editChanges.some((c) => c.t === "edit")).toBe(true);

      // --- (4) delete an in-page row: QueryDiff remove, page SHRINKS, remaining order intact ---
      const beforeDel = recorded.inbound.length;
      await client.mutation(api.items.del, { id: id5 });
      await waitFor(() => frames.at(-1)?.page.length === 3, 5000, "delete fanout");
      expect(frames.at(-1)?.page.map((d) => d._id)).toEqual([id6, id4, id3]);
      const afterDel = recorded.inbound.slice(beforeDel);
      expect(anyMod(afterDel, "QueryDiff")).toBe(true);
      expect(anyMod(afterDel, "QueryUpdated")).toBe(false);
      const delChanges = afterDel.flatMap((m) =>
        mods(m)
          .filter((mod) => mod.type === "QueryDiff")
          .flatMap((mod) => (mod as unknown as { changes: Array<{ t: string }> }).changes ?? []),
      );
      expect(delChanges.some((c) => c.t === "remove")).toBe(true);

      // --- (5) OUT-OF-BOUNDS: a write to id1 (n=1, the oldest row — its key sorts BELOW the page's
      // pinned lastIncluded boundary and always has, even after the grow/shrink above) must NOT
      // change this subscription's page at all — no spurious add/edit for id1 reaching it. ---
      const beforeOOB = recorded.inbound.length;
      const pageBeforeOOB = frames.at(-1)?.page.map((d) => d._id);
      await client.mutation(api.items.setN, { id: id1, n: 111 });
      // Give the fan-out a beat to (not) arrive, then assert steady state.
      await new Promise<void>((r) => setTimeout(r, 200));
      expect(frames.at(-1)?.page.map((d) => d._id)).toEqual(pageBeforeOOB);
      expect(frames.every((f) => !f.page.some((d) => d._id === id1))).toBe(true);
      const afterOOB = recorded.inbound.slice(beforeOOB);
      const oobChangesForId1 = afterOOB.flatMap((m) =>
        mods(m)
          .filter((mod) => mod.type === "QueryDiff")
          .flatMap((mod) => (mod as unknown as { changes: Array<{ t: string; key?: string }> }).changes ?? [])
          .filter((c) => c.key === id1),
      );
      expect(oobChangesForId1.length).toBe(0);

      // Sanity: the subscription is still alive and reacts normally to a fresh in-bounds add.
      const id7 = (await client.mutation(api.items.add, { channelId: "c", n: 7 })) as string;
      await waitFor(() => frames.at(-1)?.page.some((d) => d._id === id7) ?? false, 5000, "post-OOB sanity add");
    } finally {
      client.close();
      void runtime;
      await server.close();
    }
  });

  it("(6) a corrupted diff checksum triggers a scoped resync and recovers the correct page", async () => {
    const { server, runtime } = await startItemsServer();
    const recorded = recordingTransport(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }), {
      corruptFirstDiffChecksum: true,
    });
    const client = new HelipodClient(recorded.transport);
    try {
      const id1 = (await client.mutation(api.items.add, { channelId: "c", n: 1 })) as string;
      const id2 = (await client.mutation(api.items.add, { channelId: "c", n: 2 })) as string;

      const frames: PageResult[] = [];
      const beforeSub = recorded.outbound.length;
      client.subscribe(api.items.page, { channelId: "c" }, (val) => frames.push(val as PageResult));
      // The client applies the (correct) reset, detects the wrong checksum, and resyncs.
      await waitFor(() => (frames.at(-1)?.page.length ?? 0) === 2, 5000, "value materialized");
      expect(frames.at(-1)?.page.map((d) => d._id)).toEqual([id2, id1]); // desc: newest first
      expect(frames.at(-1)?.hasMore).toBe(false);
      // A resync ModifyQuerySet was sent AFTER the initial subscribe in response to the drift.
      await waitFor(
        () => recorded.outbound.slice(beforeSub).filter((m) => m.type === "ModifyQuerySet").length >= 2,
        5000,
        "resync sent",
      );
      // And after recovery the page is still correct (the fresh reset re-confirmed it).
      expect(frames.at(-1)?.page.map((d) => d._id)).toEqual([id2, id1]);
    } finally {
      client.close();
      void runtime;
      await server.close();
    }
  });

  it("(7) an old client that never advertises supportsQueryDiff gets QueryUpdated, never QueryDiff", async () => {
    const { server, runtime } = await startItemsServer();
    const recorded = recordingTransport(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }), {
      stripConnect: true,
    });
    const client = new HelipodClient(recorded.transport);
    try {
      const id1 = (await client.mutation(api.items.add, { channelId: "c", n: 1 })) as string;

      const frames: PageResult[] = [];
      const beforeSub = recorded.inbound.length;
      client.subscribe(api.items.page, { channelId: "c" }, (val) => frames.push(val as PageResult));
      await waitFor(() => (frames.at(-1)?.page.length ?? 0) === 1, 5000, "initial page (RERUN)");
      expect(frames.at(-1)?.page.map((d) => d._id)).toEqual([id1]);

      const id2 = (await client.mutation(api.items.add, { channelId: "c", n: 2 })) as string;
      await waitFor(() => (frames.at(-1)?.page.length ?? 0) === 2, 5000, "add (RERUN) fanout");
      expect(frames.at(-1)?.page.map((d) => d._id)).toEqual([id2, id1]); // desc: newest first

      // The whole session used the RERUN path: QueryUpdated on both subscribe and write, never a
      // QueryDiff — and QueryUpdated carries the FULL PaginationResult, not just an array.
      const all = recorded.inbound.slice(beforeSub);
      expect(anyMod(all, "QueryUpdated")).toBe(true);
      expect(anyMod(all, "QueryDiff")).toBe(false);
    } finally {
      client.close();
      void runtime;
      await server.close();
    }
  });
});
