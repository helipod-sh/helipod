/**
 * fsOutbox E2E — the Node/Electron twin of the browser flagship (outbox-e2e.test.ts 1a):
 * offline → process exit → fresh process → exactly-once drain, with the durable queue on the
 * FILESYSTEM (fsOutbox) instead of IndexedDB. Session 1 = a real StackbaseClient over a real
 * WebSocket whose transport never connects (pointed at a dead port — the server for this run
 * doesn't exist yet), enqueueing K mutations into a tmpdir journal; `close()` releases the dir
 * lock. Session 2 = a genuinely fresh client + fresh fsOutbox on the SAME dir against a now-
 * running real dev server: hydrate → Connect/ConnectAck → drain → exactly K rows committed,
 * pendingMutations() empty. The reload-fidelity model documented at outbox-e2e.test.ts:13-22
 * applies verbatim, with the tmpdir playing the role the shared IDBFactory played (two fsOutbox
 * instances over one dir, with `close()` between = a faithful process restart).
 *
 * Unlike the flagship (which primes an online mutation first so the reconnect handshake sees a
 * RECOGNIZED timeline), session 1 here deliberately never touches a live server at all —
 * "durability BEFORE the server ever existed" — so the journal assertion is provable independent
 * of any server. That makes session 2's first `ConnectAck` come back `known: false` (the server
 * recognizes nothing), which exercises the `onClientReset` path for hydrated entries: every one
 * was always `unsent` (never sent, never applied), so the reset safely re-enqueues them under a
 * fresh clientId and the drain commits them exactly once. This doubles as the regression test for
 * the reset-path bug this E2E originally found: the durable dequeue of a hydrated entry must
 * target the entry's RECORDED clientId (the prior session's), not the current session's.
 */
import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, type ClientTransport, type ClientResetInfo } from "@stackbase/client";
import { fsOutbox } from "@stackbase/client/outbox-fs";
import { loadProject, startDevServer, type DevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixture app — a keyed write + a list query (mirrors outbox-e2e.test.ts)     */
/* -------------------------------------------------------------------------- */

const schema = defineSchema({
  notes: defineTable({ box: v.string(), text: v.string() }).index("by_box", ["box"]),
});

const notesModule = {
  add: mutation<{ box: string; text: string }, string>({
    handler: (ctx, { box, text }) => ctx.db.insert("notes", { box, text }),
  }),
  list: query<{ box: string }, unknown[]>({
    handler: (ctx, { box }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx.db.query("notes", "by_box") as any).eq("box", box).collect(),
  }),
};

function loaded() {
  return { schema, modules: { notes: notesModule } };
}

async function startServer(): Promise<{ runtime: EmbeddedRuntime; server: DevServer; port: number }> {
  const project = loadProject(loaded());
  const runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  return { runtime, server, port: server.port };
}

/* -------------------------------------------------------------------------- */
/* Helpers (copied from outbox-e2e.test.ts)                                    */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await sleep(15);
  }
}

function wsUrlFor(port: number): string {
  return `ws://127.0.0.1:${port}/api/sync`;
}

/** A `webSocketTransport` over `ws` (Node has no global WebSocket in this runtime). */
function nodeWsTransport(url: string): ClientTransport {
  return webSocketTransport(url, {
    initialBackoffMs: 40,
    maxBackoffMs: 120,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createWebSocket: (u) => new WebSocket(u) as unknown as any,
  });
}

/** Allocate a free TCP port and release it immediately — nothing is listening there, so a
 *  transport pointed at it fails fast with ECONNREFUSED (the "server doesn't exist yet" state). */
function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") srv.close(() => resolvePromise(addr.port));
      else srv.close(() => reject(new Error("could not allocate a port")));
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Scenario — offline (no server yet) → process exit → fresh process → exactly-once */
/* -------------------------------------------------------------------------- */

