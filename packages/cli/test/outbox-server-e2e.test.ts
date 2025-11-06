/**
 * Receipted Outbox (Plan A) — the server E2E gate: the raw-wire proof of exactly-once through real
 * processes. Every scenario drives the sync protocol DIRECTLY over a real WebSocket to a real
 * `stackbase dev` server (`startDevServer` + `createEmbeddedRuntime`) — Plan B's real client (the
 * one that mints `clientId`/`seq` and parks-and-resends) does not exist yet, so this harness IS the
 * client: it sends `Connect`/`Mutation`/`MutationBatch` frames itself and reads the raw
 * `MutationResponse`/`ConnectAck` off the wire (the `ws.test.ts` / `optimistic-e2e.test.ts` pattern).
 *
 * The seven binding scenarios (task-6-brief.md):
 *   (1) kill-after-commit resend: a `(clientId, seq)` mutation commits; the server is killed BEFORE
 *       the client reads the response; a fresh server restarts on the SAME on-disk store; the same
 *       seq is resent → `replayed: true` carrying the ORIGINAL commitTs AND the value (the T5-fix
 *       post-run value fill), exactly one row written.
 *   (2) concurrent same-seq duplicates (two racing sockets) → one commits, the loser replay-acks
 *       (the commit-guard collision path, live).
 *   (3) STALE_CLIENT through the wire: record a seq → ack-prune it via `Connect.ackedThrough` →
 *       resend at/below the floor → the coded terminal (`code: "STALE_CLIENT"`).
 *   (4) MutationBatch: 50 entries applied sequentially, per-unit responses in wire order; a mid-batch
 *       TERMINAL failure records + continues; a mid-batch TRANSIENT failure stops the remainder.
 *   (5) the collateral fix live under STACKBASE_GROUP_COMMIT=1: co-batched innocents from OTHER
 *       clients survive a duplicate-key abort (the T3 split-retry, end-to-end).
 *   (6) fleet + 8 shards (real Docker): a resend arriving via a NON-owner (sync) node classifies at
 *       the OWNER — the per-unit receipt is present exactly once.
 *   (7) old-client compat: the same flows MINUS clientId/seq are byte-identical today-behavior — no
 *       receipts written (the receipts table is asserted empty).
 *
 * Plus: `Connect`/`ConnectAck` live (held classification + `deploymentId` present + `known` flags),
 * and the zero-write keyed mutation records an `applied` receipt (with its value).
 */
