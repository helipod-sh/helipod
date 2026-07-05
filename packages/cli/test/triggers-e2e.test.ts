/**
 * End-to-end test: `@helipod/triggers` — the durable onChange loop — through the REAL dev server.
 *
 * Tasks 1-2 built the core seams (`DriverContext.readLog` + the stable-prefix bound; the component's
 * cursor-over-the-log driver loop, breaker, backoff) — each proven by unit tests against fakes and a
 * hand-composed runtime. This test proves the WHOLE loop works through the shipped `helipod dev`
 * server (real `loadProject` + `createEmbeddedRuntime` + `startDevServer`, real WebSocket, real HTTP
 * admin browse) the way "test through the shipped entrypoint" has caught wiring gaps before in this
 * project (admin browse, scheduler driver wiring — see `./scheduler-e2e.test.ts`). The fixture
 * composes `defineTriggers()` ALONGSIDE `defineScheduler()` (the multi-component composition a real
 * `helipod.config.ts` would list — see `examples/auth-demo/helipod.config.ts`), and wires the
 * composed `bootSteps`/`drivers`/`tableNumbers` exactly as `packages/cli/src/cli.ts`'s `devCommand`
 * does.
 *
 * The FULL loop under test: a committed write → the commit fan-out wakes the triggers driver via
 * `onCommit` → `readLog` reads the new revisions off the MVCC log → the handler runs → its own writes
 * fan out reactively / reach an external sink. NO manual `__tick()`/`__wake()` anywhere — every
 * delivery happens via the driver's reactive wake, exactly as it would for an app author.
 *
 * The T2 review's cannot-verify was the LIVE `onCommit` table-name shape: the driver filters
 * `inv.tables.includes(bareAppName)`, argued structurally but never driven live. If the fan-out
 * delivered namespaced or numbered table names, the trigger would never wake — scenario 1 catches
 * that on its first assertion.
 *
 * Scenarios:
 *  1. insert → the trigger's internal MUTATION handler writes a counter doc → a live WS subscription
 *     on the counter updates reactively (commit → onCommit wake → readLog → handler → fan-out);
 *  2. an internal ACTION handler receives the changes and `fetch`es a local HTTP sink (both handler
 *     kinds proven);
 *  3. crash-resume (the headline): a genuine undelivered backlog accrues while the driver is DOWN,
 *     restart → every change delivered, in order, none missed (asserted by seq sequence + changeIds);
 *  3b. partial-advance crash-resume: the sharper case the T3 review flagged as uncovered — the cursor
 *     has already advanced past a REAL delivery (not sitting at the log tip from birth) before a second,
 *     independent backlog accrues while the driver is DOWN; restart delivers EXACTLY the new backlog,
 *     the already-delivered prefix is not redelivered/reprocessed, and the whole ledger stays in ts order;
 *  4. the recursion breaker: a trigger writing its OWN watched table trips the circuit breaker,
 *     pausing with `pausedReason: "circuit-breaker"`, and the server stays healthy for other work;
 *  5. existing cli scenarios are byte-unmodified (verified by running the suite, not asserted here).
 */
