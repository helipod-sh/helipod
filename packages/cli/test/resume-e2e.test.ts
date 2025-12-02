/**
 * Subscription resume (design 2026-07-11) — the E2E gate through the real server (Testing §3 of
 * docs/superpowers/specs/2026-07-11-subscription-resume-design.md). Tasks 1-2 shipped the wire +
 * client mechanism on this branch: the server mints a `hash` on every `QueryUpdated`; a resuming
 * client's `resync()` echoes each answered subscription's last hash back as `resultHash` on its
 * `ModifyQuerySet` add entry; a fresh-run hash match replies `{type:"QueryUnchanged", queryId}`
 * instead of resending the full value. This file drives that mechanism through a REAL
 * `StackbaseClient` over a REAL WebSocket against a REAL `stackbase dev` server (the
 * `outbox-fs-e2e.test.ts` / `optimistic-e2e.test.ts` harness pattern), asserting at the WIRE FRAME
 * level — a wrapping transport records every parsed `ServerMessage` in arrival order, and each
 * scenario counts `QueryUnchanged` vs `QueryUpdated` inside the resume `Transition` directly.
 *
 * Four scenarios (task-3-brief.md):
 *   (1) all-unchanged resume — 5 subscriptions answered, the socket is killed and reconnects
 *       (engine stays alive; a transparent TCP proxy makes this a network blip, not a restart), and
 *       NOTHING changed while down: the resume `Transition` carries exactly 5 `QueryUnchanged` and
 *       0 `QueryUpdated`.
 *   (2) one changed — same 5 subscriptions, but a SECOND client commits a write touching query 3's
 *       table while the first client is down: the resume `Transition` carries exactly 1
 *       `QueryUpdated` (query 3, fresh hash, correct value) and 4 `QueryUnchanged`.
 *   (3) outbox composition — an `fsOutbox` client with 3 subscriptions goes down, durably enqueues a
 *       2-mutation backlog while down, then reconnects: the resume `Transition` (sent BEFORE the
 *       `Connect` handshake per `onTransportReopened`'s ordering) still shows all 3 `QueryUnchanged`
 *       (nothing has committed yet), the drain then commits the backlog, and the backlog's own
 *       write arrives afterward as a full reactive `QueryUpdated` (a reactive push never sends
 *       `QueryUnchanged` — see protocol.ts) with `pendingMutations()` emptying.
 *   (4) old-client compat — a raw (no `StackbaseClient`) `ws` client that sends `ModifyQuerySet`
 *       without ever echoing `resultHash`, even on a second subscribe AFTER already having received
 *       hashed `QueryUpdated`s, never receives `QueryUnchanged` — full sends only, byte-compatible
 *       degradation for a peer that predates this feature.
 */
