/**
 * Subscription resume (design 2026-07-11) — the bandwidth/wall-time benchmark. Boots a REAL dev
 * server, seeds 50 groups whose query results each serialize to ~2-10KB, connects one real
 * WebSocket client subscribed to all 50, forces a reconnect through a controllable TCP proxy, and
 * measures the resume: (a) total `ServerMessage` bytes received until all 50 subscriptions have
 * answered again, and (b) wall time to that point. Two matrix cells compare a normal client
 * (fingerprints ON — echoes `resultHash` on resubscribe, server replies `QueryUnchanged` when
 * nothing moved) against the SAME client wrapped in a transport that strips `resultHash` from
 * outgoing `ModifyQuerySet` frames (fingerprints OFF — server always does today's full send). No
 * client API change is needed for the OFF cell; it is purely a transport-level strip, mirroring
 * `bench-fanout-ws.test.ts`'s real-WS harness pattern and opt-in env gating.
 *
 * This measures BANDWIDTH only — server compute (the query still fully re-runs and re-hashes on
 * every resubscribe) is unchanged either way. See the recorded doc's "honest note" for the v2
 * compute-saving seam (retained read-sets) this does not attempt.
 *
 * Opt-in: HELIPOD_BENCH_RESUME=1 (heavier than a plain unit test — spins a server + a TCP proxy
 * + a real WebSocket). Without the env this file's suite is skipped entirely.
 */
import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import net from "node:net";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@helipod/values";
import { query, mutation } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime } from "@helipod/runtime-embedded";
import { loadProject, startDevServer } from "../src/index";
import { HelipodClient, webSocketTransport, type ClientTransport } from "@helipod/client";
import { encodeServerMessage, type ServerMessage, type ClientMessage } from "@helipod/sync";

const RUN = process.env["HELIPOD_BENCH_RESUME"] === "1";
const benchDescribe = RUN ? describe : describe.skip;

const N = 50;

/* -------------------------------------------------------------------------- */
/* Fixture: 50 groups, each query result ~2-10KB serialized                   */
/* -------------------------------------------------------------------------- */

const schema = defineSchema({
  items: defineTable({ groupId: v.string(), data: v.string() }).index("by_group", ["groupId"]),
});

const appModule = {
  byGroup: query<{ groupId: string }, unknown>({
    handler: (ctx, { groupId }) => ctx.db.query("items", "by_group").eq("groupId", groupId).collect(),
  }),
  seed: mutation({
    args: { groupId: v.string(), data: v.string() },
    handler: (ctx, { groupId, data }) => ctx.db.insert("items", { groupId, data }),
  }),
};

const GROUPS = Array.from({ length: N }, (_, i) => `g${i}`);

/** Spreads each group's padded-string payload across ~2KB..10KB so the matrix reflects realistic
 *  (not degenerate-tiny, not degenerate-huge) per-query result sizes. */
function dataSizeFor(i: number): number {
  return 2_000 + Math.round((i / (N - 1)) * 8_000);
}

/* -------------------------------------------------------------------------- */
/* A controllable TCP proxy — lets the test force a live-connection drop      */
/* without touching the server or the client's own reconnect logic.          */
/* -------------------------------------------------------------------------- */

interface Pair {
  client: net.Socket;
  upstream: net.Socket;
}

