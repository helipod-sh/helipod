/**
 * End-to-end: CLIENT-SUPPLIED IDS through the real server (client-supplied-ids design spec).
 *
 * Tasks 1-3 (merged on this branch) proved the mechanism in isolation: the executor accepts a
 * client-minted `_id` at `db.insert` for UNSHARDED tables on the DEFAULT ring (typed
 * INVALID_CLIENT_ID/ID_ALREADY_IN_USE rejections), `mintEncodedDocumentId` mints the same shape
 * id client-side, and codegen emits `_generated/ids.ts` (a table→number map + a typed `mintId`).
 * This file proves the COMPOSITION — mint → offline-enqueue → drain → reference, and the wire-level
 * rejection matrix — through the real `helipod dev` server (the "test through the shipped
 * entrypoint" rule), mirroring `outbox-fs-e2e.test.ts`'s harness shape.
 *
 * Fixture: `conversations {name}` (UNSHARDED — client ids are default-ring-only per the spec's
 * shard-safety gate) + `messages {conversationId: v.id("conversations"), body}`. `createConversation`
 * accepts an optional client-supplied `_id`; `sendMessage` references a conversation by id, proving
 * a client can mint an id, use it in one queued mutation, and REFERENCE it in a later queued
 * mutation before either has ever reached the server — the whole point of client-supplied ids for
 * an offline create-then-reference chain.
 */