import { describe, it, expect } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@stackbase/values";
import type { Value } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi, type ClientTransport } from "@stackbase/client";
import { fsOutbox } from "@stackbase/client/outbox-fs";
import type { ClientMessage, ServerMessage, QueryRequest } from "@stackbase/sync";
import { loadProject, startDevServer, type DevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixture — two tables, five queries (task-3-brief.md's mandated shape)       */
/* -------------------------------------------------------------------------- */

const schema = defineSchema({
  notes: defineTable({ box: v.string(), text: v.string() }).index("by_box", ["box"]),
  counters: defineTable({ name: v.string(), n: v.number() }).index("by_name", ["name"]),
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
const countersModule = {
  bump: mutation<{ name: string }, string>({
    handler: (ctx, { name }) => ctx.db.insert("counters", { name, n: 1 }),
  }),
  list: query<{ name: string }, unknown[]>({
    handler: (ctx, { name }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx.db.query("counters", "by_name") as any).eq("name", name).collect(),
  }),
};

function loaded() {
  return { schema, modules: { notes: notesModule, counters: countersModule } };
}

const api = anyApi as {
  notes: { add: { __path: string }; list: { __path: string } };
  counters: { bump: { __path: string }; list: { __path: string } };
};

async function startServer(): Promise<{ runtime: EmbeddedRuntime; server: DevServer }> {
  const project = loadProject(loaded());
  const runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  return { runtime, server };
}

/* -------------------------------------------------------------------------- */
/* Shared helpers (self-contained — this file owns no shared harness module)   */
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

/** A `webSocketTransport` over `ws` (Node has no global WebSocket in this runtime). */
function nodeWsTransport(url: string, opts?: { initialBackoffMs?: number; maxBackoffMs?: number }): ClientTransport {
  return webSocketTransport(url, {
    initialBackoffMs: opts?.initialBackoffMs ?? 150,
    maxBackoffMs: opts?.maxBackoffMs ?? 500,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createWebSocket: (u) => new WebSocket(u) as unknown as any,
  });
}

/**
 * Wraps a `ClientTransport`, recording every inbound `ServerMessage` (wire-arrival order) and every
 * outbound `ClientMessage` — the frame-level visibility the Unchanged/Updated assertions need.
 * Delegates onClose/onReopen/close so the wrapped transport's reconnect state machine is untouched.
 */
function recordingTransport(inner: ClientTransport): {
  transport: ClientTransport;
  inbound: ServerMessage[];
  outbound: ClientMessage[];
} {
  const inbound: ServerMessage[] = [];
  const outbound: ClientMessage[] = [];
  const transport: ClientTransport = {
    send(m) {
      outbound.push(m);
      inner.send(m);
    },
    onMessage(listener) {
      return inner.onMessage((msg) => {
        inbound.push(msg);
        listener(msg);
      });
    },
    onClose(listener) {
      return inner.onClose(listener);
    },
    onReopen: inner.onReopen ? (listener) => inner.onReopen!(listener) : undefined,
    close() {
      inner.close();
    },
  };
  return { transport, inbound, outbound };
}

type TransitionMsg = Extract<ServerMessage, { type: "Transition" }>;
function isTransition(m: ServerMessage): m is TransitionMsg {
  return m.type === "Transition";
}

/** The first `Transition` at/after `fromIndex` whose modification count is exactly `modCount` — a
 *  resume's batched `resync()` `ModifyQuerySet` reply is the only Transition carrying ALL of a
 *  client's live subscriptions in one frame, so this reliably picks it out from the individual
 *  one-mod Transitions each `subscribe()` call produces on first connect. */
function findTransitionAfter(inbound: readonly ServerMessage[], fromIndex: number, modCount: number): TransitionMsg | undefined {
  for (let i = fromIndex; i < inbound.length; i++) {
    const m = inbound[i]!;
    if (isTransition(m) && m.modifications.length === modCount) return m;
  }
  return undefined;
}

/**
 * A transparent TCP proxy so the socket can be killed "server-side" while the engine + store stay
 * fully alive (a genuine network blip, not a server restart) — copied from optimistic-e2e.test.ts's
 * pattern, trimmed to just what resume needs (`kill`/`close`).
 */
async function tcpProxy(backendPort: number): Promise<{ port: number; kill(): void; close(): Promise<void> }> {
  interface Pair {
    client: net.Socket;
    upstream: net.Socket;
  }
  const pairs = new Set<Pair>();
  const server = net.createServer((client) => {
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
    upstream.on("data", (d) => client.write(d));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const killAll = (): void => {
    for (const p of pairs) {
      p.client.destroy();
      p.upstream.destroy();
    }
    pairs.clear();
  };
  return {
    port,
    kill: killAll,
    close() {
      killAll();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** A raw WebSocket to `/api/sync` that records every inbound `ServerMessage` and sends arbitrary
 *  `ClientMessage`s directly — the "old client that predates this feature" harness (scenario 4),
 *  copied down from the `outbox-server-e2e.test.ts` `RawWire` pattern. */
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

  close(): void {
    this.ws.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Scenario 1 — all-unchanged resume                                          */
/* -------------------------------------------------------------------------- */

describe("resume E2E (1) — all-unchanged resume", () => {
  it("5 subscriptions resume via QueryUnchanged (0 QueryUpdated) after a reconnect with no data change", async () => {
    const { server } = await startServer();
    const proxy = await tcpProxy(server.port);
    const wsUrl = `ws://127.0.0.1:${proxy.port}/api/sync`;
    const recorded = recordingTransport(nodeWsTransport(wsUrl));
    const client = new StackbaseClient(recorded.transport);
    try {
      const framesA: unknown[][] = [];
      const framesB: unknown[][] = [];
      const framesC: unknown[][] = [];
      const framesX: unknown[][] = [];
      const framesY: unknown[][] = [];
      client.subscribe(api.notes.list, { box: "a" }, (v) => framesA.push(v as unknown[]));
      client.subscribe(api.notes.list, { box: "b" }, (v) => framesB.push(v as unknown[]));
      client.subscribe(api.notes.list, { box: "c" }, (v) => framesC.push(v as unknown[]));
      client.subscribe(api.counters.list, { name: "x" }, (v) => framesX.push(v as unknown[]));
      client.subscribe(api.counters.list, { name: "y" }, (v) => framesY.push(v as unknown[]));
      await waitFor(() => [framesA, framesB, framesC, framesX, framesY].every((f) => f.length >= 1), 5000, "5 initial subs");
      for (const f of [framesA, framesB, framesC, framesX, framesY]) expect(f[0]).toEqual([]);

      const preKillLen = recorded.inbound.length;
      proxy.kill();

      await waitFor(() => findTransitionAfter(recorded.inbound, preKillLen, 5) !== undefined, 20_000, "resume transition (5 mods)");
      const resumeT = findTransitionAfter(recorded.inbound, preKillLen, 5)!;
      const unchanged = resumeT.modifications.filter((m) => m.type === "QueryUnchanged");
      const updated = resumeT.modifications.filter((m) => m.type === "QueryUpdated");
      expect(unchanged).toHaveLength(5);
      expect(updated).toHaveLength(0);

      // Subs stayed answered with intact values — the last delivered frame is still the empty list,
      // consistent with QueryUnchanged never invalidating what the client already has.
      for (const f of [framesA, framesB, framesC, framesX, framesY]) expect(f.at(-1)).toEqual([]);
    } finally {
      client.close();
      await proxy.close();
      await server.close();
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario 2 — one changed while down                                        */
/* -------------------------------------------------------------------------- */

describe("resume E2E (2) — one query changed while disconnected", () => {
  it("resume delivers exactly 1 full QueryUpdated (fresh hash, correct value) and 4 QueryUnchanged", async () => {
    const { server } = await startServer();
    const proxy = await tcpProxy(server.port);
    const wsUrl = `ws://127.0.0.1:${proxy.port}/api/sync`;
    const directUrl = `ws://127.0.0.1:${server.port}/api/sync`;
    const recorded = recordingTransport(nodeWsTransport(wsUrl));
    const client = new StackbaseClient(recorded.transport);
    const other = new StackbaseClient(webSocketTransport(directUrl, { reconnect: false }));
    try {
      const framesA: unknown[][] = [];
      const framesB: unknown[][] = [];
      const framesC: unknown[][] = [];
      const framesX: unknown[][] = [];
      const framesY: unknown[][] = [];
      client.subscribe(api.notes.list, { box: "a" }, (v) => framesA.push(v as unknown[]));
      client.subscribe(api.notes.list, { box: "b" }, (v) => framesB.push(v as unknown[]));
      client.subscribe(api.notes.list, { box: "c" }, (v) => framesC.push(v as unknown[])); // query 3
      client.subscribe(api.counters.list, { name: "x" }, (v) => framesX.push(v as unknown[]));
      client.subscribe(api.counters.list, { name: "y" }, (v) => framesY.push(v as unknown[]));
      await waitFor(() => [framesA, framesB, framesC, framesX, framesY].every((f) => f.length >= 1), 5000, "5 initial subs");

      // The queryId query-3 (notes:list box=c) was assigned on the wire — recover it from the
      // outbound log so the resume Transition's single QueryUpdated can be matched to it precisely.
      const query3Add = recorded.outbound.find(
        (m): m is Extract<ClientMessage, { type: "ModifyQuerySet" }> =>
          m.type === "ModifyQuerySet" &&
          m.add.some((a) => a.udfPath === "notes:list" && (a.args as { box?: string }).box === "c"),
      )!.add.find((a) => a.udfPath === "notes:list" && (a.args as { box?: string }).box === "c")!;
      const query3Id = query3Add.queryId;

      const preKillLen = recorded.inbound.length;
      proxy.kill();

      // A SECOND client, connected directly (never through the killed proxy), commits a write to
      // query 3's table while the first client is down.
      await other.mutation(api.notes.add, { box: "c", text: "during-outage" });

      await waitFor(() => findTransitionAfter(recorded.inbound, preKillLen, 5) !== undefined, 20_000, "resume transition (5 mods)");
      const resumeT = findTransitionAfter(recorded.inbound, preKillLen, 5)!;
      const unchanged = resumeT.modifications.filter((m) => m.type === "QueryUnchanged");
      const updated = resumeT.modifications.filter((m) => m.type === "QueryUpdated");
      expect(unchanged).toHaveLength(4);
      expect(updated).toHaveLength(1);

      const upd = updated[0] as Extract<TransitionMsg["modifications"][number], { type: "QueryUpdated" }>;
      expect(upd.queryId).toBe(query3Id);
      expect(typeof upd.hash).toBe("string");
      const rows = upd.value as Array<{ text: string }>;
      expect(rows.map((r) => r.text)).toEqual(["during-outage"]);

      await waitFor(() => framesC.some((f) => (f as Array<{ text: string }>).some((d) => d.text === "during-outage")), 5000, "client converges");
    } finally {
      client.close();
      other.close();
      await proxy.close();
      await server.close();
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario 3 — outbox composition                                            */
/* -------------------------------------------------------------------------- */

describe("resume E2E (3) — outbox composition: resume Unchanged + backlog drain + reactive QueryUpdated", () => {
  it("3 subscriptions resume Unchanged, the 2-mutation backlog drains, and its own write arrives as a full reactive QueryUpdated", async () => {
    const { server } = await startServer();
    const proxy = await tcpProxy(server.port);
    const wsUrl = `ws://127.0.0.1:${proxy.port}/api/sync`;
    const dir = mkdtempSync(join(tmpdir(), "sb-resume-outbox-e2e-"));
    const transport = nodeWsTransport(wsUrl);
    const recorded = recordingTransport(transport);
    const outbox = fsOutbox({ dir });
    const client = new StackbaseClient(recorded.transport, { outbox, outboxLocks: null, outboxDrainIntervalMs: 0 });
    try {
      const framesA: unknown[][] = [];
      const framesB: unknown[][] = [];
      const framesBacklog: unknown[][] = [];
      client.subscribe(api.notes.list, { box: "a" }, (v) => framesA.push(v as unknown[]));
      client.subscribe(api.notes.list, { box: "b" }, (v) => framesB.push(v as unknown[]));
      client.subscribe(api.notes.list, { box: "backlog" }, (v) => framesBacklog.push(v as unknown[]));
      await waitFor(() => [framesA, framesB, framesBacklog].every((f) => f.length >= 1), 5000, "3 initial subs");

      const preKillLen = recorded.inbound.length;

      // Issue the offline backlog from the client's OWN onClose observation — guarantees the socket
      // is genuinely down first (mirrors optimistic-e2e.test.ts's reconnect scenario), then kill.
      let offline1: Promise<Value> | undefined;
      let offline2: Promise<Value> | undefined;
      transport.onClose(() => {
        if (offline1) return;
        offline1 = client.mutation(api.notes.add, { box: "backlog", text: "b0" });
        offline2 = client.mutation(api.notes.add, { box: "backlog", text: "b1" });
      });
      proxy.kill();
      await waitFor(() => offline1 !== undefined && offline2 !== undefined, 5000, "observe close + durable enqueue");
      void offline1!.catch(() => {});
      void offline2!.catch(() => {});

      // Resume happens BEFORE the Connect handshake / drain (onTransportReopened's ordering) — at
      // that instant nothing has committed yet, so all 3 subscriptions (including "backlog", whose
      // table the queued mutations target) resume Unchanged.
      await waitFor(() => findTransitionAfter(recorded.inbound, preKillLen, 3) !== undefined, 20_000, "resume transition (3 mods)");
      const resumeT = findTransitionAfter(recorded.inbound, preKillLen, 3)!;
      expect(resumeT.modifications.filter((m) => m.type === "QueryUnchanged")).toHaveLength(3);
      expect(resumeT.modifications.filter((m) => m.type === "QueryUpdated")).toHaveLength(0);
      const resumeIdx = recorded.inbound.indexOf(resumeT);

      // The drain then commits the backlog — both mutations settle, pendingMutations() empties.
      await offline1!;
      await offline2!;
      await waitFor(async () => (await client.pendingMutations()).length === 0, 20_000, "drain empties");
      expect(await client.pendingMutations()).toHaveLength(0);

      // The backlog's own write converges the subscribed value to both rows...
      await waitFor(() => framesBacklog.some((f) => (f as Array<{ text: string }>).length === 2), 10_000, "backlog converges");
      const lastBacklog = framesBacklog.at(-1) as Array<{ text: string }>;
      expect(lastBacklog.map((r) => r.text).sort()).toEqual(["b0", "b1"]);

      // ...and it arrived via a full reactive QueryUpdated, never QueryUnchanged: the reactive push
      // path (protocol.ts) only ever sends QueryUpdated — no Unchanged variant appears anywhere
      // after the resume Transition.
      const postResume = recorded.inbound.slice(resumeIdx + 1).filter(isTransition).flatMap((t) => t.modifications);
      expect(postResume.some((m) => m.type === "QueryUpdated")).toBe(true);
      expect(postResume.filter((m) => m.type === "QueryUnchanged")).toHaveLength(0);
    } finally {
      client.close();
      await outbox.close?.();
      await proxy.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Scenario 4 — old-client compat                                             */
/* -------------------------------------------------------------------------- */

describe("resume E2E (4) — old-client compat: a peer that never echoes resultHash never receives QueryUnchanged", () => {
  it("a raw ws client resubscribing WITHOUT resultHash after already receiving hashed results gets full QueryUpdateds, zero QueryUnchanged", async () => {
    const { server } = await startServer();
    const wire = await RawWire.open(`ws://127.0.0.1:${server.port}/api/sync`);
    try {
      const specs: QueryRequest[] = [
        { queryId: 1, udfPath: "notes:list", args: { box: "a" } },
        { queryId: 2, udfPath: "notes:list", args: { box: "b" } },
        { queryId: 3, udfPath: "notes:list", args: { box: "c" } },
        { queryId: 4, udfPath: "counters:list", args: { name: "x" } },
        { queryId: 5, udfPath: "counters:list", args: { name: "y" } },
      ];

      // First subscribe — no resultHash anywhere (this "client" never learned the field).
      wire.send({ type: "ModifyQuerySet", add: specs, remove: [] });
      await waitFor(() => findTransitionAfter(wire.inbound, 0, 5) !== undefined, 10_000, "initial 5");
      const first = findTransitionAfter(wire.inbound, 0, 5)!;
      expect(first.modifications.filter((m) => m.type === "QueryUpdated")).toHaveLength(5);
      expect(first.modifications.filter((m) => m.type === "QueryUnchanged")).toHaveLength(0);
      // The server DID mint hashes for this old client — it just never gets echoed back.
      for (const m of first.modifications) {
        expect(m.type).toBe("QueryUpdated");
        if (m.type === "QueryUpdated") expect(typeof m.hash).toBe("string");
      }

      const firstIdx = wire.inbound.indexOf(first);

      // Re-issue the SAME subscribe set — an old-client "resume"/resubscribe — again without
      // resultHash, despite having just received hashed QueryUpdateds above.
      wire.send({ type: "ModifyQuerySet", add: specs, remove: [] });
      await waitFor(() => findTransitionAfter(wire.inbound, firstIdx + 1, 5) !== undefined, 10_000, "second 5");
      const second = findTransitionAfter(wire.inbound, firstIdx + 1, 5)!;
      expect(second.modifications.filter((m) => m.type === "QueryUpdated")).toHaveLength(5);
      expect(second.modifications.filter((m) => m.type === "QueryUnchanged")).toHaveLength(0);

      // Zero QueryUnchanged anywhere in the whole session.
      const anyUnchanged = wire.inbound.filter(isTransition).flatMap((t) => t.modifications).filter((m) => m.type === "QueryUnchanged");
      expect(anyUnchanged).toHaveLength(0);
    } finally {
      wire.close();
      await server.close();
    }
  }, 30_000);
});