async function makeProxy(backendPort: number): Promise<{ port: number; killLive(): void; close(): Promise<void> }> {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    killLive() {
      for (const p of pairs) {
        p.client.destroy();
        p.upstream.destroy();
      }
      pairs.clear();
    },
    close() {
      for (const p of pairs) {
        p.client.destroy();
        p.upstream.destroy();
      }
      pairs.clear();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A `webSocketTransport` over the `ws` package (Node has no global `WebSocket` this suite relies
 *  on) — mirrors `outbox-e2e.test.ts`'s `nodeWsTransport`, tuned for a fast reconnect. */
function nodeWsTransport(url: string): ClientTransport {
  return webSocketTransport(url, {
    initialBackoffMs: 25,
    maxBackoffMs: 150,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createWebSocket: (u) => new WebSocket(u) as unknown as any,
  });
}

/**
 * Wraps a transport to (a) optionally strip `resultHash` from outgoing `ModifyQuerySet` frames —
 * the fingerprints-OFF cell, a pure transport-level strip, no client API change — and (b) tap every
 * incoming frame's serialized byte length (measured the same way the wire does:
 * `encodeServerMessage` is the exact function `SyncProtocolHandler` sends through) before handing
 * it on to the client.
 */
function wrapTransport(
  inner: ClientTransport,
  opts: { stripFingerprint: boolean; onIncoming: (msg: ServerMessage, bytes: number) => void },
): ClientTransport {
  const wrapped: ClientTransport = {
    send(message: ClientMessage) {
      if (opts.stripFingerprint && message.type === "ModifyQuerySet") {
        inner.send({
          ...message,
          add: message.add.map(({ resultHash: _resultHash, ...rest }) => rest),
        });
        return;
      }
      inner.send(message);
    },
    onMessage(listener) {
      return inner.onMessage((msg) => {
        opts.onIncoming(msg, Buffer.byteLength(encodeServerMessage(msg), "utf8"));
        listener(msg);
      });
    },
    onClose(listener) {
      return inner.onClose(listener);
    },
    close() {
      inner.close();
    },
  };
  if (inner.onReopen) {
    wrapped.onReopen = (listener) => inner.onReopen!(listener);
  }
  return wrapped;
}

/* -------------------------------------------------------------------------- */
/* One matrix cell: subscribe to all 50, force a reconnect, measure the resume */
/* -------------------------------------------------------------------------- */

interface CellResult {
  totalBytes: number;
  elapsedMs: number;
  frameCount: number;
  /** Direct mechanism proof (review hardening): counts of resume-window modification types, so the
   *  cells self-verify (OFF must see zero QueryUnchanged; ON must see exactly N) rather than the
   *  magnitude comparison alone inferring the mechanism. */
  unchangedCount: number;
  updatedCount: number;
}

async function runCell(
  wsUrl: string,
  proxy: { killLive(): void },
  stripFingerprint: boolean,
): Promise<CellResult> {
  let counting = false;
  let totalBytes = 0;
  let frameCount = 0;
  let unchangedCount = 0;
  let updatedCount = 0;
  const answered = new Set<number>();
  let resolveAllAnswered: (() => void) | undefined;
  const allAnswered = new Promise<void>((resolve) => {
    resolveAllAnswered = resolve;
  });

  const transport = wrapTransport(nodeWsTransport(wsUrl), {
    stripFingerprint,
    onIncoming: (msg, bytes) => {
      if (!counting) return;
      totalBytes += bytes;
      frameCount += 1;
      if (msg.type === "Transition") {
        for (const m of msg.modifications) {
          if (m.type === "QueryUpdated" || m.type === "QueryUnchanged") answered.add(m.queryId);
          if (m.type === "QueryUnchanged") unchangedCount += 1;
          else if (m.type === "QueryUpdated") updatedCount += 1;
        }
        if (answered.size >= N) resolveAllAnswered?.();
      }
    },
  });

  const client = new HelipodClient(transport);
  try {
    // Initial subscribe to all 50 (NOT measured — only the post-reconnect resume window is).
    let subscribedCount = 0;
    let resolveSubscribed: (() => void) | undefined;
    const allSubscribed = new Promise<void>((resolve) => {
      resolveSubscribed = resolve;
    });
    for (const g of GROUPS) {
      let first = true;
      client.subscribe("bench:byGroup", { groupId: g }, () => {
        if (first) {
          first = false;
          subscribedCount += 1;
          if (subscribedCount === N) resolveSubscribed?.();
        }
      });
    }
    await allSubscribed;

    // Reset counters, then force a live-connection drop; the client's own reconnect logic (built
    // into `webSocketTransport`) reopens and replays `resync()` — one `ModifyQuerySet` carrying all
    // 50 live subs (each echoing its `resultHash` unless stripped), answered by one `Transition`.
    totalBytes = 0;
    frameCount = 0;
    unchangedCount = 0;
    updatedCount = 0;
    answered.clear();
    counting = true;
    const start = performance.now();
    proxy.killLive();
    await allAnswered;
    const elapsedMs = performance.now() - start;

    return { totalBytes, elapsedMs, frameCount, unchangedCount, updatedCount };
  } finally {
    client.close();
  }
}

/* -------------------------------------------------------------------------- */
/* The benchmark                                                              */
/* -------------------------------------------------------------------------- */

benchDescribe("bench-resume-ws — reconnect resume: bytes + time-to-answered, fingerprints on/off (opt-in: HELIPOD_BENCH_RESUME=1)", () => {
  it("50 subscriptions (~2-10KB results each), forced reconnect: fingerprints ON vs OFF", async () => {
    const project = loadProject({ schema, modules: { bench: appModule } });
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
    });
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
    const proxy = await makeProxy(server.port);
    const wsUrl = `ws://127.0.0.1:${proxy.port}/api/sync`;

    try {
      for (const [i, groupId] of GROUPS.entries()) {
        await runtime.run("bench:seed", { groupId, data: "x".repeat(dataSizeFor(i)) });
      }

      const on = await runCell(wsUrl, proxy, false);
      const off = await runCell(wsUrl, proxy, true);

      expect(on.totalBytes).toBeGreaterThan(0);
      expect(off.totalBytes).toBeGreaterThan(0);
      // Direct mechanism proof: the strip genuinely disabled fingerprints (zero Unchanged) and the
      // ON cell resumed every sub via fingerprint match (exactly N Unchanged, zero full re-sends).
      expect(off.unchangedCount).toBe(0);
      expect(off.updatedCount).toBe(N);
      expect(on.unchangedCount).toBe(N);
      expect(on.updatedCount).toBe(0);
      // The whole point: fingerprints ON must ship substantially fewer bytes on an unchanged resume.
      expect(on.totalBytes).toBeLessThan(off.totalBytes);

      const savingsPct = (100 * (off.totalBytes - on.totalBytes)) / off.totalBytes;
      // eslint-disable-next-line no-console
      console.log(
        `\n=== bench-resume-ws (N=${N} subs, this machine) ===\n` +
          `fingerprints ON:  bytes=${on.totalBytes}  frames=${on.frameCount}  time=${on.elapsedMs.toFixed(2)}ms\n` +
          `fingerprints OFF: bytes=${off.totalBytes}  frames=${off.frameCount}  time=${off.elapsedMs.toFixed(2)}ms\n` +
          `bandwidth savings: ${savingsPct.toFixed(1)}%\n`,
      );
    } finally {
      await proxy.close();
      await server.close();
    }
  }, 120_000);
});