import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@helipod/values";
import { query, mutation } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, webSocketTransport, mintDocumentId, type ClientTransport } from "@helipod/client";
import { fsOutbox } from "@helipod/client/outbox-fs";
import { generateAll } from "@helipod/codegen";
import { loadProject, startDevServer, type DevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixture app — conversations (unsharded) + messages referencing them        */
/* -------------------------------------------------------------------------- */

const schema = defineSchema({
  conversations: defineTable({ name: v.string() }),
  messages: defineTable({ conversationId: v.id("conversations"), body: v.string() }),
});

interface ConvoDoc {
  _id: string;
  _creationTime: number;
  name: string;
}
interface MessageDoc {
  _id: string;
  _creationTime: number;
  conversationId: string;
  body: string;
}

const appModule = {
  // `_id` passed straight through to `ctx.db.insert` — the client-supplied-ids surface a Helipod
  // app author writes exactly like this (see the spec's authoring section).
  createConversation: mutation({
    args: { _id: v.optional(v.string()), name: v.string() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (ctx: any, args: { _id?: string; name: string }) => ctx.db.insert("conversations", args),
  }),
  sendMessage: mutation({
    args: { conversationId: v.id("conversations"), body: v.string() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (ctx: any, { conversationId, body }: { conversationId: string; body: string }) =>
      ctx.db.insert("messages", { conversationId, body }),
  }),
  // Resolves a message's conversationId via db.get — proves the reference is live, not just a
  // string that happens to match.
  verifyMessage: query({
    args: { messageId: v.id("messages") },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (ctx: any, { messageId }: { messageId: string }) => {
      const message = (await ctx.db.get(messageId)) as MessageDoc | null;
      if (!message) return null;
      const conversation = (await ctx.db.get(message.conversationId)) as ConvoDoc | null;
      return { message, conversation };
    },
  }),
  listAll: query({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (ctx: any) => ({
      conversations: await ctx.db.query("conversations", "by_creation").collect(),
      messages: await ctx.db.query("messages", "by_creation").collect(),
    }),
  }),
};

function loaded() {
  return { schema, modules: { app: appModule } };
}

async function startServer(numShards = 8): Promise<{ runtime: EmbeddedRuntime; server: DevServer; port: number; conversationsTableNumber: number; messagesTableNumber: number }> {
  const project = loadProject(loaded());
  const runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
    numShards, // the real fleet default (DEFAULT_NUM_SHARDS in packages/cli/src/boot.ts) — proves
    // the v1 shard-safety gate (client ids restricted to unsharded tables on the DEFAULT ring)
    // holds even when the server genuinely runs multiple shards.
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  const conversationsTableNumber = project.tableNumbers["conversations"];
  const messagesTableNumber = project.tableNumbers["messages"];
  if (conversationsTableNumber === undefined || messagesTableNumber === undefined) {
    throw new Error("fixture table numbers missing from the composition");
  }
  return { runtime, server, port: server.port, conversationsTableNumber, messagesTableNumber };
}

/* -------------------------------------------------------------------------- */
/* Helpers (mirrors outbox-fs-e2e.test.ts)                                    */
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
 *  transport pointed at it fails fast with ECONNREFUSED (the "genuinely offline" state, mirrors
 *  `outbox-fs-e2e.test.ts`). */
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
/* 1. The flagship: offline mint -> create+reference chain -> connect -> drain */
/* -------------------------------------------------------------------------- */

describe("client-supplied ids — end-to-end through the real dev server", () => {
  it(
    "the offline create-then-reference chain drains exactly-once under EXACTLY the minted id",
    async () => {
      // Two-session pattern (mirrors outbox-fs-e2e.test.ts): session 1's transport points at a DEAD
      // port — genuinely offline, no server exists for it to reach — so `createConversation`
      // (minting `_id: cid`) and `sendMessage` (referencing `cid`) both durably enqueue and STAY
      // queued; only session 2, against the real server that comes up afterward, drains them. A
      // client pointed at an already-running server would just complete online, defeating the
      // "offline create-then-reference chain" this test exists to prove.
      const dir = mkdtempSync(join(tmpdir(), "sb-client-ids-e2e-"));
      let client1: HelipodClient | undefined;
      let client2: HelipodClient | undefined;
      let server: DevServer | undefined;
      try {
        // Table numbers are allocated deterministically from the fixed schema (no components, no
        // existing tableNumbers) — resolve them via the same `loadProject` composition the server
        // boot uses, WITHOUT booting a server yet, so the mint below is genuinely pre-server.
        const preProject = loadProject(loaded());
        const conversationsTableNumber = preProject.tableNumbers["conversations"];
        if (conversationsTableNumber === undefined) throw new Error("conversations table number missing");

        // Mint OFFLINE (no server call — pure client-side, same shape/entropy as server minting).
        const cid = mintDocumentId(conversationsTableNumber);

        /* ---- Session 1: offline (dead port) — enqueue create-then-reference ---- */
        const deadPort = await freePort();
        const outbox1 = fsOutbox({ dir });
        client1 = new HelipodClient(nodeWsTransport(wsUrlFor(deadPort)), {
          outbox: outbox1,
          outboxLocks: null, // single-tab leader
          outboxDrainIntervalMs: 0,
        });

        // Let the dead-port connection attempt fail and its close propagate, so each entry below
        // lands cleanly `unsent`.
        await sleep(300);

        const createPromise = client1.mutation("app:createConversation", { _id: cid, name: "offline convo" });
        const sendPromise = client1.mutation("app:sendMessage", { conversationId: cid, body: "hi from offline" });
        void createPromise.catch(() => {});
        void sendPromise.catch(() => {});

        // Both durable in the journal — the create-then-reference chain, BEFORE any server exists.
        await waitFor(async () => (await outbox1.loadAll()).entries.length === 2, 5000, "2 durable");
        expect(server).toBeUndefined(); // the server literally does not exist yet at this point

        /* ---- "process exit": tear down session 1 ---- */
        client1.close();
        await outbox1.close?.();

        /* ---- Now the real server comes up — session 2's target ---- */
        const project = loadProject(loaded());
        expect(project.tableNumbers["conversations"]).toBe(conversationsTableNumber); // deterministic allocation
        const runtime = await createEmbeddedRuntime({
          store: new SqliteDocStore(new NodeSqliteAdapter()),
          catalog: project.catalog,
          modules: project.moduleMap,
          tableNumbers: project.tableNumbers,
          numShards: 8, // the real fleet default — the whole chain still lands on the default ring.
        });
        server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });

        /* ---- Session 2: fresh client + fresh fsOutbox on the SAME dir, against the now-running
         * real server. Hydrate replays the 2 journaled entries; the drain sends them. ---- */
        const outbox2 = fsOutbox({ dir });
        client2 = new HelipodClient(nodeWsTransport(wsUrlFor(server.port)), {
          outbox: outbox2,
          outboxLocks: null,
          outboxDrainIntervalMs: 0,
        });

        // NATURAL ordering: subscribe on mount, immediately after construction — before the drain's
        // first-connect handshake even arms. This used to deadlock the drain (a bug this branch
        // fixed): the subscription's own initial Transition could be ingested before the drain's
        // async hydrate finished and armed the baseline await, which — pre-fix — computed
        // `expectTransition` from "does a live subscription exist" rather than "is one still
        // awaiting delivery", permanently starving `whenBaselineAdopted()` (the drain's send gate)
        // on a quiet deployment. See `packages/client/src/client.ts#hasUndeliveredSubscription` and
        // its red-first repro in `packages/client/test/outbox-handshake.test.ts`. This E2E is now
        // the integration regression test for that fix.
        const frames: Array<{ conversations: ConvoDoc[]; messages: MessageDoc[] }> = [];
        client2.subscribe("app:listAll", {}, (v) => frames.push(v as unknown as { conversations: ConvoDoc[]; messages: MessageDoc[] }));

        await waitFor(() => client2!.__outboxArmed, 15_000, "session-2 arm");

        // Drain: both mutations flush FIFO once the transport connects.
        await waitFor(async () => (await client2!.pendingMutations()).length === 0, 20_000, "pending -> 0");
        expect(await client2.pendingMutations()).toHaveLength(0);
        expect((await outbox2.loadAll()).entries).toHaveLength(0);

        // Exactly one conversation row, under EXACTLY the minted string.
        const listing = (await client2.query("app:listAll", {})) as unknown as { conversations: ConvoDoc[]; messages: MessageDoc[] };
        expect(listing.conversations).toHaveLength(1);
        expect(listing.conversations[0]!._id).toBe(cid);
        expect(listing.messages).toHaveLength(1);

        // The reference resolves live via db.get, not just string equality.
        const messageId = listing.messages[0]!._id;
        const verified = (await client2.query("app:verifyMessage", { messageId })) as unknown as {
          message: MessageDoc;
          conversation: ConvoDoc | null;
        };
        expect(verified.conversation).not.toBeNull();
        expect(verified.conversation!._id).toBe(cid);
        expect(verified.conversation!.name).toBe("offline convo");

        // The live subscription observed both rows land.
        await waitFor(
          () => frames.some((f) => f.conversations.length === 1 && f.messages.length === 1),
          10_000,
          "subscription observed both rows",
        );

        client2.close();
        await outbox2.close?.();
      } finally {
        client1?.close();
        client2?.close();
        await server?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  /* ------------------------------------------------------------------------ */
  /* 2. Rejection matrix over the wire                                        */
  /* ------------------------------------------------------------------------ */

  it("rejects a wrong-table minted id with INVALID_CLIENT_ID, and a reused id with ID_ALREADY_IN_USE", async () => {
    let client: HelipodClient | undefined;
    let server: DevServer | undefined;
    try {
      const started = await startServer();
      server = started.server;
      client = new HelipodClient(nodeWsTransport(wsUrlFor(started.port)));

      // A minted MESSAGES-table id used as `_id` on `createConversation` — wrong table. The executor
      // throws `InvalidClientIdError` (code `INVALID_CLIENT_ID`, proven at the unit level by
      // `packages/executor/test/client-id-insert.test.ts`); `packages/sync/src/handler.ts`'s
      // `processMutation` catch block (a genuinely fresh, non-replayed failure) now threads the
      // thrown error's typed `.code` onto the wire (fixed alongside this test — previously only a
      // REPLAYED dedup verdict's branch populated `code`, so a live `client.mutation()` rejection
      // carried the message but not `.code`; see `packages/sync/test/receipted-outbox.test.ts`'s
      // "FRESH (non-replayed) failure carries the thrown error's typed code" unit test). Assert on
      // BOTH — `.code` is now the strongest available check, message stays as a defense-in-depth.
      const wrongTableId = mintDocumentId(started.messagesTableNumber);
      await expect(client.mutation("app:createConversation", { _id: wrongTableId, name: "bad" })).rejects.toMatchObject({
        code: "INVALID_CLIENT_ID",
        message: expect.stringMatching(/_id belongs to table "messages", not "conversations"/),
      });

      // A fresh, valid id commits once...
      const cid = mintDocumentId(started.conversationsTableNumber);
      const created = await client.mutation("app:createConversation", { _id: cid, name: "first" });
      expect(created).toBe(cid);

      // ...and re-using it rejects with ID_ALREADY_IN_USE (now carried as a typed `.code` too).
      await expect(client.mutation("app:createConversation", { _id: cid, name: "second" })).rejects.toMatchObject({
        code: "ID_ALREADY_IN_USE",
        message: expect.stringMatching(/already exists/),
      });

      // Exactly one row landed under `cid`.
      const listing = (await client.query("app:listAll", {})) as unknown as { conversations: ConvoDoc[] };
      expect(listing.conversations.filter((c) => c._id === cid)).toHaveLength(1);
    } finally {
      client?.close();
      await server?.close();
    }
  });

  /* ------------------------------------------------------------------------ */
  /* 3. Regression: create without _id, server mints as today                 */
  /* ------------------------------------------------------------------------ */

  it("regression: createConversation without _id still works — the server mints", async () => {
    let client: HelipodClient | undefined;
    let server: DevServer | undefined;
    try {
      const started = await startServer();
      server = started.server;
      client = new HelipodClient(nodeWsTransport(wsUrlFor(started.port)));

      const id = await client.mutation("app:createConversation", { name: "server-minted" });
      expect(typeof id).toBe("string");
      const listing = (await client.query("app:listAll", {})) as unknown as { conversations: ConvoDoc[] };
      expect(listing.conversations).toHaveLength(1);
      expect(listing.conversations[0]!._id).toBe(id);
    } finally {
      client?.close();
      await server?.close();
    }
  });

  /* ------------------------------------------------------------------------ */
  /* 4. The codegen bridge — ids.ts binds the emitted table number to reality  */
  /* ------------------------------------------------------------------------ */

  it("codegen: generateAll over the fixture schema + the runtime's real tableNumbers names the same conversations number the wire used", async () => {
    let server: DevServer | undefined;
    try {
      const project = loadProject(loaded());
      const started = await startServer();
      server = started.server;

      const bundle = generateAll({
        schema: project.schemaJson,
        manifest: project.manifest,
        tableNumbers: project.tableNumbers,
      });
      expect(bundle.ids).toBeDefined();
      expect(bundle.ids!.content).toContain(`"conversations": ${started.conversationsTableNumber}`);
      expect(bundle.ids!.content).toContain(`"messages": ${started.messagesTableNumber}`);
    } finally {
      await server?.close();
    }
  });

  /* ------------------------------------------------------------------------ */
  /* 5. The concurrent same-id duplicate race — through the real 8-shard server*/
  /* ------------------------------------------------------------------------ */

  it("two clients racing createConversation with the SAME minted _id: exactly one row, the loser gets ID_ALREADY_IN_USE", async () => {
    let clientA: HelipodClient | undefined;
    let clientB: HelipodClient | undefined;
    let server: DevServer | undefined;
    try {
      const started = await startServer(8); // the real fleet-default shard count
      server = started.server;
      clientA = new HelipodClient(nodeWsTransport(wsUrlFor(started.port)));
      clientB = new HelipodClient(nodeWsTransport(wsUrlFor(started.port)));

      const cid = mintDocumentId(started.conversationsTableNumber);

      const results = await Promise.allSettled([
        clientA.mutation("app:createConversation", { _id: cid, name: "A" }),
        clientB.mutation("app:createConversation", { _id: cid, name: "B" }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<unknown>[];
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0]!.value).toBe(cid);
      // The unsharded-table + default-ring OCC gate (9c466b8) makes this deterministic — a genuine
      // race loses loudly at OCC rather than forking a duplicate identity. The typed `.code` now
      // crosses the wire for a live (non-replayed) mutation failure too (see the rejection-matrix
      // test above), so assert on it alongside the message.
      expect((rejected[0]!.reason as Error & { code?: string }).code).toBe("ID_ALREADY_IN_USE");
      expect((rejected[0]!.reason as Error).message).toMatch(/already exists/);

      // Exactly one row exists under the shared id.
      const listing = (await clientA.query("app:listAll", {})) as unknown as { conversations: ConvoDoc[] };
      const matching = listing.conversations.filter((c) => c._id === cid);
      expect(matching).toHaveLength(1);
    } finally {
      clientA?.close();
      clientB?.close();
      await server?.close();
    }
  });
});
