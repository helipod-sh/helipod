/**
 * DLR Stage 3, Task 5 — the COMPUTE-skip E2E gate (task-5-brief.md). Tasks 1-4 (this branch) wired
 * a `ResumeRegistry` that tracks, per `(identity, path, args)`, the read set a query last ran with
 * and the timestamp through which its result is provably still current (`lastInvalidatedTs`). On a
 * reconnect resubscribe carrying `sinceTs`, a RERUN (non-diffable) subscription whose
 * `entry.lastInvalidatedTs <= sinceTs` answers `QueryUnchanged` WITHOUT calling `execSub` at all
 * (`packages/sync/src/handler.ts` around the `q.sinceTs !== undefined` branch) — a genuine compute
 * skip, not merely the bandwidth-only `QueryUnchanged` the older resume design already sent for
 * every subscription kind.
 *
 * `resume-e2e.test.ts` (this branch's Task 3) proves the WIRE SHAPE of resume for DIFFABLE_RANGE
 * subscriptions (`.eq().collect()`), which are explicitly excluded from the compute skip (they have
 * their own fingerprint/QueryDiff resume path, and always re-run `execSub` on resume regardless of
 * `sinceTs` — see the skip check's `!entry.wasDiffable` guard). This file proves the actual COMPUTE
 * side for a genuinely RERUN subscription: a query that returns a post-processed scalar (`rows.length`)
 * rather than the branded array `.collect()` returns, which the executor's identity-brand passthrough
 * (`executor.ts`'s `COLLECT_BRAND` check) requires for `diffableRange` — returning a *new* number value
 * loses the brand, so `classifyByIdRead`/`diffableRange`/`diffablePage` all come back empty and the sub
 * is classified RERUN (the executor's documented "safe fallback").
 *
 * Server-side execution is counted via a module-level counter (`countExecs`) the RERUN handler bumps
 * on every real invocation, read back through a SEPARATE one-shot query (`execCount`) that does not
 * itself bump the counter — so reading it never perturbs what's being measured. Assertions are always
 * on DELTAS (count-after minus count-before), never absolute values, since the handler legitimately
 * runs once at initial subscribe (a "warmup" execution outside the scope of what's being proven).
 *
 * Two required scenarios, driven through a REAL `helipod dev` server + a REAL `@helipod/client`
 * over a REAL WebSocket (the `resume-e2e.test.ts` tcpProxy idiom — the engine stays alive across the
 * kill, so this is a genuine network blip, not a restart):
 *   (1) unchanged reconnect — kill+reopen the SAME client with no intervening write: the resume
 *       Transition carries `QueryUnchanged` for the RERUN query AND `execCount`'s delta is 0 (the
 *       server literally never re-ran the handler). Folded into the SAME scenario: a DIFFABLE_RANGE
 *       sibling subscription (`notes:list`, unmodified `.collect()` passthrough) in the same app is
 *       proven to STILL re-run on the very same unchanged reconnect (the v1 boundary — diffable subs
 *       are excluded from the compute skip), via its own independent execution counter.
 *   (2) gap re-run — while disconnected, a second client commits an intersecting `notes:add` (same
 *       `box`): on reconnect the resume Transition carries a fresh `QueryUpdated` (not
 *       `QueryUnchanged`) with the new count, AND `execCount`'s delta is >= 1 (the handler really did
 *       re-run to pick up the write).
 */
import { describe, it, expect } from "vitest";
import net from "node:net";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@helipod/values";
import { query, mutation } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, webSocketTransport, anyApi, type ClientTransport } from "@helipod/client";
import type { ClientMessage, ServerMessage } from "@helipod/sync";
import { loadProject, startDevServer, type DevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixture — a RERUN scalar query (`count`) + its execution counter, plus a    */
/* DIFFABLE_RANGE sibling (`list`) + its OWN independent execution counter.    */
/* -------------------------------------------------------------------------- */

const schema = defineSchema({
  notes: defineTable({ box: v.string(), text: v.string() }).index("by_box", ["box"]),
});

// Module-level, bumped ONLY by the query handlers that legitimately re-run — never by the
// `execCount`/`listExecCount` readers, so reading them never perturbs what's being measured. Safe as
// plain closures: the inline (non-isolated) executor runs handlers in-process against the same module
// instance for the lifetime of the test (see CLAUDE.md's "true V8-isolate sandboxing" deferred note).
let countExecs = 0;
let listExecs = 0;

const notesModule = {
  add: mutation<{ box: string; text: string }, string>({
    handler: (ctx, { box, text }) => ctx.db.insert("notes", { box, text }),
  }),
  // RERUN: returns `rows.length` (a new number), not the branded `.collect()` array itself — the
  // executor's identity-brand passthrough requires the UNMODIFIED branded array to classify
  // DIFFABLE_RANGE, so post-processing it into a scalar forces the "safe fallback" RERUN path.
  count: query<{ box: string }, number>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (ctx, { box }) => {
      countExecs++;
      const rows = (await (ctx.db.query("notes", "by_box") as any).eq("box", box).collect()) as unknown[];
      return rows.length;
    },
  }),
  execCount: query<Record<string, never>, number>({
    handler: () => countExecs,
  }),
  // DIFFABLE_RANGE sibling (unmodified `.collect()` passthrough, same shape resume-e2e.test.ts uses)
  // — its own resume path always re-runs `execSub` regardless of `sinceTs` (the compute skip is
  // RERUN-only), so its execution counter must advance even on an all-unchanged reconnect.
  list: query<{ box: string }, unknown[]>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (ctx, { box }) => {
      listExecs++;
      return (ctx.db.query("notes", "by_box") as any).eq("box", box).collect();
    },
  }),
  listExecCount: query<Record<string, never>, number>({
    handler: () => listExecs,
  }),
};