import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@helipod/values";
import { query, mutation, action, InMemoryLogSink } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { AdminApi, browseTableModule, verifyAdminKey } from "@helipod/admin";
import { defineScheduler } from "@helipod/scheduler";
import { defineTriggers } from "@helipod/triggers";
import type { ComponentDefinition } from "@helipod/component";
import { loadProject, startDevServer, type DevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

const ADMIN_KEY = "TEST_ADMIN_KEY";

interface Stack {
  runtime: EmbeddedRuntime;
  server: DevServer;
  store: SqliteDocStore;
  close: () => Promise<void>;
}

/**
 * Build a full dev-server stack composing the app + the given components, wired exactly as
 * `devCommand` wires them (bootSteps/drivers/tableNumbers/context providers all threaded). `dbPath`
 * (a file) makes the store durable across a restart (scenario 3); omit it for an in-memory store.
 * `deferDrivers` boots the runtime WITHOUT starting component drivers — used to write a backlog while
 * the triggers driver is deliberately "down" (scenario 3, phase B).
 */
async function buildStack(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appModule: Record<string, any>;
  components: ComponentDefinition[];
  dbPath?: string;
  deferDrivers?: boolean;
}): Promise<Stack> {
  const project = loadProject({ schema: opts.schema, modules: { app: opts.appModule } }, opts.components);
  const logSink = new InMemoryLogSink();
  const store = new SqliteDocStore(new NodeSqliteAdapter(opts.dbPath ? { path: opts.dbPath } : {}));
  const runtime = await createEmbeddedRuntime({
    store,
    catalog: project.catalog,
    logSink,
    modules: project.moduleMap,
    adminModules: { "_admin:browseTable": browseTableModule },
    verifyAdmin: (key: string) => verifyAdminKey(ADMIN_KEY, key),
    componentNames: project.componentNames,
    contextProviders: project.contextProviders,
    // REQUIRED for the driver's reactive wake: without `tableNumbers` the runtime can't translate a
    // commit's encoded storage-table ids back into app-visible names for the driver's `onCommit`
    // filter — see `./scheduler-e2e.test.ts`'s identical note. This is the exact translation the
    // triggers driver's `inv.tables.includes(bareAppName)` filter depends on (scenario 1's headline).
    tableNumbers: project.tableNumbers,
    bootSteps: project.bootSteps,
    drivers: project.drivers,
    deferDrivers: opts.deferDrivers,
  });
  const adminApi = new AdminApi({
    runtime,
    schemaJson: project.schemaJson,
    tableNumbers: project.tableNumbers,
    manifest: project.manifest,
    logSink,
    catalog: project.catalog,
  });
  const server = await startDevServer(runtime, {
    port: 0,
    ip: "127.0.0.1",
    admin: { api: adminApi, key: ADMIN_KEY },
  });
  return {
    runtime,
    server,
    store,
    close: async () => {
      await server.close(); // stops drivers before the store goes away
      store.close();
    },
  };
}

async function runMutation(server: DevServer, path: string, args: unknown): Promise<{ committed: boolean; value: unknown }> {
  const res = await fetch(`${server.url}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { committed: boolean; value: unknown };
}

async function browse(server: DevServer, table: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${server.url}/_admin/tables/${encodeURIComponent(table)}/data`, {
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  });
  expect(res.status).toBe(200);
  const page = (await res.json()) as { documents: Array<Record<string, unknown>> };
  return page.documents;
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 25));
  }
}

/* -------------------------------------------------------------------------- */
/* WS helpers (mirrors action-e2e / workflow-e2e)                             */
/* -------------------------------------------------------------------------- */

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

type ServerMsg = {
  type: string;
  modifications?: Array<{ type: string; queryId: number; value?: unknown; error?: string }>;
};