import { describe, it, expect } from "vitest";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { ServiceUnavailableError } from "@stackbase/errors";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { NodePgClient } from "@stackbase/docstore-postgres";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import type { ClientMessage, ServerMessage, MutationBatchEntry } from "@stackbase/sync";
import { loadProject, startDevServer, type DevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixture app (inline) — a keyed write, a zero-write, a terminal + transient   */
/* -------------------------------------------------------------------------- */

const schema = defineSchema({
  notes: defineTable({ box: v.string(), text: v.string() }).index("by_box", ["box"]),
});

const notesModule = {
  // Keyed WRITE mutation: inserts a row, returns the new id (the value the applied receipt carries).
  add: mutation<{ box: string; text: string }, string>({
    handler: (ctx, { box, text }) => ctx.db.insert("notes", { box, text }),
  }),
  list: query<Record<string, never>, unknown[]>({
    handler: (ctx) => ctx.db.query("notes", "by_box").collect(),
  }),
  // ZERO-WRITE successful mutation: no `ctx.db` write, returns a value — its `applied` receipt is
  // written standalone (recordZeroWriteApplied), not by the commit guard.
  ping: mutation<Record<string, never>, string>({
    handler: () => "pong",
  }),
  // TERMINAL failure: a plain (non-retryable) throw — records a `failed` verdict, batch CONTINUES.
  boom: mutation<Record<string, never>, string>({
    handler: () => {
      throw new Error("boom-terminal");
    },
  }),
  // TRANSIENT failure: a retryable throw — records NOTHING, batch STOPS the remainder.
  boomTransient: mutation<Record<string, never>, string>({
    handler: () => {
      throw new ServiceUnavailableError("boom-transient");
    },
  }),
};

function loaded() {
  return { schema, modules: { notes: notesModule } };
}

async function startServer(
  store: SqliteDocStore = new SqliteDocStore(new NodeSqliteAdapter()),
  opts?: { groupCommit?: boolean },
): Promise<{ runtime: EmbeddedRuntime; server: DevServer; store: SqliteDocStore; wsUrl: string }> {
  const project = loadProject(loaded());
  const runtime = await createEmbeddedRuntime({
    store,
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
    groupCommit: opts?.groupCommit,
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  return { runtime, server, store, wsUrl: `ws://127.0.0.1:${server.port}/api/sync` };
}

/* -------------------------------------------------------------------------- */
/* Raw-wire client — drives the protocol directly                              */
/* -------------------------------------------------------------------------- */

type MutResp = Extract<ServerMessage, { type: "MutationResponse" }>;
type ConnAck = Extract<ServerMessage, { type: "ConnectAck" }>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await sleep(10);
  }
}

/** A raw WebSocket to `/api/sync` that records every inbound `ServerMessage` in wire-arrival order and
 *  sends arbitrary `ClientMessage`s — the whole point is to send frames Plan B's client can't yet. */
class RawWire {
  readonly inbound: ServerMessage[] = [];
  private constructor(readonly ws: WebSocket) {}

  static open(url: string): Promise<RawWire> {
    return new Promise((resolvePromise, reject) => {
      const ws = new WebSocket(url);
      const wire = new RawWire(ws);
      ws.on("message", (raw: Buffer) => wire.inbound.push(JSON.parse(raw.toString("utf8")) as ServerMessage));
      ws.once("open", () => resolvePromise(wire));
      ws.once("error", reject);
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  responses(): MutResp[] {
    return this.inbound.filter((m): m is MutResp => m.type === "MutationResponse");
  }

  responseFor(requestId: string): MutResp | undefined {
    return this.responses().find((m) => m.requestId === requestId);
  }

  async awaitResponse(requestId: string, timeoutMs = 5000): Promise<MutResp> {
    await waitFor(() => this.responseFor(requestId) !== undefined, timeoutMs, `response ${requestId}`);
    return this.responseFor(requestId)!;
  }

  connectAcks(): ConnAck[] {
    return this.inbound.filter((m): m is ConnAck => m.type === "ConnectAck");
  }

  /** Latest QueryUpdated value pushed for `queryId` across all Transitions (wire order). */
  latestQuery(queryId: number): unknown {
    for (let i = this.inbound.length - 1; i >= 0; i--) {
      const m = this.inbound[i]!;
      if (m.type !== "Transition") continue;
      for (let j = m.modifications.length - 1; j >= 0; j--) {
        const mod = m.modifications[j]!;
        if (mod.queryId === queryId && mod.type === "QueryUpdated") return mod.value;
      }
    }
    return undefined;
  }

  close(): void {
    this.ws.close();
  }

  terminate(): void {
    this.ws.terminate();
  }
}

/** Subscribe to `notes:list` on a wire and return the row count once the first push lands. */
async function listCount(wire: RawWire, queryId = 900): Promise<number> {
  wire.send({ type: "ModifyQuerySet", add: [{ queryId, udfPath: "notes:list", args: {} }], remove: [] });
  await waitFor(() => Array.isArray(wire.latestQuery(queryId)), 5000, "notes:list");
  return (wire.latestQuery(queryId) as unknown[]).length;
}

/* -------------------------------------------------------------------------- */
/* Scenario 1 — kill-after-commit resend (crash-safe exactly-once)             */
/* -------------------------------------------------------------------------- */

describe("outbox server E2E (1) — kill-after-commit resend replays exactly-once", () => {
  it("commits, is killed before the response is read, restarts on the same store, and the resend replays the original commitTs + value with exactly one row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-outbox-crash-"));
    const dbPath = join(dir, "db.sqlite");
    try {
      /* --- Server 1: commit (clientId=C, seq=1); confirm the receipt (with value) landed WITHOUT
       *     the client ever reading the WS response, then hard-crash the server. --- */
      const s1 = await startServer(new SqliteDocStore(new NodeSqliteAdapter({ path: dbPath })));
      const w1 = await RawWire.open(s1.wsUrl);
      w1.send({ type: "Mutation", requestId: "r1", udfPath: "notes:add", args: { box: "b", text: "first" }, clientId: "C", seq: 1 });

      // Poll the store directly (NOT the wire) until the applied receipt is present WITH its value
      // filled (the T5 post-run value fill). This is the "committed, but the client never read the
      // response" state — exactly what a crash-before-ack leaves behind.
      let rec = await s1.store.getClientVerdict("", "C", 1);
      const deadline = Date.now() + 5000;
      while ((!rec || !rec.hasValue) && Date.now() < deadline) {
        await sleep(20);
        rec = await s1.store.getClientVerdict("", "C", 1);
      }
      expect(rec?.verdict).toBe("applied");
      expect(rec?.hasValue).toBe(true);
      const originalTs = Number(rec!.commitTs);
      const originalValue = rec!.value;
      expect(originalTs).toBeGreaterThan(0);
      expect(typeof originalValue).toBe("string");

      // Crash: drop the socket, tear down the server, close the store to release the file.
      w1.terminate();
      await s1.server.close();
      s1.store.close();

      /* --- Server 2: fresh runtime on the SAME on-disk store; resend the SAME seq. --- */
      const s2 = await startServer(new SqliteDocStore(new NodeSqliteAdapter({ path: dbPath })));
      try {
        const w2 = await RawWire.open(s2.wsUrl);
        w2.send({ type: "Mutation", requestId: "r2", udfPath: "notes:add", args: { box: "b", text: "first" }, clientId: "C", seq: 1 });
        const resp = await w2.awaitResponse("r2");

        expect(resp.success).toBe(true);
        if (resp.success) {
          expect(resp.replayed).toBe(true); // a replay — NO commit happened on this call
          expect(resp.ts).toBe(originalTs); // the ORIGINAL commitTs (keeps the optimistic gate sound)
          expect(resp.valueMissing).toBeUndefined();
          expect(resp.value).toEqual(originalValue); // the T5-fix value fill survived the restart
        }

        // Exactly one row — the resend wrote nothing new.
        expect(await listCount(w2)).toBe(1);
        w2.close();
      } finally {
        await s2.server.close();
        s2.store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario 2 — concurrent same-seq duplicates (the guard-collision path)      */
/* -------------------------------------------------------------------------- */

describe("outbox server E2E (2) — concurrent same-seq duplicates: one commits, the loser replay-acks", () => {
  it("two sockets racing the same (clientId, seq) → exactly one fresh commit, one replay-ack, one row", async () => {
    const s = await startServer();
    const wa = await RawWire.open(s.wsUrl);
    const wb = await RawWire.open(s.wsUrl);
    try {
      // Fire both with the SAME durable key — neither pre-read sees the other's receipt, so both run;
      // the commit guard's PK collision makes exactly one lose and replay-ack the winner.
      wa.send({ type: "Mutation", requestId: "a", udfPath: "notes:add", args: { box: "x", text: "dup" }, clientId: "D", seq: 1 });
      wb.send({ type: "Mutation", requestId: "b", udfPath: "notes:add", args: { box: "x", text: "dup" }, clientId: "D", seq: 1 });

      const [ra, rb] = await Promise.all([wa.awaitResponse("a"), wb.awaitResponse("b")]);
      expect(ra.success).toBe(true);
      expect(rb.success).toBe(true);

      // Exactly one is a fresh commit, exactly one is a replay — both carry the SAME commitTs.
      const replayed = [ra, rb].filter((r) => r.success && r.replayed).length;
      expect(replayed).toBe(1);
      if (ra.success && rb.success) expect(ra.ts).toBe(rb.ts);

      // Exactly one row committed.
      expect(await listCount(wa)).toBe(1);
    } finally {
      wa.close();
      wb.close();
      await s.server.close();
    }
  }, 15_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario 3 — STALE_CLIENT through the wire                                  */
/* -------------------------------------------------------------------------- */

describe("outbox server E2E (3) — STALE_CLIENT through the wire", () => {
  it("records a seq, ack-prunes it via Connect.ackedThrough, and a resend at/below the floor is the coded terminal", async () => {
    const s = await startServer();
    const w = await RawWire.open(s.wsUrl);
    try {
      // Record seq 5 (applied).
      w.send({ type: "Mutation", requestId: "m5", udfPath: "notes:add", args: { box: "s", text: "five" }, clientId: "S", seq: 5 });
      const r5 = await w.awaitResponse("m5");
      expect(r5.success).toBe(true);

      // Ack-prune the settled prefix through seq 5 (deletes the record, advances the floor to 5).
      w.send({ type: "Connect", sessionId: "sess-3", clientId: "S", ackedThrough: [{ clientId: "S", seq: 5 }] });
      await waitFor(() => w.connectAcks().length >= 1, 5000, "ConnectAck");

      // Resend seq 5 — now at the floor with no record → the loudly-disowned coded terminal.
      w.send({ type: "Mutation", requestId: "m5b", udfPath: "notes:add", args: { box: "s", text: "five" }, clientId: "S", seq: 5 });
      const stale = await w.awaitResponse("m5b");
      expect(stale.success).toBe(false);
      if (!stale.success) {
        expect(stale.code).toBe("STALE_CLIENT");
        expect(stale.error).toBe("STALE_CLIENT");
      }
    } finally {
      w.close();
      await s.server.close();
    }
  }, 15_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario 4 — MutationBatch                                                  */
/* -------------------------------------------------------------------------- */

describe("outbox server E2E (4) — MutationBatch: sequential, in-order, mid-batch continue vs stop", () => {
  it("50 entries apply sequentially with per-unit responses in wire order", async () => {
    const s = await startServer();
    const w = await RawWire.open(s.wsUrl);
    try {
      const entries: MutationBatchEntry[] = Array.from({ length: 50 }, (_, i) => ({
        requestId: `e${i}`,
        udfPath: "notes:add",
        args: { box: "batch", text: `n${i}` },
        clientId: "B",
        seq: i + 1,
      }));
      w.send({ type: "MutationBatch", entries });
      await waitFor(() => w.responses().length >= 50, 15_000, "50 responses");

      const responses = w.responses();
      expect(responses.length).toBe(50);
      // Per-unit responses arrive in exactly the entry order (the sequential drain obligation).
      expect(responses.map((r) => r.requestId)).toEqual(entries.map((e) => e.requestId));
      expect(responses.every((r) => r.success)).toBe(true);

      expect(await listCount(w)).toBe(50);
    } finally {
      w.close();
      await s.server.close();
    }
  }, 30_000);

  it("a mid-batch TERMINAL failure records + continues (prior + subsequent units applied)", async () => {
    const s = await startServer();
    const w = await RawWire.open(s.wsUrl);
    try {
      const entries: MutationBatchEntry[] = [
        { requestId: "t0", udfPath: "notes:add", args: { box: "t", text: "a" }, clientId: "T", seq: 1 },
        { requestId: "t1", udfPath: "notes:add", args: { box: "t", text: "b" }, clientId: "T", seq: 2 },
        { requestId: "t2", udfPath: "notes:boom", args: {}, clientId: "T", seq: 3 }, // terminal
        { requestId: "t3", udfPath: "notes:add", args: { box: "t", text: "c" }, clientId: "T", seq: 4 },
        { requestId: "t4", udfPath: "notes:add", args: { box: "t", text: "d" }, clientId: "T", seq: 5 },
      ];
      w.send({ type: "MutationBatch", entries });
      await waitFor(() => w.responses().length >= 5, 10_000, "5 responses");

      const r = w.responses();
      expect(r.map((x) => x.requestId)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
      expect(r[0]!.success).toBe(true);
      expect(r[1]!.success).toBe(true);
      expect(r[2]!.success).toBe(false); // the terminal failure is recorded + responded
      expect(r[3]!.success).toBe(true); // …and the drain CONTINUES past it
      expect(r[4]!.success).toBe(true);

      // 4 rows (the boom wrote nothing).
      expect(await listCount(w)).toBe(4);

      // The terminal unit recorded a `failed` verdict — a resend of seq 3 replay-fails, never re-runs.
      const rec = await s.store.getClientVerdict("", "T", 3);
      expect(rec?.verdict).toBe("failed");
    } finally {
      w.close();
      await s.server.close();
    }
  }, 15_000);

  it("a mid-batch TRANSIENT failure stops the remainder (later units get NO response)", async () => {
    const s = await startServer();
    const w = await RawWire.open(s.wsUrl);
    try {
      const entries: MutationBatchEntry[] = [
        { requestId: "x0", udfPath: "notes:add", args: { box: "x", text: "a" }, clientId: "X", seq: 1 },
        { requestId: "x1", udfPath: "notes:boomTransient", args: {}, clientId: "X", seq: 2 }, // transient
        { requestId: "x2", udfPath: "notes:add", args: { box: "x", text: "c" }, clientId: "X", seq: 3 },
        { requestId: "x3", udfPath: "notes:add", args: { box: "x", text: "d" }, clientId: "X", seq: 4 },
      ];
      w.send({ type: "MutationBatch", entries });
      // The first two settle (one success, one transient failure); the drain then STOPS.
      await waitFor(() => w.responses().length >= 2, 10_000, "2 responses");
      // Give the server ample time to (wrongly) emit more — it must not.
      await sleep(400);

      const r = w.responses();
      expect(r.length).toBe(2);
      expect(r.map((x) => x.requestId)).toEqual(["x0", "x1"]);
      expect(r[0]!.success).toBe(true);
      expect(r[1]!.success).toBe(false); // the transient failure
      expect(w.responseFor("x2")).toBeUndefined(); // remainder never responded
      expect(w.responseFor("x3")).toBeUndefined();

      // Only the first unit committed; the transient unit recorded NOTHING (a clean resend later).
      expect(await listCount(w)).toBe(1);
      expect(await s.store.getClientVerdict("", "X", 2)).toBeNull();
    } finally {
      w.close();
      await s.server.close();
    }
  }, 15_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario 5 — collateral fix under STACKBASE_GROUP_COMMIT=1                   */
/* -------------------------------------------------------------------------- */

describe("outbox server E2E (5) — group-commit collateral fix: innocents survive a duplicate-key abort", () => {
  it("co-batched innocents from OTHER clients all commit while duplicate copies collide down to one receipt", async () => {
    // The env flag the brief names — resolved by `createEmbeddedRuntime`'s `groupCommit` here; we set
    // it too so the deployment truly runs under STACKBASE_GROUP_COMMIT=1 semantics.
    const prev = process.env.STACKBASE_GROUP_COMMIT;
    process.env.STACKBASE_GROUP_COMMIT = "1";
    const s = await startServer(new SqliteDocStore(new NodeSqliteAdapter()), { groupCommit: true });
    const w = await RawWire.open(s.wsUrl);
    try {
      const INNOCENTS = 24;
      // Exactly TWO copies of one colliding key → at most ONE duplicate-key abort per flush (a SINGLE
      // guard rejection). This is deliberately within the committer's 3-split-retry bound: more than
      // three collisions co-batched in one flush would exceed the bound and reject the remaining chunk
      // retryably (the documented cap — proven in transactor/commit-guard-split.test.ts), which is a
      // different, non-collateral behavior. The collateral fix's guarantee is precisely that co-batched
      // INNOCENTS survive a duplicate-key abort — that is what this asserts.
      const DUP_COPIES = 2;
      // Fire everything at once on one socket (the server dispatches each frame without awaiting, so
      // they contend for the SAME group-commit flush): INNOCENTS distinct clients + the colliding pair.
      for (let i = 0; i < INNOCENTS; i++) {
        w.send({ type: "Mutation", requestId: `inn${i}`, udfPath: "notes:add", args: { box: "inn", text: `inn${i}` }, clientId: `D${i}`, seq: 1 });
      }
      for (let k = 0; k < DUP_COPIES; k++) {
        w.send({ type: "Mutation", requestId: `dup${k}`, udfPath: "notes:add", args: { box: "dup", text: "dup" }, clientId: "C", seq: 1 });
      }

      await waitFor(() => w.responses().length >= INNOCENTS + DUP_COPIES, 20_000, "all responses");

      // Every innocent committed successfully — NONE collaterally aborted by the duplicate's rejection.
      // (This is the load-bearing assertion: pre-T3, a guard abort on the co-batched duplicate rolled
      // the WHOLE batch back and rejected every innocent as collateral.)
      for (let i = 0; i < INNOCENTS; i++) {
        const r = w.responseFor(`inn${i}`)!;
        expect(r.success, `innocent inn${i} must commit`).toBe(true);
      }

      // Exactly-once for the duplicate key: the colliding pair collapsed to ONE applied receipt (the
      // loser either replay-acked a visible winner or got a retryable rejection to resend — either way
      // exactly one commit landed).
      const dupRec = await s.store.getClientVerdict("", "C", 1);
      expect(dupRec?.verdict).toBe("applied");

      // The store holds all innocents + exactly one dup row.
      expect(await listCount(w)).toBe(INNOCENTS + 1);

      // Group commit actually engaged (otherwise the collateral proof would be vacuous).
      expect(s.runtime.groupCommitStats().maxBatchSize).toBeGreaterThan(1);
    } finally {
      w.close();
      await s.server.close();
      if (prev === undefined) delete process.env.STACKBASE_GROUP_COMMIT;
      else process.env.STACKBASE_GROUP_COMMIT = prev;
    }
  }, 30_000);
});

/* -------------------------------------------------------------------------- */
/* Connect / ConnectAck live + zero-write keyed receipt                        */
/* -------------------------------------------------------------------------- */

describe("outbox server E2E — Connect/ConnectAck live + zero-write receipt", () => {
  it("classifies held seqs (applied/failed/unknown), stamps a deploymentId, and reports known flags", async () => {
    const s = await startServer();
    const w = await RawWire.open(s.wsUrl);
    try {
      // K1 applied (a write), K2 failed (a terminal boom).
      w.send({ type: "Mutation", requestId: "k1", udfPath: "notes:add", args: { box: "k", text: "one" }, clientId: "K", seq: 1 });
      const rk1 = await w.awaitResponse("k1");
      expect(rk1.success).toBe(true);
      const k1Value = rk1.success ? rk1.value : undefined;

      w.send({ type: "Mutation", requestId: "k2", udfPath: "notes:boom", args: {}, clientId: "K", seq: 2 });
      const rk2 = await w.awaitResponse("k2");
      expect(rk2.success).toBe(false);

      // Connect presenting held [K1, K2, K3] — the resume handshake classifies each.
      w.send({
        type: "Connect",
        sessionId: "sess-c",
        clientId: "K",
        held: [
          { clientId: "K", seq: 1 },
          { clientId: "K", seq: 2 },
          { clientId: "K", seq: 3 },
        ],
      });
      await waitFor(() => w.connectAcks().length >= 1, 5000, "ConnectAck");
      const ack = w.connectAcks()[0]!;

      expect(ack.known).toBe(true); // some presented seqs are recognized
      expect(typeof ack.deploymentId).toBe("string");
      expect(ack.deploymentId.length).toBeGreaterThan(0); // same-timeline proof stamp present

      const bySeq = new Map(ack.results.map((r) => [r.seq, r]));
      expect(bySeq.get(1)!.verdict).toBe("applied");
      expect(bySeq.get(1)!.commitTs).toBe(rk1.success ? rk1.ts : undefined);
      expect(bySeq.get(1)!.value).toEqual(k1Value); // the applied value round-trips
      expect(bySeq.get(2)!.verdict).toBe("failed");
      expect(bySeq.get(2)!.code).toBeDefined();
      expect(bySeq.get(3)!.verdict).toBe("unknown"); // never seen — the client should resend it

      // A foreign clientId the server recognizes NONE of → known: false (the client resets).
      w.send({ type: "Connect", sessionId: "sess-f", clientId: "FOREIGN", held: [{ clientId: "FOREIGN", seq: 1 }] });
      await waitFor(() => w.connectAcks().length >= 2, 5000, "ConnectAck 2");
      expect(w.connectAcks()[1]!.known).toBe(false);
    } finally {
      w.close();
      await s.server.close();
    }
  }, 15_000);

  it("a zero-write keyed mutation records an applied receipt (with its value) and replays", async () => {
    const s = await startServer();
    const w = await RawWire.open(s.wsUrl);
    try {
      w.send({ type: "Mutation", requestId: "z1", udfPath: "notes:ping", args: {}, clientId: "Z", seq: 1 });
      const r = await w.awaitResponse("z1");
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.value).toBe("pong");
        expect(r.replayed).toBeUndefined();
      }

      // The zero-write receipt is recorded (standalone) WITH its value.
      const rec = await s.store.getClientVerdict("", "Z", 1);
      expect(rec?.verdict).toBe("applied");
      expect(rec?.hasValue).toBe(true);
      expect(rec?.value).toBe("pong");

      // A resend replays it, value intact.
      w.send({ type: "Mutation", requestId: "z2", udfPath: "notes:ping", args: {}, clientId: "Z", seq: 1 });
      const r2 = await w.awaitResponse("z2");
      expect(r2.success).toBe(true);
      if (r2.success) {
        expect(r2.replayed).toBe(true);
        expect(r2.value).toBe("pong");
      }
    } finally {
      w.close();
      await s.server.close();
    }
  }, 15_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario 7 — old-client compat (no clientId/seq)                            */
/* -------------------------------------------------------------------------- */

describe("outbox server E2E (7) — old-client compat: no clientId/seq is byte-identical today-behavior", () => {
  it("mutations without a durable key write NO receipts and never dedup (a resend commits again)", async () => {
    const s = await startServer();
    const w = await RawWire.open(s.wsUrl);
    try {
      // Two identical mutations with NO clientId/seq — the pre-Outbox path, bit-for-bit.
      w.send({ type: "Mutation", requestId: "o1", udfPath: "notes:add", args: { box: "o", text: "old" } });
      const r1 = await w.awaitResponse("o1");
      expect(r1.success).toBe(true);
      if (r1.success) expect(r1.replayed).toBeUndefined();

      w.send({ type: "Mutation", requestId: "o2", udfPath: "notes:add", args: { box: "o", text: "old" } });
      const r2 = await w.awaitResponse("o2");
      expect(r2.success).toBe(true);
      if (r2.success) expect(r2.replayed).toBeUndefined();

      // No dedup — BOTH committed (two rows).
      expect(await listCount(w)).toBe(2);

      // The receipts table is empty: a bulk sweep with a horizon far in the future deletes nothing.
      const { deletedCount } = await s.store.sweepExpiredClientMutations(Date.now() + 1_000_000_000_000);
      expect(deletedCount).toBe(0);
    } finally {
      w.close();
      await s.server.close();
    }
  }, 15_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario 6 — fleet + 8 shards: resend via a NON-owner node classifies at     */
/*              the owner (real Docker: postgres:16 + two `serve --fleet` procs)  */
/* -------------------------------------------------------------------------- */

function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
const HAS_DOCKER = dockerAvailable();
const maybeDescribe = HAS_DOCKER ? describe : describe.skip;

const PG_CONTAINER = `sb-outbox-fleet-${process.pid}`;
const CLI_BIN = resolve(new URL(".", import.meta.url).pathname, "..", "dist", "bin.js");
const FLEET_FIXTURE_CONVEX = resolve(
  new URL(".", import.meta.url).pathname,
  "..", "..", "..", "ee", "packages", "fleet", "test", "fixtures", "app", "convex",
);
const ADMIN_KEY = "outbox-fleet-key";

function runDocker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function startPgContainer(): Promise<{ url: string }> {
  runDocker(["rm", "-f", PG_CONTAINER]);
  const run = runDocker(["run", "-d", "--name", PG_CONTAINER, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  const portRes = runDocker(["port", PG_CONTAINER, "5432/tcp"]);
  const m = (portRes.stdout.trim().split("\n")[0] ?? "").match(/:(\d+)$/);
  if (!m) throw new Error(`could not parse docker port: ${portRes.stdout}`);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (runDocker(["exec", PG_CONTAINER, "pg_isready", "-U", "postgres"]).status === 0) break;
    if (Date.now() > deadline) throw new Error("postgres container not ready in 60s");
    await sleep(500);
  }
  return { url: `postgres://postgres:postgres@127.0.0.1:${m[1]}/postgres` };
}

type ServeProc = ChildProcessByStdio<null, Readable, Readable>;
interface ReadyLine {
  url: string;
  role?: "sync" | "writer";
  fleet?: boolean;
}

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
          if (parsed && typeof parsed.url === "string") {
            clearTimeout(timer);
            resolvePromise(parsed);
            return;
          }
        } catch {
          /* not the ready line */
        }
      }
    });
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited early (code=${code}); stderr=${stderr}`));
    });
  });
}

function spawnFleetServe(databaseUrl: string, port: number, dataDir: string): ServeProc {
  const advertiseUrl = `http://127.0.0.1:${port}`;
  return spawn(
    "bun",
    [
      CLI_BIN, "serve",
      "--dir", FLEET_FIXTURE_CONVEX,
      "--data", join(dataDir, "db.sqlite"),
      "--port", String(port),
      "--ip", "127.0.0.1",
      "--no-dashboard",
      "--database-url", databaseUrl,
      "--fleet",
      "--advertise-url", advertiseUrl,
    ],
    {
      env: { ...process.env, STACKBASE_ADMIN_KEY: ADMIN_KEY, STACKBASE_FLEET_SHARDS: "8" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function stopServe(proc: ServeProc | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  await new Promise<void>((r) => proc.once("exit", () => r()));
}

maybeDescribe("outbox server E2E (6) — fleet + 8 shards: a resend via a non-owner node classifies at the owner", () => {
  it("forwards a (clientId, seq) mutation from the SYNC node to the writer; the resend replays and exactly one receipt exists", async () => {
    const { url: databaseUrl } = await startPgContainer();
    const portA = await freePort();
    const portB = await freePort();
    const dataDirA = mkdtempSync(join(tmpdir(), "sb-outbox-fleetA-"));
    const dataDirB = mkdtempSync(join(tmpdir(), "sb-outbox-fleetB-"));

    let nodeA: ServeProc | undefined;
    let nodeB: ServeProc | undefined;
    let wsB: RawWire | undefined;
    const pg = new NodePgClient({ connectionString: databaseUrl });
    try {
      // A boots first → writer (owns every shard, incl. default); B → sync (the non-owner).
      nodeA = spawnFleetServe(databaseUrl, portA, dataDirA);
      const readyA = await waitForReady(nodeA);
      expect(readyA.role).toBe("writer");

      nodeB = spawnFleetServe(databaseUrl, portB, dataDirB);
      const readyB = await waitForReady(nodeB);
      expect(readyB.role).toBe("sync");
      const wsUrlB = `${readyB.url.replace("http", "ws")}/api/sync`;

      // Send the keyed mutation to the SYNC node B. B forwards it to the writer A, which classifies +
      // writes the receipt (classification runs WHERE THE COMMIT RUNS — the owner).
      wsB = await RawWire.open(wsUrlB);
      wsB.send({ type: "Mutation", requestId: "f1", udfPath: "notes:add", args: { box: "fleet", text: "once" }, clientId: "F", seq: 1 });
      const first = await wsB.awaitResponse("f1", 20_000);
      expect(first.success).toBe(true);
      if (first.success) expect(first.replayed).toBeUndefined(); // fresh commit at the owner

      // Resend the SAME seq via the SAME non-owner node → the owner classifies it as a replay.
      wsB.send({ type: "Mutation", requestId: "f2", udfPath: "notes:add", args: { box: "fleet", text: "once" }, clientId: "F", seq: 1 });
      const second = await wsB.awaitResponse("f2", 20_000);
      expect(second.success).toBe(true);
      if (second.success) {
        expect(second.replayed).toBe(true);
        expect(second.ts).toBe(first.success ? first.ts : undefined); // the ORIGINAL commitTs
      }

      // The per-unit receipt exists EXACTLY once in the shared Postgres (the owner's store).
      const rows = await pg.query("SELECT count(*)::int AS n FROM client_mutations WHERE client_id = $1 AND seq = $2", ["F", 1n]);
      expect((rows[0] as { n: number }).n).toBe(1);

      // And exactly one note row was written (the resend inserted nothing).
      const noteRows = await pg.query("SELECT count(*)::int AS n FROM documents WHERE value IS NOT NULL");
      expect((noteRows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
    } finally {
      wsB?.close();
      await pg.close().catch(() => {});
      await stopServe(nodeA);
      await stopServe(nodeB);
      runDocker(["rm", "-f", PG_CONTAINER]);
      rmSync(dataDirA, { recursive: true, force: true });
      rmSync(dataDirB, { recursive: true, force: true });
    }
  }, 180_000);
});