function loaded() {
  return { schema, modules: { notes: notesModule } };
}

const api = anyApi as {
  notes: {
    add: { __path: string };
    count: { __path: string };
    execCount: { __path: string };
    list: { __path: string };
    listExecCount: { __path: string };
  };
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
/* Shared helpers — copied down from resume-e2e.test.ts (self-contained file   */
/* convention: this file owns no shared harness module).                      */
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

/** The first `Transition` at/after `fromIndex` whose modification count is exactly `modCount`. */
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
 * pattern via resume-e2e.test.ts, trimmed to just what resume needs (`kill`/`close`).
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

/* -------------------------------------------------------------------------- */
/* Scenario 1 — all-unchanged reconnect: the RERUN sub is compute-skipped,     */
/* the DIFFABLE sibling still re-runs (v1 boundary).                          */
/* -------------------------------------------------------------------------- */

describe("resume compute E2E (1) — unchanged reconnect skips the RERUN re-execution", () => {
  it(
    "notes:count resumes via QueryUnchanged with ZERO handler re-executions; notes:list (diffable) still re-runs",
    async () => {
      const { server } = await startServer();
      const proxy = await tcpProxy(server.port);
      const wsUrl = `ws://127.0.0.1:${proxy.port}/api/sync`;
      const directUrl = `ws://127.0.0.1:${server.port}/api/sync`;
      const recorded = recordingTransport(nodeWsTransport(wsUrl));
      const client = new HelipodClient(recorded.transport);
      // A separate client, connected DIRECTLY (never through the killed proxy), used purely to read
      // the execution counters — a one-shot `query()` (subscribe -> resolve -> unsubscribe) never
      // perturbs the RERUN/diffable subs' own resume-registry entries (different udfPath+args).
      const reader = new HelipodClient(webSocketTransport(directUrl, { reconnect: false }));
      try {
        const countFrames: number[] = [];
        const listFrames: unknown[][] = [];
        client.subscribe(api.notes.count, { box: "a" }, (v) => countFrames.push(v as number));
        client.subscribe(api.notes.list, { box: "a" }, (v) => listFrames.push(v as unknown[]));
        await waitFor(() => countFrames.length >= 1 && listFrames.length >= 1, 5000, "2 initial subs");
        expect(countFrames[0]).toBe(0);
        expect(listFrames[0]).toEqual([]);

        const countExecsBefore = (await reader.query(api.notes.execCount, {})) as number;
        const listExecsBefore = (await reader.query(api.notes.listExecCount, {})) as number;

        const preKillLen = recorded.inbound.length;
        proxy.kill();

        // No intervening write — the resume Transition should carry exactly 2 modifications: the
        // RERUN sub's QueryUnchanged (compute-skipped) and the diffable sub's own resume answer
        // (which STILL re-ran execSub — see the skip check's `!entry.wasDiffable` guard).
        await waitFor(() => findTransitionAfter(recorded.inbound, preKillLen, 2) !== undefined, 20_000, "resume transition (2 mods)");
        const resumeT = findTransitionAfter(recorded.inbound, preKillLen, 2)!;

        // Identify each sub's own modification by queryId (recovered from the outbound `ModifyQuerySet`
        // log, the same idiom resume-e2e.test.ts uses) rather than by wire shape — a RERUN's answer is
        // `QueryUnchanged` or a plain `QueryUpdated` (never `QueryDiff`), while the diffable sibling's
        // resume answer may be `QueryUnchanged` OR `QueryDiff`, so shape alone can't disambiguate them.
        const countAdd = recorded.outbound.find(
          (m): m is Extract<ClientMessage, { type: "ModifyQuerySet" }> =>
            m.type === "ModifyQuerySet" && m.add.some((a) => a.udfPath === "notes:count"),
        )!.add.find((a) => a.udfPath === "notes:count")!;
        const listAdd = recorded.outbound.find(
          (m): m is Extract<ClientMessage, { type: "ModifyQuerySet" }> =>
            m.type === "ModifyQuerySet" && m.add.some((a) => a.udfPath === "notes:list"),
        )!.add.find((a) => a.udfPath === "notes:list")!;

        const countResumeMod = resumeT.modifications.find((m) => "queryId" in m && m.queryId === countAdd.queryId)!;
        const listResumeMod = resumeT.modifications.find((m) => "queryId" in m && m.queryId === listAdd.queryId)!;

        // The RERUN sub resumes via QueryUnchanged — never QueryDiff (that shape is diffable-only).
        expect(countResumeMod.type).toBe("QueryUnchanged");
        // The diffable sibling's own resume answer — QueryUnchanged (bandwidth-only, matching hash)
        // or QueryDiff are both valid wire shapes; what matters for THIS test is that its handler
        // still ran (asserted via the counter below), not which shape the (unchanged) content took.
        expect(["QueryUnchanged", "QueryDiff"]).toContain(listResumeMod.type);

        const countExecsAfter = (await reader.query(api.notes.execCount, {})) as number;
        const listExecsAfter = (await reader.query(api.notes.listExecCount, {})) as number;

        // THE compute-skip assertion: the RERUN handler did NOT run again across the reconnect.
        expect(countExecsAfter - countExecsBefore).toBe(0);
        // THE v1-boundary assertion: the diffable sibling's handler DID run again, even though its
        // content was unchanged too — diffable subs are excluded from the compute skip in v1.
        expect(listExecsAfter - listExecsBefore).toBeGreaterThanOrEqual(1);

        // Values stayed correct across the whole exercise.
        expect(countFrames.at(-1)).toBe(0);
        expect(listFrames.at(-1)).toEqual([]);
      } finally {
        client.close();
        reader.close();
        await proxy.close();
        await server.close();
      }
    },
    60_000,
  );
});

/* -------------------------------------------------------------------------- */
/* Scenario 2 — a gap write re-runs the RERUN sub on reconnect (correctness    */
/* counterpart to scenario 1's skip).                                        */
/* -------------------------------------------------------------------------- */

describe("resume compute E2E (2) — an intersecting gap write forces a real re-run", () => {
  it(
    "notes:count resumes via a fresh QueryUpdated with the new value, and the handler DID re-execute",
    async () => {
      const { server } = await startServer();
      const proxy = await tcpProxy(server.port);
      const wsUrl = `ws://127.0.0.1:${proxy.port}/api/sync`;
      const directUrl = `ws://127.0.0.1:${server.port}/api/sync`;
      const recorded = recordingTransport(nodeWsTransport(wsUrl));
      const client = new HelipodClient(recorded.transport);
      // A SECOND client, connected directly (never through the killed proxy) — both commits the
      // intersecting write during the gap and reads the execution counter before/after.
      const other = new HelipodClient(webSocketTransport(directUrl, { reconnect: false }));
      try {
        const countFrames: number[] = [];
        client.subscribe(api.notes.count, { box: "a" }, (v) => countFrames.push(v as number));
        await waitFor(() => countFrames.length >= 1, 5000, "initial count sub");
        expect(countFrames[0]).toBe(0);

        const execBefore = (await other.query(api.notes.execCount, {})) as number;

        const preKillLen = recorded.inbound.length;
        proxy.kill();

        // An intersecting write DURING the gap (same box="a") — this must advance the resume
        // registry's `lastInvalidatedTs` past the client's `sinceTs`, forcing a real re-run on resume.
        await other.mutation(api.notes.add, { box: "a", text: "during-outage" });

        await waitFor(() => findTransitionAfter(recorded.inbound, preKillLen, 1) !== undefined, 20_000, "resume transition (1 mod)");
        const resumeT = findTransitionAfter(recorded.inbound, preKillLen, 1)!;
        expect(resumeT.modifications).toHaveLength(1);
        const mod = resumeT.modifications[0]!;
        expect(mod.type).toBe("QueryUpdated");
        if (mod.type === "QueryUpdated") expect(mod.value).toBe(1);

        const execAfter = (await other.query(api.notes.execCount, {})) as number;
        // THE correctness counterpart: the handler DID re-run (at least once — OCC retries on the
        // committing mutation's own transaction may also bump it, so assert >= 1, never an exact
        // count) to pick up the gap write.
        expect(execAfter - execBefore).toBeGreaterThanOrEqual(1);

        await waitFor(() => countFrames.at(-1) === 1, 5000, "client converges to 1");
      } finally {
        client.close();
        other.close();
        await proxy.close();
        await server.close();
      }
    },
    60_000,
  );
});
