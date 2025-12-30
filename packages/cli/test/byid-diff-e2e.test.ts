/**
 * DLR Stage 2a Task 7 — the by-id `QueryDiff` round-trip, proven end-to-end through a REAL
 * `stackbase dev` server over a REAL WebSocket with a REAL `@stackbase/client`.
 *
 * What this pins that the unit tests (Task 1/3/5/6) cannot:
 *  (1) A `db.get(id)` subscription's INITIAL answer is a `QueryDiff` reset (not `QueryUpdated`) and
 *      the client materializes the doc from it — the whole classify → carry-written-docs → differ →
 *      wire → materialized-cache pipeline firing at once.
 *  (2) A subsequent `notes:set` write arrives as an incremental `QueryDiff` edit (zero store re-read
 *      on the server), and the client renders the new value.
 *  (3) Checksum self-heal: a corrupted-in-transit diff checksum makes the client detect drift and
 *      scoped-resync, recovering the correct value — the drift → `onDrift` → `resync()` wiring E2E.
 *  (4) Old-client back-compat: a client that never advertises `supportsQueryDiff` gets `QueryUpdated`
 *      (the RERUN path), never a `QueryDiff`.
 */
import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi, type ClientTransport } from "@stackbase/client";
import type { ServerMessage } from "@stackbase/sync";
import { loadProject, startDevServer, type DevServer } from "../src/index";

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

/** Modifications carried by a message (empty for non-Transitions). */
function mods(m: ServerMessage): Array<{ type: string }> {
  return m.type === "Transition" ? m.modifications : [];
}
/** True if any message in `inbound` carries a modification of `type`. */
function anyMod(inbound: ServerMessage[], type: string): boolean {
  return inbound.some((m) => mods(m).some((mod) => mod.type === type));
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

const notesSchema = defineSchema({
  notes: defineTable({ n: v.number() }),
});
const notesModule = {
  create: mutation<{ n: number }, string>({
    handler: (ctx, { n }) => ctx.db.insert("notes", { n }),
  }),
  get: query<{ id: string }, unknown>({
    handler: (ctx, { id }) => ctx.db.get(id as never),
  }),
  set: mutation<{ id: string; n: number }, null>({
    handler: async (ctx, { id, n }) => {
      await ctx.db.replace(id as never, { n });
      return null;
    },
  }),
};

const api = anyApi as {
  notes: { create: { __path: string }; get: { __path: string }; set: { __path: string } };
};

async function startNotesServer(): Promise<{ server: DevServer; runtime: EmbeddedRuntime; wsUrl: string }> {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const project = loadProject({ schema: notesSchema, modules: { notes: notesModule } });
  const runtime = await createEmbeddedRuntime({ store, catalog: project.catalog, modules: project.moduleMap, tableNumbers: project.tableNumbers });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  return { server, runtime, wsUrl: `ws://127.0.0.1:${server.port}/api/sync` };
}

describe("DLR 2a E2E — by-id QueryDiff round-trip through the real dev server", () => {
  it("(1) initial subscribe is a QueryDiff reset and (2) a write arrives as a QueryDiff edit", async () => {
    const { server, runtime } = await startNotesServer();
    const recorded = recordingTransport(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }));
    const client = new StackbaseClient(recorded.transport);
    try {
      // Create the doc first so the subscribe's reset carries it (an `add`).
      const id = (await client.mutation(api.notes.create, { n: 1 })) as string;
      expect(typeof id).toBe("string");

      const frames: Array<{ n: number } | undefined> = [];
      const beforeSub = recorded.inbound.length;
      client.subscribe(api.notes.get, { id }, (val) => frames.push(val as { n: number }));
      await waitFor(() => frames.length >= 1, 5000, "initial get");
      expect(frames.at(-1)).toMatchObject({ n: 1 });

      // (1) The initial answer for a by-id sub is a QueryDiff reset — NOT a QueryUpdated.
      const afterSub = recorded.inbound.slice(beforeSub);
      expect(anyMod(afterSub, "QueryDiff")).toBe(true);
      expect(anyMod(afterSub, "QueryUpdated")).toBe(false);

      // (2) A subsequent write fans out as an incremental QueryDiff edit.
      const beforeSet = recorded.inbound.length;
      await client.mutation(api.notes.set, { id, n: 2 });
      await waitFor(() => frames.some((f) => f?.n === 2), 5000, "edit fanout");
      const afterSet = recorded.inbound.slice(beforeSet);
      expect(anyMod(afterSet, "QueryDiff")).toBe(true);
      expect(anyMod(afterSet, "QueryUpdated")).toBe(false);
    } finally {
      client.close();
      void runtime;
      await server.close();
    }
  });

  it("(3) a corrupted diff checksum triggers a scoped resync and recovers the correct value", async () => {
    const { server, runtime } = await startNotesServer();
    const recorded = recordingTransport(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }), {
      corruptFirstDiffChecksum: true,
    });
    const client = new StackbaseClient(recorded.transport);
    try {
      const id = (await client.mutation(api.notes.create, { n: 7 })) as string;

      const frames: Array<{ n: number } | undefined> = [];
      const beforeSub = recorded.outbound.length;
      client.subscribe(api.notes.get, { id }, (val) => frames.push(val as { n: number }));
      // The client applies the (correct) reset, detects the wrong checksum, and resyncs.
      await waitFor(() => frames.at(-1)?.n === 7, 5000, "value materialized");
      // A resync ModifyQuerySet was sent AFTER the initial subscribe in response to the drift.
      await waitFor(
        () => recorded.outbound.slice(beforeSub).filter((m) => m.type === "ModifyQuerySet").length >= 2,
        5000,
        "resync sent",
      );
      // And after recovery the value is still correct (the fresh reset re-confirmed it).
      expect(frames.at(-1)).toMatchObject({ n: 7 });
    } finally {
      client.close();
      void runtime;
      await server.close();
    }
  });

  it("(4) an old client that never advertises supportsQueryDiff gets QueryUpdated, never QueryDiff", async () => {
    const { server, runtime } = await startNotesServer();
    const recorded = recordingTransport(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }), {
      stripConnect: true,
    });
    const client = new StackbaseClient(recorded.transport);
    try {
      const id = (await client.mutation(api.notes.create, { n: 1 })) as string;

      const frames: Array<{ n: number } | undefined> = [];
      const beforeSub = recorded.inbound.length;
      client.subscribe(api.notes.get, { id }, (val) => frames.push(val as { n: number }));
      await waitFor(() => frames.at(-1)?.n === 1, 5000, "initial get (RERUN)");

      const beforeSet = recorded.inbound.length;
      await client.mutation(api.notes.set, { id, n: 2 });
      await waitFor(() => frames.some((f) => f?.n === 2), 5000, "edit (RERUN) fanout");

      // The whole session used the RERUN path: QueryUpdated on both subscribe and write, never a QueryDiff.
      const all = recorded.inbound.slice(beforeSub);
      expect(anyMod(all, "QueryUpdated")).toBe(true);
      expect(anyMod(all, "QueryDiff")).toBe(false);
      void beforeSet;
    } finally {
      client.close();
      void runtime;
      await server.close();
    }
  });
});