describe("fsOutbox client E2E — the Node/Electron twin of the flagship: offline (no server) → process exit → fresh process → exactly-once", () => {
  it("K=6 mutations enqueued to a filesystem journal before any server exists drain exactly-once through a fresh process's client", async () => {
    const K = 6;
    const dir = mkdtempSync(join(tmpdir(), "sb-outbox-fs-e2e-"));
    const journalPath = join(dir, "journal.jsonl");
    const lockPath = join(dir, "lock");

    let client1: StackbaseClient | undefined;
    let client2: StackbaseClient | undefined;
    let server: DevServer | undefined;
    try {
      /* ---- Session 1: a client whose transport points at a dead port — the server for this
       * run has never been started. Every mutation durably enqueues to the filesystem journal
       * regardless — durability is unconditional on connection state. ---- */
      const deadPort = await freePort();
      const outbox1 = fsOutbox({ dir });
      client1 = new StackbaseClient(nodeWsTransport(wsUrlFor(deadPort)), {
        outbox: outbox1,
        outboxLocks: null, // single-tab leader
        outboxDrainIntervalMs: 0,
      });

      // Let the dead-port connection attempt fail and its close propagate, so each entry below
      // lands cleanly `unsent` (never a fleeting `inflight` against a socket that never opened).
      await sleep(300);

      const offlinePromises: Array<Promise<unknown>> = [];
      for (let i = 0; i < K; i++) {
        offlinePromises.push(client1.mutation("notes:add", { box: "offline", text: `m${i}` }));
      }
      // Session 1 never connects, so these promises never settle from here — their fate is
      // carried forward durably (the journal), not by these JS promises.
      for (const p of offlinePromises) void p.catch(() => {});

      // The enqueues settle at the storage level: all K are durable, BEFORE any server has ever
      // existed in this test.
      await waitFor(async () => (await outbox1.loadAll()).entries.length === K, 5000, "K durable");
      expect(server).toBeUndefined(); // the server literally does not exist yet at this point

      // The journal itself holds exactly K append ops — the raw on-disk durability proof.
      const raw = readFileSync(journalPath, "utf8");
      const appendLines = raw.split("\n").filter((line) => line.includes('"op":"append"'));
      expect(appendLines).toHaveLength(K);

      /* ---- "process exit": tear down session 1 and release the dir lock ---- */
      client1.close();
      await outbox1.close?.();
      expect(existsSync(lockPath)).toBe(false); // the lock is released once outbox1 closes

      /* ---- Now the real server comes up — session 2's target ---- */
      ({ server } = await startServer());

      /* ---- Session 2: a genuinely fresh client + fresh fsOutbox on the SAME dir, against the
       * now-running real server. Hydrate replays the K journaled entries; the drain sends them. */
      const resets: ClientResetInfo[] = [];
      const outbox2 = fsOutbox({ dir });
      client2 = new StackbaseClient(nodeWsTransport(wsUrlFor(server.port)), {
        outbox: outbox2,
        outboxLocks: null,
        outboxDrainIntervalMs: 0,
        onClientReset: (info) => resets.push(info),
      });

      // Connect/ConnectAck arms the S4 swap; the never-seen timeline classifies `known: false`
      // (the server has no receipts for session 1), so the K hydrated `unsent` entries re-enqueue
      // under a fresh clientId — always safe for never-sent entries — and the drain flushes them.
      await waitFor(() => client2!.__outboxArmed, 15_000, "session-2 arm");
      await waitFor(async () => (await client2!.pendingMutations()).length === 0, 20_000, "pending K→0");
      expect(await client2.pendingMutations()).toHaveLength(0);
      expect((await outbox2.loadAll()).entries).toHaveLength(0);
      expect(resets).toHaveLength(1);
      expect(resets[0]!.unsentReEnqueued).toBe(K);
      expect(resets[0]!.parkedRejected).toBe(0);

      // EXACTLY-ONCE: exactly K rows landed server-side, in the offline enqueue order (the FIFO
      // drain preserves order across the re-enqueue).
      const rows = (await client2.query("notes:list", { box: "offline" })) as Array<{ text: string }>;
      expect(rows).toHaveLength(K);
      expect(rows.map((r) => r.text)).toEqual(Array.from({ length: K }, (_, i) => `m${i}`));

      client2.close();
      await outbox2.close?.();
      expect(existsSync(lockPath)).toBe(false); // the lock is gone again after session 2 closes
    } finally {
      client1?.close();
      client2?.close();
      await server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