function collectMessages(ws: WebSocket): ServerMsg[] {
  const messages: ServerMsg[] = [];
  ws.on("message", (raw: Buffer) => messages.push(JSON.parse(raw.toString("utf8")) as ServerMsg));
  return messages;
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

function latestMod(messages: ServerMsg[], queryId: number): { type: string; value?: unknown } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const mods = messages[i]?.modifications ?? [];
    for (let j = mods.length - 1; j >= 0; j--) {
      const m = mods[j];
      if (m !== undefined && m.queryId === queryId) return m;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Scenario 1 — internal MUTATION handler → live reactive subscription        */
/* -------------------------------------------------------------------------- */

describe("triggers — end-to-end through the real dev server", () => {
  it("insert → internal MUTATION handler writes a counter → a live subscription sees it reactively", async () => {
    const schema = defineSchema({
      messages: defineTable({ body: v.string() }),
      counters: defineTable({ name: v.string(), count: v.number() }).index("by_name", ["name"]),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appModule: Record<string, any> = {
      add: mutation<{ body: string }, string>({ handler: (ctx, { body }) => ctx.db.insert("messages", { body }) }),
      // The trigger handler: an INTERNAL (`app:_onMessage`) mutation — bumps a `counters` doc by the
      // number of delivered changes. `counters` is NOT a watched table, so this write does not cascade.
      _onMessage: mutation<{ changes: Array<{ changeId: string }> }, null>({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (ctx: any, { changes }) => {
          const rows = await ctx.db.query("counters", "by_name").eq("name", "messages").take(1).collect();
          const existing = rows[0];
          if (existing) await ctx.db.replace(existing._id, { ...existing, count: existing.count + changes.length });
          else await ctx.db.insert("counters", { name: "messages", count: changes.length });
          return null;
        },
      }),
      counterValue: query<Record<string, never>, number>({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (ctx: any) => {
          const rows = await ctx.db.query("counters", "by_name").eq("name", "messages").take(1).collect();
          return (rows[0]?.count as number | undefined) ?? 0;
        },
      }),
    };

    const stack = await buildStack({
      schema,
      appModule,
      components: [defineScheduler(), defineTriggers({ messages: { handler: "app:_onMessage" } })],
    });

    try {
      const ws = await openWs(`ws://127.0.0.1:${stack.server.port}/api/sync`);
      const messages = collectMessages(ws);

      // Subscribe to the counter query; initial value 0.
      send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "app:counterValue", args: {} }], remove: [] });
      await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");
      expect(latestMod(messages, 1)!.value).toBe(0);

      // Insert two messages over the real /api/run path.
      await runMutation(stack.server, "app:add", { body: "hello" });
      await runMutation(stack.server, "app:add", { body: "world" });

      // The commit fan-out woke the trigger (proving the LIVE onCommit table-name shape: bare
      // "messages", not namespaced/numbered), readLog surfaced both inserts, the handler bumped the
      // counter, and THAT write fanned out reactively to the separate live subscription.
      await waitFor(() => {
        const m = latestMod(messages, 1);
        return m?.type === "QueryUpdated" && m.value === 2;
      });
      expect(latestMod(messages, 1)!.value).toBe(2);

      ws.close();
    } finally {
      await stack.close();
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Scenario 2 — internal ACTION handler → fetch a local HTTP sink           */
  /* ------------------------------------------------------------------------ */

  it("insert → internal ACTION handler fetches a local HTTP sink with the changes", async () => {
    // A local HTTP sink the action handler POSTs to (proving an action handler runs with native
    // fetch and receives the change batch — the notification/external-sync pattern).
    const received: Array<{ changeId: string; op: string; table: string }> = [];
    const sink: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          changes: Array<{ changeId: string; op: string; table: string }>;
        };
        received.push(...body.changes);
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    const sinkPort = (sink.address() as { port: number }).port;
    const sinkUrl = `http://127.0.0.1:${sinkPort}/hook`;

    const schema = defineSchema({ events: defineTable({ kind: v.string() }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appModule: Record<string, any> = {
      emit: mutation<{ kind: string }, string>({ handler: (ctx, { kind }) => ctx.db.insert("events", { kind }) }),
      _onEvent: action<{ changes: Array<{ changeId: string; op: string; table: string }> }, null>({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (_ctx: any, { changes }) => {
          await fetch(sinkUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ changes }),
          });
          return null;
        },
      }),
    };

    const stack = await buildStack({
      schema,
      appModule,
      components: [defineScheduler(), defineTriggers({ events: { handler: "app:_onEvent" } })],
    });

    try {
      const inserted = await runMutation(stack.server, "app:emit", { kind: "signup" });
      expect(inserted.committed).toBe(true);

      // The action handler ran (reactive wake → readLog → runFunction of an ACTION path) and POSTed
      // the change to the sink — no ctx.db in an action, the whole effect is the external fetch.
      await waitFor(() => received.length >= 1);
      expect(received).toHaveLength(1);
      expect(received[0]!.table).toBe("events");
      expect(received[0]!.op).toBe("insert");
      expect(received[0]!.changeId.startsWith("events:")).toBe(true);
    } finally {
      await stack.close();
      await new Promise<void>((r) => sink.close(() => r()));
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Scenario 3 — crash-resume (the headline)                                 */
  /* ------------------------------------------------------------------------ */

  it("crash-resume: a backlog accrued while the driver was DOWN is fully delivered, in order, on restart", async () => {
    // Sharpest construction, and WHY: the backlog is written with the triggers driver DEFERRED (phase
    // B boots the runtime with `deferDrivers: true`, so the driver never starts and never advances the
    // cursor). This GUARANTEES a genuine undelivered backlog exists at restart — the racy alternative
    // ("kill the server quickly after K writes") cannot guarantee the driver hadn't already drained
    // some/all of the writes before the kill, so it could pass without ever exercising resume. Here the
    // cursor is provably behind K committed revisions when the fresh instance boots; phase C proves the
    // PERSISTED cursor + PERSISTED log redeliver every change in ts order with none missed — the
    // design's headline durability claim. The ≤30s resume beat is NOT in the way: `driver.start()`
    // calls `wakeAll()` immediately on boot (it does not wait for the periodic beat), so the backlog
    // drains promptly on restart.
    const K = 12;
    const dir = mkdtempSync(join(tmpdir(), "triggers-e2e-"));
    const dbPath = join(dir, "db.sqlite");

    const schema = defineSchema({
      messages: defineTable({ seq: v.number() }),
      // `order` = a monotonic delivery index (see `_record`) — the ROBUST in-order signal. Raw
      // `_creationTime` ties within a batch (every row a handler inserts in one call shares one commit
      // ts), so browse order within a batch is non-deterministic; `order` records the ts-ascending
      // iteration order the driver actually delivered in.
      delivered: defineTable({ changeId: v.string(), seq: v.number(), order: v.number() }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appModule: Record<string, any> = {
      add: mutation<{ seq: number }, string>({ handler: (ctx, { seq }) => ctx.db.insert("messages", { seq }) }),
      // Idempotent-on-changeId (the documented at-least-once guidance): a redelivered change is a
      // no-op, so `delivered` holds exactly one row per unique change even if the last batch redelivers.
      // `order` = the delivered-row count at the start of this call + the change's index within the
      // (ts-ascending) batch → a strictly increasing index in true delivery order.
      _record: mutation<{ changes: Array<{ changeId: string; newDoc: { seq: number } }> }, null>({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (ctx: any, { changes }) => {
          const existing = (await ctx.db.query("delivered", "by_creation").collect()) as Array<{ changeId: string }>;
          const seen = new Set(existing.map((d) => d.changeId));
          let order = existing.length;
          for (const c of changes) {
            if (seen.has(c.changeId)) continue;
            await ctx.db.insert("delivered", { changeId: c.changeId, seq: c.newDoc.seq, order: order++ });
          }
          return null;
        },
      }),
    };
    const components = (): ComponentDefinition[] => [
      defineScheduler(),
      // Small batchSize forces MULTIPLE batches across the backlog — proving full-batch continuation
      // and in-order delivery, not a single lucky one-shot drain.
      defineTriggers({ messages: { handler: "app:_record", batchSize: 3 } }),
    ];

    try {
      // Phase A — establish the cursor at the current log tip (drivers active), then shut down. No
      // watched-table writes yet, so nothing is delivered; the cursor sits at the tip.
      const a = await buildStack({ schema, appModule, components: components(), dbPath });
      await waitFor(async () => (await browse(a.server, "triggers/cursors")).some((c) => c.name === "messages"));
      const cursorAtTip = (await browse(a.server, "triggers/cursors")).find((c) => c.name === "messages")!;
      await a.close();

      // Phase B — the "server is DOWN" window: boot with drivers DEFERRED, write K messages (a genuine
      // undelivered backlog), shut down. The triggers driver never ran, so the cursor is untouched.
      const b = await buildStack({ schema, appModule, components: components(), dbPath, deferDrivers: true });
      for (let i = 0; i < K; i++) await runMutation(b.server, "app:add", { seq: i });
      expect((await browse(b.server, "messages")).length).toBe(K);
      // Nothing was delivered and the cursor did not move while drivers were deferred.
      expect((await browse(b.server, "delivered")).length).toBe(0);
      const cursorStill = (await browse(b.server, "triggers/cursors")).find((c) => c.name === "messages")!;
      expect(cursorStill.cursorTs).toBe(cursorAtTip.cursorTs);
      await b.close();

      // Phase C — restart with drivers active. The persisted cursor is behind K committed revisions;
      // `wakeAll()` on boot drains the whole backlog.
      const c = await buildStack({ schema, appModule, components: components(), dbPath });
      try {
        await waitFor(async () => (await browse(c.server, "delivered")).length >= K);
        const delivered = (await browse(c.server, "delivered")) as Array<{ changeId: string; seq: number; order: number }>;

        // Exactly K delivered, none missed, no duplicates.
        expect(delivered.length).toBe(K);
        const seqs = delivered.map((d) => d.seq).sort((x, y) => x - y);
        expect(seqs).toEqual(Array.from({ length: K }, (_, i) => i));
        expect(new Set(delivered.map((d) => d.changeId)).size).toBe(K);

        // In ts ORDER: sorting by the monotonic delivery `order` must yield ascending seq — the trigger
        // delivered every change in global ts order across every batch, with none reordered.
        const byOrder = [...delivered].sort((x, y) => x.order - y.order);
        expect(byOrder.map((d) => d.order)).toEqual(Array.from({ length: K }, (_, i) => i));
        expect(byOrder.map((d) => d.seq)).toEqual(Array.from({ length: K }, (_, i) => i));
      } finally {
        await c.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Scenario 3b — partial-advance crash-resume                               */
  /* ------------------------------------------------------------------------ */

  it("partial-advance crash-resume: a backlog accrued AFTER the cursor already advanced delivers exactly the new changes, none redelivered", async () => {
    // Scenario 3 proves FROM-ZERO backlog resume (cursor sits at the log tip, never having delivered
    // anything, when the backlog accrues). This proves the sharper case the T3 review flagged as
    // uncovered: the cursor has already advanced past a REAL delivery (a non-zero cursorTs, past
    // committed revisions) before the crash. Phase A runs the driver live and delivers K1 changes for
    // real — the cursor genuinely moves. Phase B (drivers deferred, same durable dbPath) accrues K2 MORE
    // changes on top of that advanced cursor. Phase C (drivers live again) must deliver EXACTLY the K2
    // new changes — the K1 already-delivered ones must not reappear in the ledger (the `_record`
    // dedup-on-changeId handler would silently mask a redelivery as a no-op, so we assert the ledger's
    // `order` continuation directly: order 0..K1-1 stay the untouched phase-A rows, order K1..K1+K2-1 are
    // the phase-C deliveries, in ts order) — a stronger claim than "no dupes in the end state."
    const K1 = 5;
    const K2 = 7;
    const dir = mkdtempSync(join(tmpdir(), "triggers-e2e-partial-"));
    const dbPath = join(dir, "db.sqlite");

    const schema = defineSchema({
      messages: defineTable({ seq: v.number() }),
      delivered: defineTable({ changeId: v.string(), seq: v.number(), order: v.number() }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appModule: Record<string, any> = {
      add: mutation<{ seq: number }, string>({ handler: (ctx, { seq }) => ctx.db.insert("messages", { seq }) }),
      // Identical idempotent-on-changeId ledger handler as scenario 3: a redelivered change is a no-op,
      // and `order` = prior delivered-row count + in-batch index — a strictly increasing true-delivery
      // index that survives across restarts (it reads the persisted `delivered` count fresh each call).
      _record: mutation<{ changes: Array<{ changeId: string; newDoc: { seq: number } }> }, null>({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (ctx: any, { changes }) => {
          const existing = (await ctx.db.query("delivered", "by_creation").collect()) as Array<{ changeId: string }>;
          const seen = new Set(existing.map((d) => d.changeId));
          let order = existing.length;
          for (const c of changes) {
            if (seen.has(c.changeId)) continue;
            await ctx.db.insert("delivered", { changeId: c.changeId, seq: c.newDoc.seq, order: order++ });
          }
          return null;
        },
      }),
    };
    const components = (): ComponentDefinition[] => [
      defineScheduler(),
      defineTriggers({ messages: { handler: "app:_record", batchSize: 3 } }),
    ];

    try {
      // Phase A — drivers LIVE: write K1 messages and wait for all K1 to be delivered for real. This is
      // the "cursor genuinely advances" precondition the from-zero scenario doesn't exercise.
      const a = await buildStack({ schema, appModule, components: components(), dbPath });
      for (let i = 0; i < K1; i++) await runMutation(a.server, "app:add", { seq: i });
      await waitFor(async () => (await browse(a.server, "delivered")).length >= K1);
      const deliveredAfterA = (await browse(a.server, "delivered")) as Array<{ changeId: string; seq: number; order: number }>;
      expect(deliveredAfterA.length).toBe(K1);
      const cursorAfterA = (await browse(a.server, "triggers/cursors")).find((c) => c.name === "messages")!;
      expect(cursorAfterA.cursorTs).toBeGreaterThan(0); // genuinely advanced past the log start
      await a.close();

      // Phase B — the "server is DOWN" window AFTER a real partial delivery: boot with drivers DEFERRED
      // (same durable dbPath, so the advanced cursor + K1 ledger rows persist), write K2 more messages.
      // The driver never runs, so neither the cursor nor the ledger move.
      const b = await buildStack({ schema, appModule, components: components(), dbPath, deferDrivers: true });
      for (let i = 0; i < K2; i++) await runMutation(b.server, "app:add", { seq: K1 + i });
      expect((await browse(b.server, "messages")).length).toBe(K1 + K2);
      expect((await browse(b.server, "delivered")).length).toBe(K1); // untouched — no redelivery, no new delivery
      const cursorStill = (await browse(b.server, "triggers/cursors")).find((c) => c.name === "messages")!;
      expect(cursorStill.cursorTs).toBe(cursorAfterA.cursorTs); // cursor did not move while deferred
      await b.close();

      // Phase C — restart with drivers LIVE again. The persisted cursor is behind exactly K2 committed
      // revisions (not K1+K2 — K1 was already durably delivered past the cursor in phase A).
      const c = await buildStack({ schema, appModule, components: components(), dbPath });
      try {
        await waitFor(async () => (await browse(c.server, "delivered")).length >= K1 + K2);
        const delivered = (await browse(c.server, "delivered")) as Array<{ changeId: string; seq: number; order: number }>;

        // Exactly K1 + K2 total — the K2 new ones delivered, the K1 already-delivered ones NOT
        // redelivered (dedup would mask a redelivery as a no-op, so the total count alone would not
        // catch a "delivered twice, deduped down" bug as cleanly as this: any actual duplicate insert
        // attempt would still have been filtered by `seen`, but a wrong exactly-once-per-ledger-row
        // claim is instead nailed by the changeId-uniqueness check below).
        expect(delivered.length).toBe(K1 + K2);
        expect(new Set(delivered.map((d) => d.changeId)).size).toBe(K1 + K2);

        // The K1 phase-A rows are untouched: same changeIds/order/seq as recorded right after phase A —
        // proof the phase-C drain did not re-run the handler for already-delivered changes.
        const byOrder = [...delivered].sort((x, y) => x.order - y.order);
        expect(byOrder.slice(0, K1).map((d) => d.changeId)).toEqual(deliveredAfterA.map((d) => d.changeId));
        expect(byOrder.slice(0, K1).map((d) => d.seq)).toEqual(deliveredAfterA.map((d) => d.seq));

        // The K2 NEW changes fill order K1..K1+K2-1, in ts order, matching seq K1..K1+K2-1 — exactly the
        // undelivered backlog accrued in phase B, none missed, none reordered.
        expect(byOrder.slice(K1).map((d) => d.order)).toEqual(Array.from({ length: K2 }, (_, i) => K1 + i));
        expect(byOrder.slice(K1).map((d) => d.seq)).toEqual(Array.from({ length: K2 }, (_, i) => K1 + i));

        // Every row overall in strict ts order (order-sorted seq is monotonically ascending 0..K1+K2-1).
        expect(byOrder.map((d) => d.seq)).toEqual(Array.from({ length: K1 + K2 }, (_, i) => i));
      } finally {
        await c.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Scenario 4 — the recursion breaker                                       */
  /* ------------------------------------------------------------------------ */

  it("recursion breaker: a self-writing trigger trips the circuit breaker and pauses; the server stays healthy", async () => {
    const schema = defineSchema({
      loops: defineTable({ n: v.number() }),
      neutral: defineTable({ note: v.string() }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appModule: Record<string, any> = {
      seed: mutation<{ n: number }, string>({ handler: (ctx, { n }) => ctx.db.insert("loops", { n }) }),
      // The recursion footgun: the handler writes its OWN watched table, one row per delivery. With a
      // low `maxDeliveriesPerWindow` the breaker trips instead of melting the node.
      _spin: mutation<{ changes: Array<{ newDoc: { n: number } }> }, null>({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (ctx: any, { changes }) => {
          const last = changes[changes.length - 1]!.newDoc.n;
          await ctx.db.insert("loops", { n: last + 1 });
          return null;
        },
      }),
      addNeutral: mutation<{ note: string }, string>({ handler: (ctx, { note }) => ctx.db.insert("neutral", { note }) }),
    };

    const stack = await buildStack({
      schema,
      appModule,
      components: [defineScheduler(), defineTriggers({ loops: { handler: "app:_spin", maxDeliveriesPerWindow: 8 } })],
    });

    try {
      // Kick the recursion.
      await runMutation(stack.server, "app:seed", { n: 0 });

      // The breaker trips and pauses the trigger with the operator-visible reason.
      await waitFor(async () => {
        const cursor = (await browse(stack.server, "triggers/cursors")).find((c) => c.name === "loops");
        return cursor?.state === "paused" && cursor?.pausedReason === "circuit-breaker";
      });
      const cursor = (await browse(stack.server, "triggers/cursors")).find((c) => c.name === "loops")!;
      expect(cursor.state).toBe("paused");
      expect(cursor.pausedReason).toBe("circuit-breaker");

      // The server stays healthy: an UNRELATED mutation still commits fine (the runaway trigger did
      // not wedge the node).
      const neutral = await runMutation(stack.server, "app:addNeutral", { note: "still alive" });
      expect(neutral.committed).toBe(true);
      await waitFor(async () => (await browse(stack.server, "neutral")).some((d) => d.note === "still alive"));
    } finally {
      await stack.close();
    }
  });
});
