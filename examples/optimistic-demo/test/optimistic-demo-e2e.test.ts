/**
 * Pulse E2E — the demo's headline claims through the REAL machinery: the real `stackbase dev`
 * server, a real StackbaseClient over a real WebSocket, and the demo's own delayTransport
 * injecting write latency.
 *
 * Claim 1 (why optimistic exists): under 500ms injected write latency, a subscribed query
 * reflects an optimistic vote IMMEDIATELY — before the mutation promise resolves — and never
 * flickers back; the plain (non-optimistic) variant shows nothing until the server answers.
 *
 * Claim 2 (exact rollback): a vote into a closed poll bumps optimistically, the server rejects
 * with coded POLL_CLOSED, and the subscribed value ends exactly at the pre-vote count.
 */
import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, type ClientTransport, type OptimisticStoreView } from "@stackbase/client";
import { loadProject, startDevServer, type DevServer } from "@stackbase/cli";
import schema from "../convex/schema";
import * as polls from "../convex/polls";
import * as options from "../convex/options";
import { delayTransport } from "../web/delay-transport";

type OptionRow = { _id: string; label: string; votes: number };

async function startServer(): Promise<{ runtime: EmbeddedRuntime; server: DevServer }> {
  const project = loadProject({ schema, modules: { polls, options } });
  const runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  return { runtime, server };
}

function nodeInner(url: string): ClientTransport {
  return webSocketTransport(url, {
    initialBackoffMs: 40,
    maxBackoffMs: 120,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createWebSocket: (u) => new WebSocket(u) as unknown as any,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await sleep(10);
  }
}

/**
 * The wire order guarantees a mutation's `MutationResponse` is sent no later than its own
 * query's `Transition` (never the other way around) — but NOT that they arrive together. A
 * commit's own `QueryUpdated` always fires the subscription listener even when the pushed value
 * is unchanged from the prior (optimistic-guessed) one, because the wire decode mints a fresh
 * object every time (see `packages/client/src/layered-store.ts`'s `recompose`). So there is a
 * real, if usually sub-millisecond, window after a mutation's promise resolves during which that
 * trailing same-value Transition hasn't landed yet. Without waiting it out, a later "nothing
 * moved" check can mistake that stale echo for movement caused by whatever comes next. Wait for
 * `getLen()` to stop growing for `quietMs` before treating the stream as settled.
 */
async function waitForQuiescence(getLen: () => number, quietMs = 150, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  let last = getLen();
  let lastChangeAt = Date.now();
  for (;;) {
    await sleep(15);
    const cur = getLen();
    if (cur !== last) {
      last = cur;
      lastChangeAt = Date.now();
    }
    if (Date.now() - lastChangeAt >= quietMs) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitForQuiescence timed out");
  }
}

function bump(store: OptimisticStoreView, id: string, delta: number): void {
  for (const q of store.getAllQueries("options:list")) {
    if (q.value === undefined) continue;
    store.setQuery(
      "options:list",
      q.args,
      (q.value as OptionRow[]).map((o) => (o._id === id ? { ...o, votes: o.votes + delta } : o)),
    );
  }
}

describe("pulse E2E — optimistic votes render before the server answers; rollback is exact", () => {
  it("claim 1: under 500ms write latency, optimistic ON shows the vote pre-ack (and never flickers); OFF waits for the server", async () => {
    let client: StackbaseClient | undefined;
    let server: DevServer | undefined;
    try {
      const s = await startServer();
      server = s.server;

      const transport = delayTransport(`ws://127.0.0.1:${server.port}/api/sync`, nodeInner);
      client = new StackbaseClient(transport);

      const pollId = (await client.mutation("polls:create", { question: "Lunch?", options: ["Pizza", "Sushi"] })) as string;

      const seen: number[] = []; // Pizza's vote count, every push
      client.subscribe("options:list", { pollId }, (v) => {
        const pizza = (v as OptionRow[]).find((o) => o.label === "Pizza");
        if (pizza) seen.push(pizza.votes);
      });
      await waitFor(() => seen.length >= 1, 10_000, "baseline");
      const optionId = ((await client.query("options:list", { pollId })) as OptionRow[]).find((o) => o.label === "Pizza")!._id;

      transport.setDelay(500);

      /* ---- optimistic ON: the subscribed value reflects the vote BEFORE the promise resolves ---- */
      let resolved = false;
      const p = client
        .mutation("options:vote", { id: optionId }, { optimisticUpdate: (store, args) => bump(store, (args as { id: string }).id, 1) })
        .then((v) => {
          resolved = true;
          return v;
        });
      await waitFor(() => seen.includes(1), 2_000, "optimistic value visible");
      expect(resolved).toBe(false); // visible BEFORE the (delayed) server answered — the whole point
      await p;
      // No-flicker settle: once 1 appeared, the count never dropped back to 0.
      const afterOneAppeared = seen.slice(seen.indexOf(1));
      expect(afterOneAppeared.every((n) => n >= 1)).toBe(true);

      /* ---- optimistic OFF: nothing moves until the server answers ---- */
      // Let the first vote's own trailing Transition (same value, fresh object — see
      // waitForQuiescence's doc) land before measuring "nothing moved": otherwise it can arrive
      // during the very next sleep and read as movement caused by the second mutation.
      await waitForQuiescence(() => seen.length);
      const seenBefore = seen.length;
      const p2 = client.mutation("options:vote", { id: optionId });
      await sleep(250); // half the injected delay — the server hasn't even received the frame
      expect(seen.length).toBe(seenBefore); // no local movement without an updater
      await p2;
      await waitFor(() => seen.includes(2), 5_000, "server-confirmed value arrives");
    } finally {
      client?.close();
      await server?.close();
    }
  }, 60_000);

  it("claim 2: a vote into a closed poll rejects with POLL_CLOSED and rolls back to the exact pre-vote count", async () => {
    let client: StackbaseClient | undefined;
    let server: DevServer | undefined;
    try {
      const s = await startServer();
      server = s.server;

      const transport = delayTransport(`ws://127.0.0.1:${server.port}/api/sync`, nodeInner);
      client = new StackbaseClient(transport);

      const pollId = (await client.mutation("polls:create", { question: "Closed?", options: ["Yes"] })) as string;
      const optionId = ((await client.query("options:list", { pollId })) as OptionRow[])[0]!._id;
      await client.mutation("options:vote", { id: optionId }); // count = 1, the pre-vote truth
      await client.mutation("polls:setClosed", { id: pollId, closed: true });

      const seen: number[] = [];
      client.subscribe("options:list", { pollId }, (v) => {
        const row = (v as OptionRow[])[0];
        if (row) seen.push(row.votes);
      });
      await waitFor(() => seen.includes(1), 10_000, "baseline shows 1");

      transport.setDelay(500);
      const err = await client
        .mutation("options:vote", { id: optionId }, { optimisticUpdate: (store, args) => bump(store, (args as { id: string }).id, 1) })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe("POLL_CLOSED");

      // The optimistic 2 appeared, then rolled back EXACTLY to 1 — and stays there.
      await waitFor(() => seen.includes(2), 5_000, "optimistic bump was visible");
      await waitFor(() => seen[seen.length - 1] === 1, 5_000, "rolled back to the pre-vote count");
      await sleep(200);
      expect(seen[seen.length - 1]).toBe(1);
    } finally {
      client?.close();
      await server?.close();
    }
  }, 60_000);
});
