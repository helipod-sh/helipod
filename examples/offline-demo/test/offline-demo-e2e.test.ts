/**
 * Packlist E2E — the README's demo flows, through the REAL machinery end-to-end: the real
 * `helipod dev` server (startDevServer), a real HelipodClient over a real WebSocket, the
 * demo's OWN `offlineToggleTransport` as the offline switch, the demo's own helipod functions,
 * and a client-minted id from the committed `_generated/ids.ts`. This is the protocol-level
 * twin of driving the app in a browser (the React layer is the only thing not under test here;
 * `packages/cli/test/crosstab-e2e.test.ts` covers the cross-tab rendering mechanism).
 *
 * Flow 1 (the star): toggle offline → mintId create + two adds referencing it (queued) →
 * "reload" (close the client; construct a FRESH client over the same fsOutbox dir with the
 * offline flag still set — the constructed-offline path, which must announce the down state or
 * the drain never arms) → toggle online → exactly-once drain, verified server-side.
 *
 * Flow 3 (the conflict): lock the list server-side → queue an add offline → reconnect → the
 * entry settles `failed` with code LIST_LOCKED → `retry()` re-enqueues and fails again (the
 * list is still locked) → `dismiss()` empties the queue.
 *
 * fsOutbox stands in for the browser's IndexedDB (same OutboxStorage contract); a Map-backed
 * FlagStorage stands in for sessionStorage. Two clients over one outbox dir with `close()`
 * between them = a faithful reload, per the model documented in outbox-fs-e2e.test.ts.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, webSocketTransport, type ClientTransport, type PendingMutationEntry } from "@helipod/client";
import { fsOutbox } from "@helipod/client/outbox-fs";
import { loadProject, startDevServer, type DevServer } from "@helipod/cli";
import schema from "../helipod/schema";
import * as lists from "../helipod/lists";
import * as items from "../helipod/items";
import { mintId } from "../helipod/_generated/ids";
import { offlineToggleTransport, type OfflineToggleTransport } from "../web/offline-transport";

/* ------------------------------------ harness ------------------------------------ */

async function startServer(): Promise<{ runtime: EmbeddedRuntime; server: DevServer; port: number }> {
  const project = loadProject({ schema, modules: { lists, items } });
  const runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  return { runtime, server, port: server.port };
}

/** The browser default is `webSocketTransport(url)`; under Node/vitest there is no global
 *  WebSocket in this runtime, so the demo wrapper gets the same transport over `ws` — injected
 *  through its `makeInner` seam, exactly the seam its unit tests use. */
function nodeInner(port: number): (url: string) => ClientTransport {
  return (url) =>
    webSocketTransport(url, {
      initialBackoffMs: 40,
      maxBackoffMs: 120,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createWebSocket: (u) => new WebSocket(u) as unknown as any,
    });
}

/** sessionStorage stand-in that SURVIVES across the simulated reload (the browser's
 *  sessionStorage does too — reload keeps the tab's storage; only a new tab starts empty). */
function flagStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

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

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}/api/sync`;
}

/* ------------------------------------ Flow 1 ------------------------------------ */

describe("packlist E2E — Flow 1: offline mintId chain → reload → reconnect → exactly-once drain", () => {
  it("create-then-reference queued offline survives a client 'reload' and drains exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "packlist-e2e-"));
    const storage = flagStorage();
    let session1: HelipodClient | undefined;
    let session2: HelipodClient | undefined;
    let transport2: OfflineToggleTransport | undefined;
    let server: DevServer | undefined;
    let runtime: EmbeddedRuntime | undefined;
    try {
      ({ runtime, server } = await startServer());
      const port = server.port;

      /* ---- Session 1: connect online, then flip the demo toggle offline and queue the
       * README's star-flow writes: a mintId'd list create plus two adds referencing it. ---- */
      const transport1 = offlineToggleTransport(wsUrl(port), nodeInner(port), storage);
      const outbox1 = fsOutbox({ dir });
      session1 = new HelipodClient(transport1, {
        outbox: outbox1,
        outboxLocks: null, // single-tab leader (Web Locks don't exist under Node)
        outboxDrainIntervalMs: 0,
      });
      // Prime one online commit so the reload's Connect handshake sees a recognized timeline
      // (the browser flow has this implicitly — the tab was online before the toggle).
      await session1.mutation("lists:create", { name: "Warmup" });

      transport1.setOffline(true);
      const listId = mintId("lists"); // minted at args-construction time — the offline chain
      const queued = [
        session1.mutation("lists:create", { _id: listId, name: "Beach trip" }),
        session1.mutation("items:add", { _id: mintId("items"), listId, label: "Sunscreen" }),
        session1.mutation("items:add", { _id: mintId("items"), listId, label: "Towel" }),
      ];
      for (const p of queued) p.catch(() => {}); // fates surface via the outbox, not these promises
      await waitFor(async () => (await session1!.pendingMutations()).length === 3, 10_000, "3 entries durable");

      // "Reload": the tab dies mid-offline. Closing the client AND its fsOutbox releases the
      // dir's pid lock (without the outbox close, the next fsOutbox on this dir would silently
      // fall back to memory); the queued promises die with the session, the DURABLE entries don't.
      session1.close();
      await outbox1.close?.();
      session1 = undefined;

      /* ---- Session 2: a fresh client over the SAME outbox dir, with the offline flag still
       * set — so the wrapper constructs OFFLINE. This is the exact path the final review's
       * Critical covered: a constructed-offline transport must still announce the down state,
       * or the outbox handshake latches and the drain never arms. ---- */
      transport2 = offlineToggleTransport(wsUrl(port), nodeInner(port), storage);
      expect(transport2.isOffline()).toBe(true); // the flag survived the reload
      session2 = new HelipodClient(transport2, {
        outbox: fsOutbox({ dir }),
        outboxLocks: null,
        outboxDrainIntervalMs: 0,
      });
      await waitFor(async () => (await session2!.pendingMutations()).length === 3, 10_000, "hydrated 3 from the journal");

      // Nothing committed server-side yet — the queue is local, the server never saw it.
      const before = await runtime.run<Array<{ name: string }>>("lists:list", {});
      expect(before.value.map((l) => l.name)).toEqual(["Warmup"]);

      /* ---- Flip online: the wrapper fires reopen, the client re-handshakes, the drain flushes
       * FIFO — create first, then the adds that reference it. ---- */
      transport2.setOffline(false);
      await waitFor(async () => (await session2!.pendingMutations()).length === 0, 15_000, "drained to empty");

      const listsAfter = await runtime.run<Array<{ _id: string; name: string }>>("lists:list", {});
      expect(listsAfter.value.map((l) => l.name).sort()).toEqual(["Beach trip", "Warmup"]);
      const beach = listsAfter.value.find((l) => l.name === "Beach trip")!;
      expect(beach._id).toBe(listId); // committed under the CLIENT-minted id, not a server one

      const itemsAfter = await runtime.run<Array<{ label: string; listId: string }>>("items:list", { listId });
      expect(itemsAfter.value.map((i) => i.label).sort()).toEqual(["Sunscreen", "Towel"]);
      expect(itemsAfter.value.every((i) => i.listId === listId)).toBe(true); // exactly-once, exactly-here
    } finally {
      session1?.close();
      session2?.close();
      transport2?.close();
      await server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/* ------------------------------------ Flow 3 ------------------------------------ */

describe("packlist E2E — Flow 3: a queued add into a locked list terminal-fails with LIST_LOCKED; retry re-fails; dismiss clears", () => {
  it("the conflict path surfaces as a coded terminal failure with working retry()/dismiss()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "packlist-e2e-"));
    const storage = flagStorage();
    let client: HelipodClient | undefined;
    let server: DevServer | undefined;
    let runtime: EmbeddedRuntime | undefined;
    const failures: string[] = [];
    try {
      ({ runtime, server } = await startServer());

      const transport = offlineToggleTransport(wsUrl(server.port), nodeInner(server.port), storage);
      client = new HelipodClient(transport, {
        outbox: fsOutbox({ dir }),
        outboxLocks: null,
        outboxDrainIntervalMs: 0,
        onMutationFailed: (info) => failures.push(info.error.code ?? info.error.message),
      });

      // Set the stage online: a list exists and gets locked (the world changes while you're away).
      const listId = (await client.mutation("lists:create", { name: "Locked" })) as string;
      await client.mutation("lists:lock", { id: listId });

      // Queue the doomed add offline, then reconnect.
      transport.setOffline(true);
      client.mutation("items:add", { listId, label: "Too late" }).catch(() => {});
      await waitFor(async () => (await client!.pendingMutations()).length === 1, 10_000, "1 entry durable");
      transport.setOffline(false);

      const failed = async (): Promise<PendingMutationEntry | undefined> =>
        (await client!.pendingMutations()).find((e) => e.status === "failed");
      await waitFor(async () => (await failed()) !== undefined, 15_000, "terminal failure recorded");
      expect((await failed())!.error?.code).toBe("LIST_LOCKED");

      // retry() re-enqueues under a fresh (clientId, seq) — and fails again: the list is still
      // locked, and a retried entry has no live promise, so onMutationFailed fires this time.
      const first = (await failed())!;
      const firstSeq = first.seq;
      await first.retry();
      await waitFor(
        async () => (await failed()) !== undefined && (await failed())!.seq !== firstSeq,
        15_000,
        "retried entry re-failed under a fresh seq",
      );
      expect((await failed())!.error?.code).toBe("LIST_LOCKED");
      await waitFor(() => failures.includes("LIST_LOCKED"), 5_000, "onMutationFailed breadcrumb");

      await (await failed())!.dismiss();
      await waitFor(async () => (await client!.pendingMutations()).length === 0, 5_000, "queue empty after dismiss");

      // The doomed row never landed.
      const itemsAfter = await runtime.run<unknown[]>("items:list", { listId });
      expect(itemsAfter.value).toEqual([]);
    } finally {
      client?.close();
      await server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
