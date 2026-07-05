/**
 * DLR Stage 2b Task 8 — the range `QueryDiff` round-trip (index `collect()`), proven end-to-end
 * through a REAL `helipod dev` server over a REAL WebSocket with a REAL `@helipod/client`.
 * Models `byid-diff-e2e.test.ts` (Stage 2a Task 7) but exercises the RANGE differ instead of the
 * by-id differ: `ctx.db.query(table, index).eq(...).collect()` over a `by_channel` index.
 *
 * What this pins that the unit tests (Tasks 1/3/5/6/7) cannot:
 *  (1) An index `collect()` subscription's INITIAL answer is a `QueryDiff` reset with
 *      `reset.mode === "range"` (not `QueryUpdated`), and the client materializes an ordered array
 *      from it — the whole classify → CommitDiffer reset → wire → range MaterializedCache pipeline.
 *  (2) An `add` fans out as an incremental `QueryDiff` add, correctly positioned in the ordered array.
 *  (3) An in-place edit (`replace`) fans out as an incremental `QueryDiff` edit.
 *  (4) A `delete` fans out as an incremental `QueryDiff` remove.
 *  (5) A `.where()` filter exclusion: a written row that doesn't match the filter must never surface
 *      as a spurious `add` to a filtered subscription.
 *  (6) Checksum self-heal: a corrupted-in-transit diff checksum makes the client detect drift and
 *      scoped-resync, recovering the correct array.
 *  (7) Old-client back-compat: a client that never advertises `supportsQueryDiff` gets `QueryUpdated`
 *      (the RERUN path), never a `QueryDiff`.
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
  list: query<{ channelId: string }, unknown[]>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (ctx, { channelId }) => (ctx.db.query("items", "by_channel") as any).eq("channelId", channelId).collect(),
  }),
  listGt: query<{ channelId: string }, unknown[]>({
    handler: (ctx, { channelId }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx.db.query("items", "by_channel") as any).eq("channelId", channelId).where("gt", "n", 0).collect(),
  }),
};

const api = anyApi as {
  items: {
    add: { __path: string };
    setN: { __path: string };
    del: { __path: string };
    list: { __path: string };
    listGt: { __path: string };
  };
};

async function startItemsServer(): Promise<{ server: DevServer; runtime: EmbeddedRuntime; wsUrl: string }> {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const project = loadProject({ schema: itemsSchema, modules: { items: itemsModule } });
  const runtime = await createEmbeddedRuntime({ store, catalog: project.catalog, modules: project.moduleMap, tableNumbers: project.tableNumbers });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  return { server, runtime, wsUrl: `ws://127.0.0.1:${server.port}/api/sync` };
}

describe("DLR 2b E2E — range QueryDiff round-trip through the real dev server", () => {
  it("(1)(2)(3)(4) initial range reset, incremental add/edit/remove — all via QueryDiff, correctly ordered", async () => {
    const { server, runtime } = await startItemsServer();
    const recorded = recordingTransport(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }));
    const client = new HelipodClient(recorded.transport);
    try {
      // Seed 2 rows in channel "c" BEFORE subscribing, so the first frame is a range reset.
      const id1 = (await client.mutation(api.items.add, { channelId: "c", n: 1 })) as string;
      const id2 = (await client.mutation(api.items.add, { channelId: "c", n: 2 })) as string;

      const frames: ItemDoc[][] = [];
      const beforeSub = recorded.inbound.length;
      client.subscribe(api.items.list, { channelId: "c" }, (val) => frames.push(val as ItemDoc[]));
      await waitFor(() => frames.length >= 1, 5000, "initial list");

      // --- (1) initial answer: ordered 2-element array, delivered via a range QueryDiff reset ---
      expect(frames.at(-1)?.map((d) => d._id)).toEqual([id1, id2]); // insertion order (equal channelId key)
      const afterSub = recorded.inbound.slice(beforeSub);
      const resetDiffs = allMods(afterSub, "QueryDiff").filter(
        (m) => (m.reset as { mode?: string } | undefined)?.mode === "range",
      );
      expect(resetDiffs.length).toBeGreaterThan(0);
      expect(anyMod(afterSub, "QueryUpdated")).toBe(false);

      // --- (2) add a 3rd row: incremental QueryDiff `add`, correctly ordered at the tail ---
      const beforeAdd = recorded.inbound.length;
      const id3 = (await client.mutation(api.items.add, { channelId: "c", n: 3 })) as string;
      await waitFor(() => frames.at(-1)?.length === 3, 5000, "add fanout");
      expect(frames.at(-1)?.map((d) => d._id)).toEqual([id1, id2, id3]);
      const afterAdd = recorded.inbound.slice(beforeAdd);
      expect(anyMod(afterAdd, "QueryDiff")).toBe(true);
      expect(anyMod(afterAdd, "QueryUpdated")).toBe(false);
      const addChanges = afterAdd.flatMap((m) =>
        mods(m)
          .filter((mod) => mod.type === "QueryDiff")
          .flatMap((mod) => (mod as unknown as { changes: Array<{ t: string }> }).changes ?? []),
      );
      expect(addChanges.some((c) => c.t === "add")).toBe(true);

      // --- (3) in-place edit: QueryDiff edit, array updates in place (order unchanged) ---
      const beforeEdit = recorded.inbound.length;
      await client.mutation(api.items.setN, { id: id2, n: 99 });
      await waitFor(() => frames.at(-1)?.find((d) => d._id === id2)?.n === 99, 5000, "edit fanout");
      expect(frames.at(-1)?.map((d) => d._id)).toEqual([id1, id2, id3]);
      const afterEdit = recorded.inbound.slice(beforeEdit);
      expect(anyMod(afterEdit, "QueryDiff")).toBe(true);
      expect(anyMod(afterEdit, "QueryUpdated")).toBe(false);
      const editChanges = afterEdit.flatMap((m) =>
        mods(m)
          .filter((mod) => mod.type === "QueryDiff")
          .flatMap((mod) => (mod as unknown as { changes: Array<{ t: string }> }).changes ?? []),
      );
      expect(editChanges.some((c) => c.t === "edit")).toBe(true);

      // --- (4) delete: QueryDiff remove, row disappears, remaining order intact ---
      const beforeDel = recorded.inbound.length;
      await client.mutation(api.items.del, { id: id1 });
      await waitFor(() => frames.at(-1)?.length === 2, 5000, "delete fanout");
      expect(frames.at(-1)?.map((d) => d._id)).toEqual([id2, id3]);
      const afterDel = recorded.inbound.slice(beforeDel);
      expect(anyMod(afterDel, "QueryDiff")).toBe(true);
      expect(anyMod(afterDel, "QueryUpdated")).toBe(false);
      const delChanges = afterDel.flatMap((m) =>
        mods(m)
          .filter((mod) => mod.type === "QueryDiff")
          .flatMap((mod) => (mod as unknown as { changes: Array<{ t: string }> }).changes ?? []),
      );
      expect(delChanges.some((c) => c.t === "remove")).toBe(true);
    } finally {
      client.close();
      void runtime;
      await server.close();
    }
  });

  it("(5) a .where()-filtered subscription never surfaces a row that fails the filter", async () => {
    const { server, runtime } = await startItemsServer();
    const recorded = recordingTransport(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }));
    const client = new HelipodClient(recorded.transport);
    try {
      // Seed one row that PASSES the filter (n > 0) so the sub starts non-empty and provably alive.
      const passId = (await client.mutation(api.items.add, { channelId: "c", n: 5 })) as string;

      const frames: ItemDoc[][] = [];
      client.subscribe(api.items.listGt, { channelId: "c" }, (val) => frames.push(val as ItemDoc[]));
      await waitFor(() => frames.length >= 1 && (frames.at(-1)?.length ?? 0) >= 1, 5000, "initial listGt");
      expect(frames.at(-1)?.map((d) => d._id)).toEqual([passId]);

      // Write a row with n = 0 — it must NOT surface in this filtered subscription's array, and no
      // spurious `add` change for its id should reach the sub at all.
      const beforeExcluded = recorded.inbound.length;
      const excludedId = (await client.mutation(api.items.add, { channelId: "c", n: 0 })) as string;

      // Give the fan-out a beat to (not) arrive, then assert steady state.
      await new Promise<void>((r) => setTimeout(r, 200));
      expect(frames.at(-1)?.map((d) => d._id)).toEqual([passId]);
      expect(frames.every((f) => !f.some((d) => d._id === excludedId))).toBe(true);

      const afterExcluded = recorded.inbound.slice(beforeExcluded);
      const excludedAdds = afterExcluded.flatMap((m) =>
        mods(m)
          .filter((mod) => mod.type === "QueryDiff")
          .flatMap((mod) => (mod as unknown as { changes: Array<{ t: string; key?: string }> }).changes ?? [])
          .filter((c) => c.t === "add" && c.key === excludedId),
      );
      expect(excludedAdds.length).toBe(0);

      // Sanity: a row that DOES pass the filter still fans out normally on this same subscription.
      const passId2 = (await client.mutation(api.items.add, { channelId: "c", n: 7 })) as string;
      await waitFor(() => frames.at(-1)?.some((d) => d._id === passId2) ?? false, 5000, "second pass fanout");
      expect(frames.at(-1)?.map((d) => d._id).sort()).toEqual([passId, passId2].sort());
    } finally {
      client.close();
      void runtime;
      await server.close();
    }
  });

  it("(6) a corrupted diff checksum triggers a scoped resync and recovers the correct array", async () => {
    const { server, runtime } = await startItemsServer();
    const recorded = recordingTransport(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }), {
      corruptFirstDiffChecksum: true,
    });
    const client = new HelipodClient(recorded.transport);
    try {
      const id1 = (await client.mutation(api.items.add, { channelId: "c", n: 1 })) as string;
      const id2 = (await client.mutation(api.items.add, { channelId: "c", n: 2 })) as string;

      const frames: ItemDoc[][] = [];
      const beforeSub = recorded.outbound.length;
      client.subscribe(api.items.list, { channelId: "c" }, (val) => frames.push(val as ItemDoc[]));
      // The client applies the (correct) reset, detects the wrong checksum, and resyncs.
      await waitFor(() => (frames.at(-1)?.length ?? 0) === 2, 5000, "value materialized");
      expect(frames.at(-1)?.map((d) => d._id)).toEqual([id1, id2]);
      // A resync ModifyQuerySet was sent AFTER the initial subscribe in response to the drift.
      await waitFor(
        () => recorded.outbound.slice(beforeSub).filter((m) => m.type === "ModifyQuerySet").length >= 2,
        5000,
        "resync sent",
      );
      // And after recovery the array is still correct (the fresh reset re-confirmed it).
      expect(frames.at(-1)?.map((d) => d._id)).toEqual([id1, id2]);
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

      const frames: ItemDoc[][] = [];
      const beforeSub = recorded.inbound.length;
      client.subscribe(api.items.list, { channelId: "c" }, (val) => frames.push(val as ItemDoc[]));
      await waitFor(() => (frames.at(-1)?.length ?? 0) === 1, 5000, "initial list (RERUN)");
      expect(frames.at(-1)?.map((d) => d._id)).toEqual([id1]);

      const id2 = (await client.mutation(api.items.add, { channelId: "c", n: 2 })) as string;
      await waitFor(() => (frames.at(-1)?.length ?? 0) === 2, 5000, "add (RERUN) fanout");
      expect(frames.at(-1)?.map((d) => d._id)).toEqual([id1, id2]);

      // The whole session used the RERUN path: QueryUpdated on both subscribe and write, never a QueryDiff.
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
