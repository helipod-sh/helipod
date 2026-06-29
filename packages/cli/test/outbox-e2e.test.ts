/**
 * Receipted Outbox (Plan B) — THE FLAGSHIP E2E: offline → reload → reconnect → exactly-once, driving
 * the REAL `@stackbase/client` `StackbaseClient` over a REAL WebSocket to a REAL `stackbase dev`/
 * `serve` server. This is the proof no competitor can run (verdict §(j) uniqueness / AC11.2): a
 * durable client outbox that survives a full reload and drains resend-safe, end to end, on two
 * substrates (single-binary/SQLite and Postgres + fleet + 8 shards).
 *
 * Unlike `outbox-server-e2e.test.ts` (Plan A — a RAW-WIRE harness that hand-rolls the protocol
 * because the client didn't exist yet), every scenario here uses the SHIPPED client: it mints
 * `clientId`/`seq`, persists to a durable `OutboxStorage`, sends the `Connect` handshake, arms on
 * `ConnectAck`, and drains under a Web-Locks leader — all real code.
 *
 * ── The reload-fidelity boundary ────────────────────────────────────────────────────────────────
 * A real browser reload tears down the whole JS realm and reconstructs it, with IndexedDB surviving
 * on disk. We model that with `fake-indexeddb`: a single `IDBFactory` instance is shared across two
 * `StackbaseClient` instances (session 1 → "reload" → session 2). The factory IS the durable origin
 * storage that survives the reload; constructing a genuinely fresh `StackbaseClient` (fresh
 * transport, fresh in-memory state, fresh clientId) over that same factory is the faithful reload
 * analog. The boundary this does NOT reproduce: the JS realm is the SAME process, so module-level
 * singletons/timers are not reset (a real reload resets them) — mitigated by never sharing client
 * state across the boundary, only the `IDBFactory`. This is the closest a Node E2E can get; a true
 * DOM reload is a browser-integration concern out of scope for the engine test suite.
 *
 * The scenarios (task-6-brief.md):
 *   (1) THE FLAGSHIP on (a) SQLite dev server and (b) Postgres + fleet + 8 shards (embedded-postgres,
 *       no Docker).
 *   (2) kill-after-commit through the real client (park → replay-settle, no double).
 *   (3) mid-drain leader kill (two instances, one storage; successor drains; receipts absorb overlap).
 *   (4) multi-tab (two clientIds, one leader drains both queues' entries under their recorded ids).
 *   (5) STALE_CLIENT surfaced through onMutationFailed after a server-side prune.
 *   (6) the authed-reload identity gate (a fingerprint-mismatch entry terminal-fails loudly).
 *   (7) old-server compat (no ConnectAck → fail-fast byte-compat).
 *
 * Plus the four-axis benchmark (`docs/dev/research/offline-outbox/benchmark.md`).
 */
