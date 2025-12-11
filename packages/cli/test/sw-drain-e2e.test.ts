/**
 * Task 4 (browser-ux Part B, spec Testing §4) — the headless drain E2E: `drainOutboxOnce` (no
 * `StackbaseClient`, no UI) draining a durable outbox against a REAL `stackbase dev` server.
 *
 * Mirrors the reload-fidelity model `outbox-e2e.test.ts:13-22` documents: a single `IDBFactory`
 * shared across a seeding `StackbaseClient` and the headless drain is the faithful analog of a real
 * browser reload / a Service Worker `sync` event firing after the tab that queued the work is gone.
 * Session 1 (a normal `StackbaseClient`) seeds mutations OFFLINE — pointed at a dead port that never
 * accepts a connection, so every mutation lands durably `unsent` without ever touching the real
 * server (the same "durability unconditional on connection state" trick `outbox-fs-e2e.test.ts`
 * uses for its journal, applied here to IndexedDB) — then `close()`s (the "reload" boundary).
 * `drainOutboxOnce` then plays the Service Worker's role: no client, just the store + the real
 * `OutboxDrain` state machine, against the now-real server.
 *
 * Scenarios (task-4-brief.md / spec Testing §4):
 *   (1) K=4 offline mutations drain exactly-once: `{drained: 4, failed: 0, remaining: 0}`.
 *   (2) a second `drainOutboxOnce` call on the now-empty durable queue is an idempotent no-op:
 *       `{drained: 0, failed: 0, remaining: 0}` — no duplicate rows.
 *   (3) a poison entry (a coded, non-retryable `StackbaseError` throw) is counted in `failed`; the
 *       queue continues past it under the default `poisonPolicy: "skip"` (the OTHER offline entries
 *       still commit, in FIFO order).
 *   (4) an injected held lock (`OutboxLockManager` whose `ifAvailable` probe yields `null`, mimicking
 *       a live tab already draining) short-circuits to an immediate no-op — the transport is never
 *       touched, the durable queue stays intact.
 */
import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import WebSocket from "ws";
import { IDBFactory } from "fake-indexeddb";
import { v, defineSchema, defineTable, type Value } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { DocumentValidationError } from "@stackbase/errors";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import {
  StackbaseClient,
  webSocketTransport,
  indexedDBOutbox,
  memoryOutbox,
  drainOutboxOnce,
  type ClientTransport,
  type OutboxLockManager,
} from "@stackbase/client";
import { loadProject, startDevServer, type DevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixture app — a keyed write, a list query, and a deliberately poisoned one   */
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
  // A deliberate poison unit (scenario 3): a coded, NON-retryable `StackbaseError` throw so the wire
  // response carries `.code` (`DOCUMENT_VALIDATION`) — the outbox drain's "coded terminal failure"
  // path (settle-and-continue under the default `poisonPolicy: "skip"`), never its "codeless" path
  // (which the drain instead treats as transient and retries forever under backoff — a plain
  // non-`StackbaseError` throw never gets `.code` threaded onto a FRESH response, per
  // `packages/sync/src/handler.ts#processMutation`'s doc comment, so it would hang this test).
  poison: mutation<{ box: string; text: string }, string>({
    handler: () => {
      throw new DocumentValidationError("intentional poison: always fails");
    },
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
/* Helpers (mirrors outbox-e2e.test.ts / outbox-fs-e2e.test.ts)                */
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

/** Allocate a free TCP port and release it immediately — nothing is listening there, so a transport
 *  pointed at it fails fast (ECONNREFUSED) and stays offline: the seeding client's mutations land
 *  durably `unsent` without ever reaching a real server (mirrors `outbox-fs-e2e.test.ts`'s "the
 *  server for this run has never been started" seeding trick, applied to IndexedDB instead of a
 *  filesystem journal). */
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

/** Seed `mutations` offline via a normal `StackbaseClient` pointed at a dead port, over the given
 *  IDB factory, then `close()` it (the "reload" boundary) — the durable queue this leaves behind is
 *  exactly what a Service Worker would find on disk with no live tab around. */
async function seedOffline(idb: IDBFactory, mutations: Array<{ udfPath: string; args: Record<string, Value> }>): Promise<void> {
  const deadPort = await freePort();
  const outbox = indexedDBOutbox({ indexedDB: idb });
  const client = new StackbaseClient(nodeWsTransport(wsUrlFor(deadPort)), {
    outbox,
    outboxLocks: null,
    outboxDrainIntervalMs: 0,
  });
  try {
    // Let the dead-port connection attempt fail and its close propagate, so each entry below lands
    // cleanly `unsent` (never a fleeting `inflight` against a socket that never opened).
    await sleep(300);
    const promises: Array<Promise<unknown>> = [];
    for (const m of mutations) promises.push(client.mutation(m.udfPath, m.args));
    // This session never connects, so these promises never settle from here — their fate is carried
    // forward durably (the IDB queue), not by these JS promises.
    for (const p of promises) void p.catch(() => {});
    await waitFor(async () => (await outbox.loadAll()).entries.length === mutations.length, 5000, "seed durable");
  } finally {
    client.close();
  }
}

/** A one-off live query against the real server, reading straight through a throwaway client (no
 *  outbox drain involved — just `.query()`). */
async function listNotes(port: number, box: string): Promise<Array<{ text: string }>> {
  const reader = new StackbaseClient(nodeWsTransport(wsUrlFor(port)), {
    outbox: memoryOutbox(),
    outboxLocks: null,
    outboxDrainIntervalMs: 0,
  });
  try {
    return (await reader.query("notes:list", { box })) as Array<{ text: string }>;
  } finally {
    reader.close();
  }
}

/** Mimics the real Web Locks `ifAvailable` contract: the callback is invoked with `null` when the
 *  lock cannot be granted immediately (never queued, never blocks) — a live tab already draining. */
class LockHeldFake implements OutboxLockManager {
  async request(_name: string, options: { ifAvailable?: boolean }, callback: () => Promise<unknown>): Promise<unknown> {
    if (options.ifAvailable) {
      return (callback as unknown as (lock: null) => Promise<unknown>)(null);
    }
    return callback();
  }
}

/* -------------------------------------------------------------------------- */
/* Scenarios (1) + (2) — exactly-once drain, then an idempotent repeat call    */
/* -------------------------------------------------------------------------- */

describe("headless drain E2E (1+2) — drainOutboxOnce against the real server: exactly-once, then an idempotent repeat", () => {
  it("drains K=4 offline mutations exactly-once, then a second call on the drained queue is a clean no-op", async () => {
    const K = 4;
    const idb = new IDBFactory();
    const { server, port } = await startServer();
    try {
      await seedOffline(
        idb,
        Array.from({ length: K }, (_, i) => ({ udfPath: "notes:add", args: { box: "headless", text: `m${i}` } })),
      );

      const result1 = await drainOutboxOnce({
        url: wsUrlFor(port),
        outbox: indexedDBOutbox({ indexedDB: idb }),
        locks: null,
      });
      expect(result1).toEqual({ drained: K, failed: 0, remaining: 0 });

      // Exactly-once, in offline enqueue order — no client-side promises, no live subscription,
      // just the rows the drain's own MutationBatch committed server-side.
      const rows = await listNotes(port, "headless");
      expect(rows).toHaveLength(K);
      expect(rows.map((r) => r.text)).toEqual(Array.from({ length: K }, (_, i) => `m${i}`));

      // Scenario (2): the durable queue is now empty — a fresh `drainOutboxOnce` call over the SAME
      // IDB factory (a fresh Service Worker `sync` event, or a retried Background Sync) is a clean,
      // idempotent no-op: nothing to drain, nothing new committed.
      const result2 = await drainOutboxOnce({
        url: wsUrlFor(port),
        outbox: indexedDBOutbox({ indexedDB: idb }),
        locks: null,
      });
      expect(result2).toEqual({ drained: 0, failed: 0, remaining: 0 });

      const rowsAfter = await listNotes(port, "headless");
      expect(rowsAfter).toHaveLength(K); // no duplicate from the repeat call
    } finally {
      await server.close();
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario (3) — a poison entry: counted in `failed`, the queue continues     */
/* -------------------------------------------------------------------------- */

describe("headless drain E2E (3) — a poison entry terminal-fails and is counted, while the queue continues past it", () => {
  it("drains the surrounding successful mutations while the poisoned one settles as `failed`", async () => {
    const idb = new IDBFactory();
    const { server, port } = await startServer();
    try {
      await seedOffline(idb, [
        { udfPath: "notes:add", args: { box: "poison", text: "a" } },
        { udfPath: "notes:poison", args: { box: "poison", text: "x" } },
        { udfPath: "notes:add", args: { box: "poison", text: "b" } },
        { udfPath: "notes:add", args: { box: "poison", text: "c" } },
      ]);

      const drainOutbox = indexedDBOutbox({ indexedDB: idb });
      const result = await drainOutboxOnce({ url: wsUrlFor(port), outbox: drainOutbox, locks: null });
      expect(result).toEqual({ drained: 3, failed: 1, remaining: 0 });

      // The three genuine writes committed, in FIFO order, straddling the poisoned unit.
      const rows = await listNotes(port, "poison");
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.text)).toEqual(["a", "b", "c"]);

      // The poisoned row persists durably as `failed` (never silently dropped) with its coded error.
      const remaining = (await drainOutbox.loadAll()).entries;
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatchObject({
        udfPath: "notes:poison",
        status: "failed",
        error: { code: "DOCUMENT_VALIDATION" },
      });
    } finally {
      await server.close();
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario (4) — an injected held lock short-circuits to an immediate no-op   */
/* -------------------------------------------------------------------------- */

describe("headless drain E2E (4) — a live tab already holds the lock: an immediate no-op, queue intact", () => {
  it("returns immediately with the queue untouched and never commits anything server-side", async () => {
    const K = 3;
    const idb = new IDBFactory();
    const { server, port } = await startServer();
    try {
      await seedOffline(
        idb,
        Array.from({ length: K }, (_, i) => ({ udfPath: "notes:add", args: { box: "locked", text: `L${i}` } })),
      );

      const drainOutbox = indexedDBOutbox({ indexedDB: idb });
      const result = await drainOutboxOnce({
        url: wsUrlFor(port),
        outbox: drainOutbox,
        locks: new LockHeldFake(),
      });
      expect(result).toEqual({ drained: 0, failed: 0, remaining: K });

      // Nothing was ever sent — the durable queue is untouched (still K, still `unsent`).
      const stillQueued = (await drainOutbox.loadAll()).entries;
      expect(stillQueued).toHaveLength(K);
      expect(stillQueued.every((e) => e.status === "unsent")).toBe(true);

      // And, decisively, no row ever landed server-side.
      const rows = await listNotes(port, "locked");
      expect(rows).toHaveLength(0);
    } finally {
      await server.close();
    }
  }, 60_000);
});