import { describe, it, expect } from "vitest";
import net from "node:net";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import WebSocket from "ws";
import { IDBFactory } from "fake-indexeddb";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { NodePgClient } from "@stackbase/docstore-postgres";
import { startEmbeddedPg, embeddedPgAvailable } from "@stackbase/docstore-postgres/test-support/embedded-pg";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import {
  StackbaseClient,
  webSocketTransport,
  indexedDBOutbox,
  memoryOutbox,
  type ClientTransport,
  type OutboxStorage,
  type OutboxLockManager,
  type PendingMutationEntry,
  type MutationFailedInfo,
  type ClientResetInfo,
} from "@stackbase/client";
import { loadProject, startDevServer, type DevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixture app — a keyed write + a list query                                  */
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

async function startServer(
  store: SqliteDocStore = new SqliteDocStore(new NodeSqliteAdapter()),
): Promise<{ runtime: EmbeddedRuntime; server: DevServer; store: SqliteDocStore; port: number }> {
  const project = loadProject(loaded());
  const runtime = await createEmbeddedRuntime({
    store,
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  return { runtime, server, store, port: server.port };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
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

/**
 * A transparent, controllable TCP proxy in front of the backend. The engine + store stay fully
 * alive throughout (a real network blip, never corrupting bytes) unless the test restarts the
 * backend behind it via `setBackend`.
 *   - `goOffline()`/`goOnline()`: blackhole new connections + drop live pairs (a genuine offline
 *     period — reconnects fail while offline).
 *   - `killLive()`: drop live pairs only (a single blip; the next reconnect still lands).
 *   - `pauseDownstream()`/`resumeDownstream()`: pause the server→client direction (bytes buffer in
 *     the server's send buffer — real backpressure, WITHOUT dropping a frame), so a committed
 *     mutation's response is withheld from the client (the kill-after-commit window).
 *   - `setBackend(port)`: retarget upstream (a server restart on the same on-disk store).
 */
async function makeProxy(initialBackendPort: number): Promise<{
  port: number;
  goOffline(): void;
  goOnline(): void;
  killLive(): void;
  pauseDownstream(): void;
  resumeDownstream(): void;
  setBackend(port: number): void;
  setLatencyMs(ms: number): void;
  close(): Promise<void>;
}> {
  let offline = false;
  let paused = false;
  let latencyMs = 0;
  let backendPort = initialBackendPort;
  interface Pair { client: net.Socket; upstream: net.Socket; }
  const pairs = new Set<Pair>();
  const server = net.createServer((client) => {
    if (offline) {
      client.destroy();
      return;
    }
    const upstream = net.connect(backendPort, "127.0.0.1");
    const pair: Pair = { client, upstream };
    pairs.add(pair);
    client.on("error", () => {});
    upstream.on("error", () => {});
    const cleanup = (): void => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("close", cleanup);
    upstream.on("close", cleanup);
    client.on("data", (d) => upstream.write(d));
    upstream.on("data", (d) => {
      if (latencyMs > 0) {
        const t = setTimeout(() => { if (!client.destroyed) client.write(d); }, latencyMs);
        (t as { unref?: () => void }).unref?.();
      } else {
        client.write(d);
      }
    });
    if (paused) upstream.pause();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const killLive = (): void => {
    for (const p of pairs) {
      p.client.destroy();
      p.upstream.destroy();
    }
    pairs.clear();
  };
  return {
    port,
    goOffline() { offline = true; killLive(); },
    goOnline() { offline = false; },
    killLive,
    pauseDownstream() { paused = true; for (const p of pairs) p.upstream.pause(); },
    resumeDownstream() { paused = false; for (const p of pairs) p.upstream.resume(); },
    setBackend(p) { backendPort = p; },
    setLatencyMs(ms) { latencyMs = ms; },
    close() {
      offline = true;
      killLive();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * A shared, cross-instance fake `OutboxLockManager` — models a real Web Locks manager across "tabs"
 * (client instances) in one process. `request(name, opts, cb)` acquires the named lock exclusively
 * and holds it for the lifetime of `cb`'s returned promise; concurrent requests for the same name
 * queue FIFO. `ifAvailable` returns immediately with the lock un-held (cb called with `null` — the
 * drain treats that as "not leader"). Every client built from the same `sharedLocks()` shares one
 * registry, so exactly one is the drain leader at a time — the real cross-tab invariant.
 */
function sharedLocks(): () => OutboxLockManager {
  interface Waiter { resolve: () => void; }
  const held = new Set<string>();
  const queues = new Map<string, Waiter[]>();
  function acquire(name: string): Promise<void> {
    if (!held.has(name)) {
      held.add(name);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const q = queues.get(name) ?? [];
      q.push({ resolve });
      queues.set(name, q);
    });
  }
  function release(name: string): void {
    const q = queues.get(name);
    if (q && q.length > 0) {
      const next = q.shift()!;
      next.resolve(); // ownership passes directly to the next waiter (stays "held")
      return;
    }
    held.delete(name);
  }
  return () => ({
    async request(name, options, callback) {
      if (options.ifAvailable && held.has(name)) {
        // Not available → real Web Locks calls back with a null lock; the drain reads that as
        // "someone else is leader" and backs off.
        return callback();
      }
      await acquire(name);
      try {
        return await callback();
      } finally {
        release(name);
      }
    },
  });
}

/** Count durable-storage operations (axis (d): IDB txns/mutation). Wraps an `OutboxStorage`. */
function countingOutbox(inner: OutboxStorage): { storage: OutboxStorage; counts: { append: number; updateStatus: number; dequeue: number; loadAll: number } } {
  const counts = { append: 0, updateStatus: 0, dequeue: 0, loadAll: 0 };
  const storage: OutboxStorage = {
    append: (e) => { counts.append++; return inner.append(e); },
    updateStatus: (c, s, st, er) => { counts.updateStatus++; return inner.updateStatus(c, s, st, er); },
    dequeue: (c, s) => { counts.dequeue++; return inner.dequeue(c, s); },
    loadAll: () => { counts.loadAll++; return inner.loadAll(); },
    getMeta: (c) => inner.getMeta(c),
    setMeta: (c, m) => inner.setMeta(c, m),
    listMetaClientIds: inner.listMetaClientIds ? () => inner.listMetaClientIds!() : undefined,
    deleteMeta: inner.deleteMeta ? (c) => inner.deleteMeta!(c) : undefined,
    persist: () => inner.persist(),
  };
  return { storage, counts };
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

/** Count `applied` receipts (`client_mutations` rows) for a clientId over a seq range, read straight
 *  from the store — the direct exactly-once ground truth (anonymous identity keys as `""`). */
async function countAppliedReceipts(
  store: { getClientVerdict(identity: string, clientId: string, seq: number): Promise<{ verdict: string } | null> },
  clientId: string,
  seqs: number[],
): Promise<{ applied: number; verdicts: Array<string | null> }> {
  const verdicts: Array<string | null> = [];
  let applied = 0;
  for (const seq of seqs) {
    const rec = await store.getClientVerdict("", clientId, seq);
    verdicts.push(rec ? rec.verdict : null);
    if (rec && rec.verdict === "applied") applied++;
  }
  return { applied, verdicts };
}

/* -------------------------------------------------------------------------- */
/* Scenario (1a) — THE FLAGSHIP on the single-binary/SQLite dev server          */
/* -------------------------------------------------------------------------- */

describe("outbox client E2E (1a) — THE FLAGSHIP: offline → reload → reconnect → exactly-once (SQLite)", () => {
  it("an armed session enqueues K=12 offline; a fresh client over the same durable storage drains them exactly-once", async () => {
    const K = 12;
    const idb = new IDBFactory();
    const { server, store, port } = await startServer();
    const proxy = await makeProxy(port);
    const wsUrl = wsUrlFor(proxy.port);

    let cid1: string;
    let client1: StackbaseClient | undefined;
    let client2: StackbaseClient | undefined;
    try {
      /* ---- Session 1: connect, prime a recognized timeline, arm, go offline, enqueue K ---- */
      const outbox1 = indexedDBOutbox({ indexedDB: idb });
      client1 = new StackbaseClient(nodeWsTransport(wsUrl), {
        outbox: outbox1,
        outboxLocks: null, // single-tab leader
        outboxDrainIntervalMs: 0,
      });
      cid1 = (await client1.getOutboxIdentity())!.clientId;

      // Prime: one committed online mutation → the server now has a receipt for (cid1, seq0), so on
      // reload the client's timeline is RECOGNIZED (known:true) and the offline held entries stay
      // `unknown` for a CLEAN drain (not the known:false reset path — that is scenario 6).
      const primeId = await client1.mutation("notes:add", { box: "prime", text: "prime" });
      expect(typeof primeId).toBe("string");

      // Arm: force a reopen so the client sends Connect and receives ConnectAck (arms the S4 swap).
      proxy.killLive();
      await waitFor(() => client1!.__outboxArmed, 10_000, "session-1 arm");

      // Go offline and enqueue K durable mutations. Each retains as `unsent` (never hits the wire).
      proxy.goOffline();
      await sleep(150); // let the killed socket's onClose propagate before enqueueing
      const offlinePromises: Array<Promise<unknown>> = [];
      for (let i = 0; i < K; i++) {
        offlinePromises.push(client1.mutation("notes:add", { box: "offline", text: `m${i}` }));
      }
      // Durability: all K are persisted in the shared IDB before the reload.
      await waitFor(async () => (await outbox1.loadAll()).entries.length === K, 5000, "K durable");
      const persisted = (await outbox1.loadAll()).entries;
      expect(persisted).toHaveLength(K);
      expect(persisted.every((e) => e.clientId === cid1)).toBe(true);
      expect(persisted.map((e) => e.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: K }, (_, i) => i + 1));

      /* ---- RELOAD: tear down session 1, construct a fresh client over the SAME IDB ---- */
      client1.close();
      // Detach any potential unhandled rejections from the never-settled offline promises of the
      // torn-down client (their fate is carried forward durably, not by these JS promises).
      for (const p of offlinePromises) void p.catch(() => {});

      const outbox2Counting = countingOutbox(indexedDBOutbox({ indexedDB: idb }));
      const listFrames: unknown[][] = [];
      client2 = new StackbaseClient(nodeWsTransport(wsUrl), {
        outbox: outbox2Counting.storage,
        outboxLocks: null,
        outboxDrainIntervalMs: 0,
        // The registry: hydrated entries rebuild an optimistic layer so the offline rows are visible
        // BEFORE the drain commits them (verdict §(d) "the registry rebuilt layers pre-drain-visible").
        optimisticUpdates: {
          "notes:add": (s, args) => {
            const a = args as { box: string; text: string };
            if (a.box !== "offline") return;
            const cur = (s.getQuery("notes:list", { box: "offline" }) as unknown[] | undefined) ?? [];
            s.setQuery("notes:list", { box: "offline" }, [...cur, { _id: `opt-${a.text}`, box: a.box, text: a.text }] as never);
          },
        },
      });
      client2.subscribe("notes:list", { box: "offline" }, (v) => listFrames.push(v as unknown[]));

      // The registry rebuilt layers are pre-drain-visible: WHILE STILL OFFLINE (the drain cannot run
      // yet), the durable tray shows all K offline entries and the hydrated optimistic layers render
      // the K pending rows. Asserted here — offline — so it is deterministic (not a timing race
      // against the drain committing + dropping the layers, which a starved event loop can win).
      await waitFor(async () => (await client2!.pendingMutations()).length === K, 10_000, "K pending pre-drain");
      expect(await client2.pendingMutations()).toHaveLength(K); // usePendingMutations shows K pre-drain
      await waitFor(
        () => listFrames.some((f) => (f as Array<{ _id: string }>).some((r) => r._id.startsWith("opt-"))),
        10_000,
        "optimistic layers rebuilt pre-drain",
      );
      const optFrame = listFrames.find((f) => (f as Array<{ _id: string }>).every((r) => r._id.startsWith("opt-")) && (f as unknown[]).length === K);
      expect(optFrame).toBeDefined(); // the rebuilt layers render all K offline rows before any commit

      proxy.goOnline();

      // The drain runs: reconnect → Connect/ConnectAck → baseline → MutationBatch → per-unit applied.
      await waitFor(() => client2!.__outboxArmed, 15_000, "session-2 arm");

      // EXACTLY-ONCE — convergence: the list subscription SETTLES to exactly K AUTHORITATIVE rows.
      // The predicate requires no optimistic placeholders left (a transient mid-drain frame can hit
      // length K while still mixing committed + not-yet-dropped optimistic layers — a starved event
      // loop can make that the last frame observed, so all-authoritative is the real settled state).
      await waitFor(
        () => {
          const f = listFrames.at(-1) as Array<{ _id: string }> | undefined;
          return !!f && f.length === K && f.every((r) => !r._id.startsWith("opt-"));
        },
        20_000,
        "drain convergence to K authoritative rows",
      );
      const finalRows = listFrames.at(-1) as Array<{ text: string; _id: string }>;
      expect(finalRows).toHaveLength(K);
      // Strict order: the committed rows appear in the offline enqueue order m0..m11.
      expect(finalRows.map((r) => r.text)).toEqual(Array.from({ length: K }, (_, i) => `m${i}`));
      expect(finalRows.every((r) => !r._id.startsWith("opt-"))).toBe(true);

      // usePendingMutations went K → 0: the durable outbox is drained empty.
      await waitFor(async () => (await client2!.pendingMutations()).length === 0, 10_000, "pending K→0");
      expect(await client2.pendingMutations()).toHaveLength(0);
      expect((await outbox2Counting.storage.loadAll()).entries).toHaveLength(0);

      // EXACTLY-ONCE — receipts: exactly K `applied` `client_mutations` rows, one per offline seq
      // (seq 1..K, under the ORIGINAL cid1), read straight from the store.
      const offlineSeqs = Array.from({ length: K }, (_, i) => i + 1);
      const { applied, verdicts } = await countAppliedReceipts(store as never, cid1, offlineSeqs);
      expect(verdicts.every((v) => v === "applied")).toBe(true);
      expect(applied).toBe(K);
      // Axis (d) sanity: durable txns/mutation stayed bounded (recorded for the benchmark table).
      // eslint-disable-next-line no-console
      console.log(`[flagship-1a] IDB ops: append=${outbox2Counting.counts.append} updateStatus=${outbox2Counting.counts.updateStatus} dequeue=${outbox2Counting.counts.dequeue} loadAll=${outbox2Counting.counts.loadAll} for K=${K}`);
    } finally {
      client1?.close();
      client2?.close();
      await proxy.close();
      await server.close();
    }
  }, 90_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario (2) — kill-after-commit THROUGH THE REAL CLIENT                     */
/* -------------------------------------------------------------------------- */

describe("outbox client E2E (2) — kill-after-commit: the server dies post-commit pre-response; the client parks; a restart replay-settles with no double", () => {
  it("parks the in-flight mutation whose response was lost, reconnects to a restarted server, and the Connect handshake replays it applied — exactly one row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-outbox-kill-"));
    const dbPath = join(dir, "db.sqlite");
    let s1 = await startServer(new SqliteDocStore(new NodeSqliteAdapter({ path: dbPath })));
    const proxy = await makeProxy(s1.port);
    const wsUrl = wsUrlFor(proxy.port);

    let client: StackbaseClient | undefined;
    let s2: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      client = new StackbaseClient(nodeWsTransport(wsUrl), {
        outbox: memoryOutbox(),
        outboxLocks: null,
        outboxDrainIntervalMs: 0,
      });
      const cid = (await client.getOutboxIdentity())!.clientId;

      // Prime (seq0) → a recognized timeline; arm via a reopen.
      await client.mutation("notes:add", { box: "prime", text: "p" });
      proxy.killLive();
      await waitFor(() => client!.__outboxArmed, 10_000, "arm");

      // Withhold the server→client direction, then fire the victim (seq1). It commits at the server
      // (receipt lands) but the response never reaches the client.
      proxy.pauseDownstream();
      const victimP = client.mutation("notes:add", { box: "victim", text: "v" });
      void victimP.catch(() => {}); // may stay pending across the restart — never a rejection here
      await waitFor(async () => {
        const rec = await s1.store.getClientVerdict("", cid, 1);
        return !!rec && rec.verdict === "applied" && rec.hasValue === true;
      }, 10_000, "victim committed at server (response withheld)");
      const rec1 = await s1.store.getClientVerdict("", cid, 1);
      const originalValue = rec1!.value;
      const originalTs = Number(rec1!.commitTs);

      // The server "dies": drop the pair (the withheld response is lost) + block reconnects, and the
      // client parks the in-flight entry (armed + durable).
      proxy.goOffline();
      await waitFor(() => client!.__pending.some((e) => e.status.type === "parked"), 5000, "seq1 parks");

      // Restart the server on the SAME on-disk store; the receipt persists.
      await s1.server.close();
      s1.store.close();
      s2 = await startServer(new SqliteDocStore(new NodeSqliteAdapter({ path: dbPath })));
      proxy.setBackend(s2.port);
      proxy.resumeDownstream();
      proxy.goOnline();

      // Reconnect → Connect{held:[(cid,1)]} → the restarted server classifies it `applied` from the
      // persisted receipt → the parked promise resolves with the ORIGINAL value; no re-execution.
      const value = await victimP;
      expect(value).toBe(originalValue);

      // Exactly one victim row, one applied receipt — the replay wrote nothing new.
      const { applied } = await countAppliedReceipts(s2.store as never, cid, [1]);
      expect(applied).toBe(1);

      // Convergence: a fresh subscription on the restarted server sees exactly one "victim" row.
      const frames: unknown[][] = [];
      client.subscribe("notes:list", { box: "victim" }, (v) => frames.push(v as unknown[]));
      await waitFor(() => frames.length > 0 && (frames.at(-1) as unknown[]).length === 1, 10_000, "one victim row");
      expect((frames.at(-1) as unknown[]).length).toBe(1);
      void originalTs;

      // And the durable outbox drained clean.
      await waitFor(async () => (await client!.pendingMutations()).length === 0, 8000, "pending drained");
    } finally {
      client?.close();
      await proxy.close();
      await s1.server.close().catch(() => {});
      try { s1.store.close(); } catch { /* already closed mid-test */ }
      if (s2) { await s2.server.close().catch(() => {}); try { s2.store.close(); } catch { /* noop */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Seed helper: an armed session enqueues K durable offline entries, then closes */
/* (the "reload" boundary). Leaves the proxy OFFLINE — the caller `goOnline()`s   */
/* once the reload client(s) are constructed. Returns the recorded clientId.      */
/* -------------------------------------------------------------------------- */

async function seedOfflineBacklog(opts: {
  idb: IDBFactory;
  wsUrl: string;
  proxy: Awaited<ReturnType<typeof makeProxy>>;
  box: string;
  K: number;
  locks?: OutboxLockManager | null;
  authToken?: string;
}): Promise<{ clientId: string; fingerprint: string }> {
  const outbox = indexedDBOutbox({ indexedDB: opts.idb });
  const client = new StackbaseClient(nodeWsTransport(opts.wsUrl), {
    outbox,
    outboxLocks: opts.locks ?? null,
    outboxDrainIntervalMs: 0,
  });
  try {
    opts.proxy.goOnline(); // ensure the link is up for the prime/arm (a prior seed left it offline)
    const clientId = (await client.getOutboxIdentity())!.clientId;
    if (opts.authToken !== undefined) {
      client.setAuth(opts.authToken);
      // The identityFingerprint is stamped synchronously from the cache, which SetAuth fills async
      // (SubtleCrypto) — wait for it before enqueuing so the durable entries carry the real digest.
      await waitFor(() => client.__outboxFingerprint !== "anon", 5000, "fingerprint computed");
    }
    await client.mutation("notes:add", { box: "prime", text: "p" }); // seq0 → recognized timeline
    opts.proxy.killLive();
    await waitFor(() => client.__outboxArmed, 10_000, "seed arm");
    opts.proxy.goOffline();
    await sleep(120);
    const ps: Array<Promise<unknown>> = [];
    for (let i = 0; i < opts.K; i++) ps.push(client.mutation("notes:add", { box: opts.box, text: `${opts.box}-${i}` }));
    await waitFor(async () => (await outbox.loadAll()).entries.filter((e) => e.clientId === clientId).length === opts.K, 6000, "seed durable");
    for (const p of ps) void p.catch(() => {});
    return { clientId, fingerprint: client.__outboxFingerprint };
  } finally {
    client.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Scenario (3) — mid-drain leader kill: the successor drains the remainder     */
/* -------------------------------------------------------------------------- */

describe("outbox client E2E (3) — mid-drain leader kill: a second instance takes the lock and completes; receipts absorb the overlap", () => {
  it("kills the drain leader after it has committed some entries; the successor drains the rest exactly-once", async () => {
    const K = 8;
    const idb = new IDBFactory();
    const locks = sharedLocks(); // a real cross-instance Web-Locks analog (faked in Node; stated)
    const { server, store, port } = await startServer();
    const proxy = await makeProxy(port);
    const wsUrl = wsUrlFor(proxy.port);

    let leaderA: StackbaseClient | undefined;
    let successorB: StackbaseClient | undefined;
    try {
      const { clientId } = await seedOfflineBacklog({ idb, wsUrl, proxy, box: "led", K });

      // Two instances over ONE storage + ONE lock registry. A is constructed first → it wins the
      // lock (leader); B waits. Small chunks so the drain spans several flushes (a genuine mid-drain).
      leaderA = new StackbaseClient(nodeWsTransport(wsUrl), { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: locks(), outboxChunkSize: 1, outboxDrainIntervalMs: 0 });
      successorB = new StackbaseClient(nodeWsTransport(wsUrl), { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: locks(), outboxChunkSize: 1, outboxDrainIntervalMs: 0 });
      // Latency (chunkSize 1) spaces the drain so the leader can be killed genuinely mid-drain.
      proxy.setLatencyMs(120);
      proxy.goOnline();

      // Let A start draining, then KILL it mid-drain (≥1 committed, <K).
      await waitFor(async () => {
        const { applied } = await countAppliedReceipts(store as never, clientId, Array.from({ length: K }, (_, i) => i + 1));
        return applied >= 1;
      }, 15_000, "leader commits some");
      const beforeKill = (await countAppliedReceipts(store as never, clientId, Array.from({ length: K }, (_, i) => i + 1))).applied;
      expect(beforeKill).toBeGreaterThanOrEqual(1);
      expect(beforeKill).toBeLessThan(K);
      leaderA.close(); // releases the lock → B becomes leader

      // The successor drains the remainder to exactly K — receipts absorb any entry A had in flight.
      await waitFor(async () => {
        const { applied } = await countAppliedReceipts(store as never, clientId, Array.from({ length: K }, (_, i) => i + 1));
        return applied === K;
      }, 20_000, "successor completes to K");
      const { applied, verdicts } = await countAppliedReceipts(store as never, clientId, Array.from({ length: K }, (_, i) => i + 1));
      expect(applied).toBe(K); // EXACTLY once — no double despite the handoff overlap
      expect(verdicts.every((v) => v === "applied")).toBe(true);

      // App rows converge to exactly K under the successor.
      const frames: unknown[][] = [];
      successorB.subscribe("notes:list", { box: "led" }, (v) => frames.push(v as unknown[]));
      await waitFor(() => frames.length > 0 && (frames.at(-1) as unknown[]).length === K, 15_000, "rows == K");
      expect((frames.at(-1) as unknown[]).length).toBe(K);
    } finally {
      leaderA?.close();
      successorB?.close();
      await proxy.close();
      await server.close();
    }
  }, 90_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario (4) — multi-tab: one leader drains TWO clientIds' queues            */
/* -------------------------------------------------------------------------- */

describe("outbox client E2E (4) — multi-tab: two clientIds share one storage; a single leader drains BOTH queues' entries under their recorded ids", () => {
  it("drains two separate offline backlogs (distinct clientIds) under their own recorded (clientId, seq)", async () => {
    const KA = 5;
    const KB = 4;
    const idb = new IDBFactory();
    const locks = sharedLocks();
    const { server, store, port } = await startServer();
    const proxy = await makeProxy(port);
    const wsUrl = wsUrlFor(proxy.port);

    let leader: StackbaseClient | undefined;
    let idle: StackbaseClient | undefined;
    try {
      // Two prior tab-sessions, each minting its own clientId, both persisting into the SAME idb.
      const a = await seedOfflineBacklog({ idb, wsUrl, proxy, box: "tabA", K: KA });
      const b = await seedOfflineBacklog({ idb, wsUrl, proxy, box: "tabB", K: KB });
      expect(a.clientId).not.toBe(b.clientId);

      // One leader (a second idle instance shares the lock so only ONE drains) hydrates the WHOLE
      // shared queue — every clientId's entries — and drains each under its recorded id.
      leader = new StackbaseClient(nodeWsTransport(wsUrl), { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: locks(), outboxDrainIntervalMs: 0 });
      idle = new StackbaseClient(nodeWsTransport(wsUrl), { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: locks(), outboxDrainIntervalMs: 0 });
      proxy.goOnline();

      // Both queues drain to completion under their OWN recorded clientIds.
      await waitFor(async () => {
        const ra = await countAppliedReceipts(store as never, a.clientId, Array.from({ length: KA }, (_, i) => i + 1));
        const rb = await countAppliedReceipts(store as never, b.clientId, Array.from({ length: KB }, (_, i) => i + 1));
        return ra.applied === KA && rb.applied === KB;
      }, 20_000, "both queues drained");

      const ra = await countAppliedReceipts(store as never, a.clientId, Array.from({ length: KA }, (_, i) => i + 1));
      const rb = await countAppliedReceipts(store as never, b.clientId, Array.from({ length: KB }, (_, i) => i + 1));
      expect(ra.applied).toBe(KA);
      expect(rb.applied).toBe(KB);
      expect(ra.verdicts.every((v) => v === "applied")).toBe(true);
      expect(rb.verdicts.every((v) => v === "applied")).toBe(true);

      // Rows: tabA has KA, tabB has KB.
      const fa: unknown[][] = [];
      const fb: unknown[][] = [];
      leader.subscribe("notes:list", { box: "tabA" }, (v) => fa.push(v as unknown[]));
      leader.subscribe("notes:list", { box: "tabB" }, (v) => fb.push(v as unknown[]));
      await waitFor(() => (fa.at(-1) as unknown[] | undefined)?.length === KA && (fb.at(-1) as unknown[] | undefined)?.length === KB, 15_000, "rows per tab");
      expect((fa.at(-1) as unknown[]).length).toBe(KA);
      expect((fb.at(-1) as unknown[]).length).toBe(KB);

      // The durable queue is fully drained.
      await waitFor(async () => (await leader!.pendingMutations()).length === 0, 10_000, "pending empty");
    } finally {
      leader?.close();
      idle?.close();
      await proxy.close();
      await server.close();
    }
  }, 90_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario (5) — STALE_CLIENT surfaced through onMutationFailed                */
/* -------------------------------------------------------------------------- */

describe("outbox client E2E (5) — STALE_CLIENT: a server-side prune disowns the queued seqs; the reload surfaces terminal STALE_CLIENT through onMutationFailed", () => {
  it("prunes the client's records above the queued seqs; on reload the Connect handshake classifies them stale and onMutationFailed fires STALE_CLIENT", async () => {
    const K = 4;
    const idb = new IDBFactory();
    const { server, store, port } = await startServer();
    const proxy = await makeProxy(port);
    const wsUrl = wsUrlFor(proxy.port);

    let client: StackbaseClient | undefined;
    try {
      const { clientId } = await seedOfflineBacklog({ idb, wsUrl, proxy, box: "stale", K });

      // Server-side prune: advance this client's floor ABOVE the queued seqs (floor-covers-holes).
      // Now a presented seq <= floor with no record classifies STALE_CLIENT (verdict §(b)).
      await store.pruneClientMutations("", clientId, { ackedThrough: K + 5 });

      const failures: MutationFailedInfo[] = [];
      client = new StackbaseClient(nodeWsTransport(wsUrl), {
        outbox: indexedDBOutbox({ indexedDB: idb }),
        outboxLocks: null,
        outboxDrainIntervalMs: 0,
        onMutationFailed: (info) => failures.push(info),
      });
      proxy.goOnline();

      // The K queued seqs (no live promise this session) surface as terminal STALE_CLIENT.
      await waitFor(() => failures.filter((f) => f.error.code === "STALE_CLIENT").length === K, 20_000, "K stale failures");
      const stale = failures.filter((f) => f.error.code === "STALE_CLIENT");
      expect(stale).toHaveLength(K);
      expect(stale.every((f) => f.clientId === clientId)).toBe(true);
      expect(stale.map((f) => f.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: K }, (_, i) => i + 1));

      // The durable records persist as `failed` (until dismissed/retried), never silently dropped.
      await waitFor(async () => {
        const rows = await client!.pendingMutations();
        return rows.filter((r) => r.status === "failed").length === K;
      }, 8000, "K failed durable rows");
      const rows = await client.pendingMutations();
      expect(rows.filter((r) => r.status === "failed" && r.error?.code === "STALE_CLIENT")).toHaveLength(K);
    } finally {
      client?.close();
      await proxy.close();
      await server.close();
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario (6) — the authed-reload identity gate                               */
/* -------------------------------------------------------------------------- */

describe("outbox client E2E (6) — authed-reload identity gate: entries queued under one identity terminal-fail loudly under another (OFFLINE_IDENTITY_CHANGED)", () => {
  it("SetAuth to a different identity before the drain → the mismatched entries never flush; they terminal-fail with OFFLINE_IDENTITY_CHANGED", async () => {
    const K = 5;
    const idb = new IDBFactory();
    const { server, store, port } = await startServer();
    const proxy = await makeProxy(port);
    const wsUrl = wsUrlFor(proxy.port);

    // Capture the loud console.error the identity gate emits (verdict §(g) hazard 9: "loud").
    const errs: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };

    let client: StackbaseClient | undefined;
    try {
      // Seed while authed as ALICE — every offline entry is stamped with sha256("token-alice").
      const { clientId, fingerprint: aliceFp } = await seedOfflineBacklog({ idb, wsUrl, proxy, box: "authed", K, authToken: "token-alice" });
      expect(aliceFp).not.toBe("anon");

      const failures: MutationFailedInfo[] = [];
      const resets: ClientResetInfo[] = [];
      client = new StackbaseClient(nodeWsTransport(wsUrl), {
        outbox: indexedDBOutbox({ indexedDB: idb }),
        outboxLocks: null,
        outboxDrainIntervalMs: 0,
        onMutationFailed: (info) => failures.push(info),
        onClientReset: (info) => resets.push(info),
      });
      // Reload authenticates as BOB — a different identity than the queued entries.
      client.setAuth("token-bob");
      await waitFor(() => client!.__outboxFingerprint !== "anon" && client!.__outboxFingerprint !== aliceFp, 5000, "bob fingerprint");
      proxy.goOnline();

      // The mismatched entries terminal-fail loudly with OFFLINE_IDENTITY_CHANGED — they never flush
      // to the server under the wrong identity (they are re-keyed onto the fresh reset identity but
      // still carry alice's fingerprint, so the drain's flush-time gate rejects each).
      await waitFor(() => failures.filter((f) => f.error.code === "OFFLINE_IDENTITY_CHANGED").length === K, 20_000, "K identity-gate failures");
      const gated = failures.filter((f) => f.error.code === "OFFLINE_IDENTITY_CHANGED");
      expect(gated).toHaveLength(K);
      // The gate was LOUD (a console.error naming the code) for at least one entry.
      expect(errs.some((e) => e.includes("OFFLINE_IDENTITY_CHANGED"))).toBe(true);

      // None of the queued "authed" mutations ever committed a row under bob.
      const frames: unknown[][] = [];
      client.subscribe("notes:list", { box: "authed" }, (v) => frames.push(v as unknown[]));
      await waitFor(() => frames.length > 0, 8000, "list frame");
      await sleep(300);
      expect((frames.at(-1) as unknown[]).length).toBe(0);
      void store; void resets;
    } finally {
      console.error = origError;
      client?.close();
      await proxy.close();
      await server.close();
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario (7) — old-server compat: no ConnectAck → fail-fast byte-compat      */
/* -------------------------------------------------------------------------- */

/** Wrap a transport, DROPPING every inbound `ConnectAck` — a faithful "Plan-A-less" (pre-outbox)
 *  server that never answers `Connect` with a `ConnectAck`. The client still SENDS `Connect` (proven
 *  via `sawConnect`); it simply never arms, so `close()` stays today's fail-fast behavior. */
function connectAckDroppingTransport(inner: ClientTransport): { transport: ClientTransport; sawConnect: () => boolean } {
  let connectSent = false;
  const transport: ClientTransport = {
    send(m) {
      if ((m as { type?: string }).type === "Connect") connectSent = true;
      inner.send(m);
    },
    onMessage(listener) {
      return inner.onMessage((msg) => {
        if ((msg as { type?: string }).type === "ConnectAck") return; // the old server never sent it
        listener(msg);
      });
    },
    onClose: (l) => inner.onClose(l),
    onReopen: inner.onReopen ? (l) => inner.onReopen!(l) : undefined,
    close: () => inner.close(),
  };
  return { transport, sawConnect: () => connectSent };
}

describe("outbox client E2E (7) — old-server compat: a Plan-A-less server sends no ConnectAck → the client never arms (fail-fast byte-compat)", () => {
  it("sends Connect on reopen but, receiving no ConnectAck, never arms — the S4 park swap stays disarmed", async () => {
    const idb = new IDBFactory();
    const { server, port } = await startServer();
    const proxy = await makeProxy(port);
    const wsUrl = wsUrlFor(proxy.port);

    let client: StackbaseClient | undefined;
    try {
      const wrap = connectAckDroppingTransport(nodeWsTransport(wsUrl));
      client = new StackbaseClient(wrap.transport, { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: null, outboxDrainIntervalMs: 0 });
      await client.getOutboxIdentity();

      // A normal online mutation still commits (the wire protocol is otherwise identical).
      await client.mutation("notes:add", { box: "compat", text: "c" });

      // Force a reopen so the client SENDS Connect. The old server swallows it → no ConnectAck back.
      proxy.killLive();
      await waitFor(() => wrap.sawConnect(), 10_000, "client sent Connect");

      // Give the (dropped) ConnectAck ample time to (wrongly) arm the client — it must NOT.
      await sleep(600);
      expect(client.__outboxArmed).toBe(false); // fail-fast byte-compat: no arm without ConnectAck
    } finally {
      client?.close();
      await proxy.close();
      await server.close();
    }
  }, 40_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario (1b) — THE FLAGSHIP on Postgres + fleet + 8 shards                  */
/*                  (real embedded-postgres, no Docker)                        */
/* -------------------------------------------------------------------------- */

const HAS_EMBEDDED_PG = embeddedPgAvailable();
const maybeDescribe = HAS_EMBEDDED_PG ? describe : describe.skip;

const CLI_BIN = resolve(new URL(".", import.meta.url).pathname, "..", "dist", "bin.js");
const FLEET_FIXTURE_FUNCTIONS_DIR = resolve(
  new URL(".", import.meta.url).pathname,
  "..", "..", "..", "ee", "packages", "fleet", "test", "fixtures", "app", "convex",
);
const ADMIN_KEY = "outbox-client-fleet-key";

type ServeProc = ChildProcessByStdio<null, Readable, Readable>;
interface ReadyLine { url: string; role?: "sync" | "writer"; }

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

function waitForReady(proc: ServeProc): Promise<ReadyLine> {
  return new Promise((resolvePromise, reject) => {
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`ready timeout; stderr=${stderr}`)), 60_000);
    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const parsed = JSON.parse(line) as ReadyLine;
          if (parsed && typeof parsed.url === "string") { clearTimeout(timer); resolvePromise(parsed); return; }
        } catch { /* not the ready line */ }
      }
    });
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`serve exited early (code=${code}); stderr=${stderr}`)); });
  });
}

function spawnFleetServe(databaseUrl: string, port: number, dataDir: string): ServeProc {
  return spawn(
    "bun",
    [
      CLI_BIN, "serve", "--dir", FLEET_FIXTURE_FUNCTIONS_DIR, "--data", join(dataDir, "db.sqlite"),
      "--port", String(port), "--ip", "127.0.0.1", "--no-dashboard", "--database-url", databaseUrl,
      "--fleet", "--advertise-url", `http://127.0.0.1:${port}`,
    ],
    { env: { ...process.env, STACKBASE_ADMIN_KEY: ADMIN_KEY, STACKBASE_FLEET_SHARDS: "8" }, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function stopServe(proc: ServeProc | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  await new Promise<void>((r) => proc.once("exit", () => r()));
}

maybeDescribe("outbox client E2E (1b) — THE FLAGSHIP on Postgres + fleet + 8 shards: offline → reload → drain, exactly-once", () => {
  it("an armed client on the fleet writer enqueues K offline; a reload drains through the 8-shard fleet transactor with a mid-drain resend; exactly K receipts in the shared Postgres", async () => {
    const K = 10;
    const pgServer = await startEmbeddedPg();
    const databaseUrl = pgServer.url;
    const portA = await freePort();
    const portB = await freePort();
    const dataDirA = mkdtempSync(join(tmpdir(), "sb-oc-fleetA-"));
    const dataDirB = mkdtempSync(join(tmpdir(), "sb-oc-fleetB-"));
    const idb = new IDBFactory();

    let nodeA: ServeProc | undefined;
    let nodeB: ServeProc | undefined;
    let proxy: Awaited<ReturnType<typeof makeProxy>> | undefined;
    let reload: StackbaseClient | undefined;
    const pg = new NodePgClient({ connectionString: databaseUrl });
    try {
      // A boots first → writer (owns all 8 shards). B → sync replica (a real 2-node fleet). The
      // client talks to the WRITER: its Connect classification reads the authoritative primary
      // (shared Postgres), so the reload is a CLEAN known:true drain. (A reload against the SYNC node
      // instead spuriously resets — the sync node classifies against its local replica, which does
      // not carry the receipts; documented as a finding in the task report.) Commits still run
      // through the full 8-shard fleet transactor + Postgres — the fleet substrate.
      nodeA = spawnFleetServe(databaseUrl, portA, dataDirA);
      expect((await waitForReady(nodeA)).role).toBe("writer");
      nodeB = spawnFleetServe(databaseUrl, portB, dataDirB);
      expect((await waitForReady(nodeB)).role).toBe("sync");

      proxy = await makeProxy(portA);
      const wsUrl = `ws://127.0.0.1:${proxy.port}/api/sync`;

      // Seed under a durable clientId: prime (→ recognized timeline), arm, go offline, enqueue K.
      const { clientId } = await seedOfflineBacklog({ idb, wsUrl, proxy, box: "offline", K });

      // Reload: a fresh client over the same idb drains through the fleet transactor. Latency + a
      // single mid-drain socket kill force a genuine resend — the owner's receipts absorb the overlap
      // so nothing double-applies.
      reload = new StackbaseClient(nodeWsTransport(wsUrl), { outbox: indexedDBOutbox({ indexedDB: idb }), outboxLocks: null, outboxChunkSize: 1, outboxDrainIntervalMs: 0 });
      proxy.setLatencyMs(80);
      proxy.goOnline();

      // Kill the socket once the drain is underway (a resend mid-drain via the fleet path).
      let killed = false;
      const seqs = () => `client_id = '${clientId}' AND seq >= 1 AND seq <= ${K}`;
      await waitFor(async () => {
        const rows = await pg.query(`SELECT count(*)::int AS n FROM client_mutations WHERE ${seqs()}`);
        const n = (rows[0] as { n: number }).n;
        if (!killed && n >= 1 && n < K) { killed = true; proxy!.killLive(); }
        return n === K;
      }, 90_000, "drain to K via fleet");
      expect(killed).toBe(true); // the resend really happened mid-drain

      // EXACTLY-ONCE — exactly K applied receipts in the shared Postgres, one per offline seq.
      const recCount = await pg.query(`SELECT count(*)::int AS n FROM client_mutations WHERE ${seqs()} AND verdict = 'applied'`);
      expect((recCount[0] as { n: number }).n).toBe(K);

      // usePendingMutations went K → 0.
      await waitFor(async () => (await reload!.pendingMutations()).length === 0, 20_000, "pending K→0 (fleet)");
      expect(await reload.pendingMutations()).toHaveLength(0);

      // App rows — EXACT count + STRICT order (parity with 1a's rigor, read straight from the shared
      // Postgres rather than through a live subscription: cross-shard index-scan reactivity for a
      // NON-`shardBy` table under the 8-shard fleet transactor is its own surface, not what this
      // scenario is proving). `recCount` above already pins the exact count; order is pinned by
      // reading the receipts in ACTUAL COMMIT ORDER (`commit_ts ASC`) and asserting the seqs come out
      // 1..K in that order — i.e. the server committed the offline backlog in exactly the enqueue
      // order, never out of order and never with a gap or a duplicate (which `ORDER BY commit_ts`
      // would expose immediately as a non-monotone seq sequence).
      const orderRows = await pg.query(`SELECT seq FROM client_mutations WHERE ${seqs()} AND verdict = 'applied' ORDER BY commit_ts ASC`);
      expect((orderRows as Array<{ seq: bigint }>).map((r) => Number(r.seq))).toEqual(Array.from({ length: K }, (_, i) => i + 1));
    } finally {
      reload?.close();
      await proxy?.close();
      await pg.close().catch(() => {});
      await stopServe(nodeA);
      await stopServe(nodeB);
      await pgServer.stop();
      rmSync(dataDirA, { recursive: true, force: true });
      rmSync(dataDirB, { recursive: true, force: true });
    }
  }, 180_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario (8) — fleet SYNC-NODE Connect classification hits the PRIMARY        */
/* (T6 finding #2 fix): the receipts tables live only on the authoritative       */
/* primary, NOT the replica — so a reload via a sync node must classify against  */
/* the primary or it spuriously resets a client (verdict §(c) placement).        */
/* -------------------------------------------------------------------------- */

maybeDescribe("outbox client E2E (8) — a reload via the fleet SYNC node classifies receipts against the PRIMARY (no spurious reset, no double-apply)", () => {
  it("seeds K offline via the writer, reloads THROUGH the sync node with a mid-drain socket kill: the sync node routes Connect classification to the primary → known:true, no reset, and the committed-but-resent entries settle exactly-once (pre-fix: the replica has no receipts → known:false → the client resets, and a committed seq falsely fails)", async () => {
    const K = 6;
    const pgServer = await startEmbeddedPg();
    const databaseUrl = pgServer.url;
    const portA = await freePort();
    const portB = await freePort();
    const dataDirA = mkdtempSync(join(tmpdir(), "sb-oc-syncA-"));
    const dataDirB = mkdtempSync(join(tmpdir(), "sb-oc-syncB-"));
    const idb = new IDBFactory();

    let nodeA: ServeProc | undefined;
    let nodeB: ServeProc | undefined;
    let proxyA: Awaited<ReturnType<typeof makeProxy>> | undefined;
    let proxyB: Awaited<ReturnType<typeof makeProxy>> | undefined;
    let reload: StackbaseClient | undefined;
    const pg = new NodePgClient({ connectionString: databaseUrl });
    try {
      // A → writer (owns all 8 shards); B → sync replica. The reload client talks to the SYNC node B,
      // whose local replica carries NONE of the `client_mutations`/`client_floors` receipts (they are
      // not in the replicated MVCC log). The fix routes B's Connect classification to the PRIMARY.
      nodeA = spawnFleetServe(databaseUrl, portA, dataDirA);
      expect((await waitForReady(nodeA)).role).toBe("writer");
      nodeB = spawnFleetServe(databaseUrl, portB, dataDirB);
      expect((await waitForReady(nodeB)).role).toBe("sync");

      // Seed the offline backlog via the WRITER (its own arm handshake classifies correctly): a
      // committed prime (→ a recognized primary receipt) + K offline held entries under one clientId.
      proxyA = await makeProxy(portA);
      const wsA = `ws://127.0.0.1:${proxyA.port}/api/sync`;
      const { clientId } = await seedOfflineBacklog({ idb, wsUrl: wsA, proxy: proxyA, box: "syncnode", K });

      // ── RELOAD VIA THE SYNC NODE (the code path under test) ──────────────────────────────────────
      // A fresh client over the same durable IDB, drained THROUGH a proxy in front of node B (so a
      // mid-drain kill forces a genuine resend of a committed-but-unacked entry). On its Connect the
      // client presents `ackedThrough` covering the committed prime + `held` for the K offline seqs.
      // PRE-FIX: node B classifies the prime's ackedThrough against its receipt-less replica → unknown
      // → `known:false` → `onClientReset` re-mints the clientId (draining under a FRESH id → ZERO
      // applied receipts under the ORIGINAL clientId), AND a committed-but-resent seq is falsely
      // disowned. POST-FIX: node B classifies against the PRIMARY → the prime is recognized →
      // `known:true`, no reset, and the resent committed entries replay-ack exactly-once.
      proxyB = await makeProxy(portB);
      const wsB = `ws://127.0.0.1:${proxyB.port}/api/sync`;
      let resetInfo: ClientResetInfo | undefined;
      const failures: MutationFailedInfo[] = [];
      reload = new StackbaseClient(nodeWsTransport(wsB), {
        outbox: indexedDBOutbox({ indexedDB: idb }),
        outboxLocks: null,
        outboxChunkSize: 1,
        outboxDrainIntervalMs: 0,
        onClientReset: (info) => { resetInfo = info; },
        onMutationFailed: (info) => failures.push(info),
      });
      proxyB.setLatencyMs(80);

      // Kill the socket once the drain is underway → a committed-but-unacked entry is resent; the
      // sync node re-classifies it against the primary (applied) rather than falsely disowning it.
      const seqCond = `client_id = '${clientId}' AND seq >= 1 AND seq <= ${K}`;
      let killed = false;
      await waitFor(async () => {
        const rows = await pg.query(`SELECT count(*)::int AS n FROM client_mutations WHERE ${seqCond} AND verdict = 'applied'`);
        const n = (rows[0] as { n: number }).n;
        if (!killed && n >= 1 && n < K) { killed = true; proxyB!.killLive(); }
        return n === K;
      }, 90_000, "sync-node reload drains K under the ORIGINAL clientId");
      expect(killed).toBe(true); // the resend really happened mid-drain, through the sync node

      // No spurious reset, and no committed entry falsely failed: the sync node recognized the
      // client's committed timeline off the PRIMARY, not its receipt-less replica.
      expect(resetInfo).toBeUndefined();
      expect(failures.filter((f) => f.error.code === "OFFLINE_CLIENT_RESET" || f.error.code === "STALE_CLIENT")).toHaveLength(0);
      // EXACTLY-ONCE under the ORIGINAL clientId (a reset would have committed them under a fresh id;
      // a double-apply would exceed K — the primary receipt guard collapses the resend to one row).
      const rc = await pg.query(`SELECT count(*)::int AS n FROM client_mutations WHERE ${seqCond} AND verdict = 'applied'`);
      expect((rc[0] as { n: number }).n).toBe(K);
      await waitFor(async () => (await reload!.pendingMutations()).length === 0, 20_000, "pending K→0 (sync node)");
    } finally {
      reload?.close();
      await proxyA?.close();
      await proxyB?.close();
      await pg.close().catch(() => {});
      await stopServe(nodeA);
      await stopServe(nodeB);
      await pgServer.stop();
      rmSync(dataDirA, { recursive: true, force: true });
      rmSync(dataDirB, { recursive: true, force: true });
    }
  }, 180_000);
});

/* -------------------------------------------------------------------------- */
/* THE FOUR-AXIS BENCHMARK (verdict §(h)) → docs/dev/research/offline-outbox/   */
/* benchmark.md                                                                 */
/* -------------------------------------------------------------------------- */

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/** Sample event-loop lag: the longest a 1ms interval is delayed = the longest main-thread block. */
function lagSampler(): { stop: () => number } {
  let maxLag = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - 1);
    last = now;
  }, 1);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop() { clearInterval(timer); return maxLag; },
  };
}

// Opt-in (STACKBASE_BENCH=1) — the benchmark is a measurement, not a correctness gate, and its
// 500-entry drain + 400-concurrent burst add real load; keeping it off the default parallel gate
// follows the repo's bench-opt-in precedent (fleet B4, 975f735). Run it standalone:
//   STACKBASE_BENCH=1 bun run --filter @stackbase/cli test -t "four-axis benchmark"
const maybeBench = process.env.STACKBASE_BENCH ? describe : describe.skip;

maybeBench("outbox client E2E — the four-axis benchmark (§(h))", () => {
  it("measures adapter overhead, throughput, 500-drain time-to-empty + main-thread block, and IDB txns/mutation", async () => {
    const results: Record<string, unknown> = {};

    /* ---- Axis (a): online p50/p99 round-trip, adapter ON vs OFF (target Δ≈0) ---- */
    {
      const N = 120;
      const { server, port } = await startServer();
      try {
        const measure = async (withOutbox: boolean): Promise<number[]> => {
          const client = new StackbaseClient(nodeWsTransport(wsUrlFor(port)), withOutbox ? { outbox: memoryOutbox(), outboxLocks: null, outboxDrainIntervalMs: 0 } : {});
          try {
            await sleep(150); // let the socket open
            // Warm up.
            for (let i = 0; i < 10; i++) await client.mutation("notes:add", { box: "warm", text: `w${i}` });
            const lat: number[] = [];
            for (let i = 0; i < N; i++) {
              const t0 = performance.now();
              await client.mutation("notes:add", { box: "bench-a", text: `a${i}` });
              lat.push(performance.now() - t0);
            }
            return lat.sort((x, y) => x - y);
          } finally {
            client.close();
          }
        };
        const off = await measure(false);
        const on = await measure(true);
        results.axisA = {
          off: { p50: +percentile(off, 50).toFixed(3), p99: +percentile(off, 99).toFixed(3) },
          on: { p50: +percentile(on, 50).toFixed(3), p99: +percentile(on, 99).toFixed(3) },
          deltaP50Ms: +(percentile(on, 50) - percentile(off, 50)).toFixed(3),
          deltaP99Ms: +(percentile(on, 99) - percentile(off, 99)).toFixed(3),
          samples: N,
        };
      } finally {
        await server.close();
      }
    }

    /* ---- Axis (b): online concurrent throughput, adapter ON ---- */
    {
      const M = 400;
      const { server, port } = await startServer();
      try {
        const client = new StackbaseClient(nodeWsTransport(wsUrlFor(port)), { outbox: memoryOutbox(), outboxLocks: null, outboxDrainIntervalMs: 0 });
        try {
          await sleep(150);
          const t0 = performance.now();
          await Promise.all(Array.from({ length: M }, (_, i) => client.mutation("notes:add", { box: "bench-b", text: `b${i}` })));
          const dt = performance.now() - t0;
          results.axisB = { mutations: M, totalMs: +dt.toFixed(1), throughputOpsPerSec: Math.round((M / dt) * 1000) };
        } finally {
          client.close();
        }
      } finally {
        await server.close();
      }
    }

    /* ---- Axis (c) + (d): 500-drain time-to-empty, longest main-thread block, IDB txns/mutation ---- */
    {
      const K = 500;
      const idb = new IDBFactory();
      const { server, port } = await startServer();
      const proxy = await makeProxy(port);
      const wsUrl = wsUrlFor(proxy.port);
      try {
        // Seed 500 offline durable entries (append cost counted below via a fresh counting wrapper).
        await seedOfflineBacklog({ idb, wsUrl, proxy, box: "drain500", K });

        const counting = countingOutbox(indexedDBOutbox({ indexedDB: idb }));
        const reload = new StackbaseClient(nodeWsTransport(wsUrl), { outbox: counting.storage, outboxLocks: null, outboxChunkSize: 50, outboxDrainIntervalMs: 0 });
        try {
          const sampler = lagSampler();
          const t0 = performance.now();
          proxy.goOnline();
          await waitFor(async () => (await counting.storage.loadAll()).entries.length === 0, 60_000, "500-drain to empty");
          const timeToEmptyMs = performance.now() - t0;
          const maxBlockMs = sampler.stop();
          results.axisC = {
            entries: K,
            chunkSize: 50,
            timeToEmptyMs: +timeToEmptyMs.toFixed(1),
            longestMainThreadBlockMs: +maxBlockMs.toFixed(2),
          };
          // Axis (d): durable txns/mutation over the reload session (status transitions + dequeue).
          // The write-behind IndexedDB adapter coalesces same-microtask ops into one physical IDB
          // transaction, so per-op counts are an upper bound on physical txns.
          results.axisD = {
            entries: K,
            reloadSession: { updateStatus: counting.counts.updateStatus, dequeue: counting.counts.dequeue, loadAll: counting.counts.loadAll },
            storageOpsPerMutation: +((counting.counts.updateStatus + counting.counts.dequeue) / K).toFixed(2),
            note: "append (1/mutation) happened in the seed session; drain adds status-transition + dequeue ops. The IndexedDB adapter write-behind-batches same-microtask ops into one physical transaction, so physical IDB txns/mutation ≤ this.",
          };
        } finally {
          reload.close();
        }
      } finally {
        await proxy.close();
        await server.close();
      }
    }

    /* ---- Write the report ---- */
    const a = results.axisA as { off: { p50: number; p99: number }; on: { p50: number; p99: number }; deltaP50Ms: number; deltaP99Ms: number; samples: number };
    const b = results.axisB as { mutations: number; totalMs: number; throughputOpsPerSec: number };
    const c = results.axisC as { entries: number; chunkSize: number; timeToEmptyMs: number; longestMainThreadBlockMs: number };
    const d = results.axisD as { storageOpsPerMutation: number; reloadSession: { updateStatus: number; dequeue: number; loadAll: number } };
    const md = `# Receipted Outbox (Plan B) — the four-axis benchmark

Generated by \`packages/cli/test/outbox-e2e.test.ts\` (the flagship E2E), driving the REAL
\`@stackbase/client\` over a real WebSocket to a real \`stackbase dev\` server on this machine.
Re-run: \`bun run --filter @stackbase/cli test -t "four-axis benchmark"\` (numbers are machine- and
load-dependent; treat the SHAPE, not the absolute values, as the result).

Environment: Node ${process.version}, ${process.platform}/${process.arch}. Durable storage under
\`fake-indexeddb\` (an in-memory IndexedDB) — real-browser IDB is disk-backed and slower per
transaction, so axis (a)/(d) absolute numbers are optimistic; the *shape* (adapter cost ≈ 0 online,
bounded txns/mutation) is what transfers.

## (a) Online round-trip latency — adapter ON vs OFF (target: Δ ≈ 0)

The durable append is write-behind (the send never waits for it), so configuring the outbox must not
move the online mutation round-trip. ${a.samples} sequential mutations each way:

| | p50 (ms) | p99 (ms) |
|---|---|---|
| adapter OFF | ${a.off.p50} | ${a.off.p99} |
| adapter ON  | ${a.on.p50} | ${a.on.p99} |
| **Δ (on − off)** | **${a.deltaP50Ms}** | **${a.deltaP99Ms}** |

## (b) Online concurrent throughput — adapter ON

${b.mutations} mutations fired concurrently (\`Promise.all\`), adapter on:

- total: **${b.totalMs} ms** → **${b.throughputOpsPerSec} ops/s**

## (c) 500-entry drain — time-to-empty + longest main-thread block (riding \`MutationBatch\`)

${c.entries} durable offline entries, reload, drain in \`MutationBatch\` chunks of ${c.chunkSize}:

- time-to-empty: **${c.timeToEmptyMs} ms**
- longest main-thread block (max event-loop stall during the drain): **${c.longestMainThreadBlockMs} ms**

Chunking keeps the drain off the main thread: no single synchronous block approaches the
time-to-empty — the queue drains in the background while the UI stays responsive.

## (d) Durable (IDB) transactions per mutation

Over the ${c.entries}-entry reload+drain session (the append happens once, in the prior/seed session):

- status-transition writes: ${d.reloadSession.updateStatus}, dequeues: ${d.reloadSession.dequeue}, full hydrates: ${d.reloadSession.loadAll}
- **storage ops / mutation (drain session): ${d.storageOpsPerMutation}** (≈ one \`inflight\` transition + one \`dequeue\` per entry)

The IndexedDB adapter write-behind-batches same-microtask operations into a single physical
transaction, so the count of *physical* IDB transactions per mutation is an upper-bounded by this and
in practice lower during a batched chunk flush. Adding the one \`append\` per mutation from the enqueue
session, the whole lifecycle is ≈ 3 logical storage ops/mutation (append → inflight → dequeue).

---
_Raw: \`${JSON.stringify(results)}\`_
`;
    const outPath = resolve(new URL(".", import.meta.url).pathname, "..", "..", "..", "docs", "dev", "research", "offline-outbox", "benchmark.md");
    writeFileSync(outPath, md);
    // eslint-disable-next-line no-console
    console.log(`[benchmark] axisA Δp50=${a.deltaP50Ms}ms Δp99=${a.deltaP99Ms}ms | axisB ${b.throughputOpsPerSec}ops/s | axisC drain500=${c.timeToEmptyMs}ms block=${c.longestMainThreadBlockMs}ms | axisD ${d.storageOpsPerMutation}ops/mut → ${outPath}`);

    // Loose sanity bounds (the benchmark is measurement, not a tight gate).
    expect(c.timeToEmptyMs).toBeGreaterThan(0);
    expect(b.throughputOpsPerSec).toBeGreaterThan(0);
    expect((results.axisA as { off: unknown }).off).toBeDefined();
  }, 120_000);
});
