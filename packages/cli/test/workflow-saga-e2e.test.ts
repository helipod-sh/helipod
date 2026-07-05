/**
 * End-to-end test: the saga/compensation slice's reverse-order unwind through the REAL dev server.
 *
 * `components/workflow/test/saga.test.ts` proves the mechanism (reverse-stepNumber unwind, halt on
 * failed compensation, cancel-compensates, crash-resume) against a hand-composed `EmbeddedRuntime`
 * driven by a synchronous `tick()` test seam. This test proves the SAME mechanism works through the
 * shipped `helipod dev` server (real `startDevServer` + `loadProject`, real WebSocket, real HTTP
 * admin browse) — the way "test through the shipped entrypoint" has caught wiring gaps before in
 * this project (see `./workflow-e2e.test.ts`'s doc comment for the pattern and its track record).
 * `_compensate`/`_compensateDone` are already registered in `defineWorkflow`'s modules map
 * (`components/workflow/src/index.ts`), so the composed dev server is EXPECTED to include them with
 * no additional wiring — this test is the empirical check of that expectation.
 *
 * Scenario: a client mutation (`app:kick`, over the real WS) calls `ctx.workflow.start` for a
 * 2-step saga — `step.runMutation(app:charge, {...}, {compensate: app:refund})` (inserts a
 * `charges` row) then `step.runMutation(app:failStep, {}, {maxAttempts:1})` (always throws). The
 * client subscribes to `workflow:status(runId)` (a LIVE query) and watches it pass through
 * `"compensating"` and reach terminal `"failed"` — purely via the driver's reactive `onCommit` wake,
 * no manual tick anywhere. The compensation's own side effect (an inserted `refunds` row) is
 * asserted via the real admin HTTP browse route, proving the unwind actually ran through the real
 * reactive loop rather than a unit-test stub.
 */
import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@helipod/values";
import { mutation, InMemoryLogSink } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime } from "@helipod/runtime-embedded";
import { AdminApi, browseTableModule, verifyAdminKey } from "@helipod/admin";
import { defineScheduler } from "@helipod/scheduler";
import { defineWorkflow, workflow } from "@helipod/workflow";
import { loadProject, startDevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const schema = defineSchema({
  charges: defineTable({ amt: v.number() }),
  refunds: defineTable({ amt: v.number() }),
});

/** `app:orderFlow` — a charge step (with a refund compensation) followed by a step that always fails. */
const orderFlow = workflow.define({
  handler: async (step: unknown, _args: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = step as any;
    await s.runMutation("app:charge", { amt: 100 }, { compensate: "app:refund" });
    await s.runMutation("app:failStep", {}, { maxAttempts: 1 });
    return "unreached";
  },
});

const appModule = {
  charge: mutation<{ amt: number }, string>({
    handler: async (ctx, { amt }) => ctx.db.insert("charges", { amt }),
  }),
  // Receives `{ args, result }` — the original `app:charge` call's args and its return value —
  // exactly the shape `_compensate` dispatches (`components/workflow/src/modules.ts`).
  refund: mutation<{ args: { amt: number }; result: unknown }, string>({
    handler: async (ctx, { args }) => ctx.db.insert("refunds", { amt: args.amt }),
  }),
  failStep: mutation<Record<string, never>, never>({
    handler: async () => {
      throw new Error("payment gateway declined");
    },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kick: mutation<Record<string, never>, string>({ handler: (ctx: any) => ctx.workflow.start("app:orderFlow", {}) }),
};

/* -------------------------------------------------------------------------- */
/* WS helpers (mirrors workflow-e2e.test.ts)                                  */
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
  queryId?: number;
  value?: unknown;
  error?: string;
  requestId?: string;
  success?: boolean;
  modifications?: Array<{ type: string; queryId: number; value?: unknown; error?: string }>;
};

function collectMessages(ws: WebSocket): ServerMsg[] {
  const messages: ServerMsg[] = [];
  ws.on("message", (raw: Buffer) => {
    messages.push(JSON.parse(raw.toString("utf8")) as ServerMsg);
  });
  return messages;
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 20));
  }
}

/** All Transition/QueryUpdated modification VALUES seen so far for a given queryId, in arrival order. */
function modValues(messages: ServerMsg[], queryId: number): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    for (const mod of m.modifications ?? []) {
      if (mod.queryId === queryId && mod.type === "QueryUpdated") out.push(mod.value);
    }
  }
  return out;
}

function latestMod(
  messages: ServerMsg[],
  queryId: number,
): { type: string; queryId: number; value?: unknown; error?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const mods = messages[i]?.modifications ?? [];
    for (let j = mods.length - 1; j >= 0; j--) {
      const m = mods[j];
      if (m !== undefined && m.queryId === queryId) return m;
    }
  }
  return undefined;
}

function findMutationResponse(messages: ServerMsg[], requestId: string): ServerMsg | undefined {
  return messages.find((m) => m.type === "MutationResponse" && m.requestId === requestId);
}

/* -------------------------------------------------------------------------- */
/* Test                                                                        */
/* -------------------------------------------------------------------------- */

describe("workflow saga — reverse-order compensation end-to-end through the real dev server", () => {
  it(
    "a failing saga passes through compensating and reaches failed, with the refund's effect visible via admin browse",
    async () => {
      // Compose the app + scheduler + workflow components exactly as a real `helipod.config.ts`
      // listing `defineScheduler()`/`defineWorkflow()` would (see
      // `examples/auth-demo/helipod.config.ts`, and `./workflow-e2e.test.ts`'s identical setup).
      const project = loadProject({ schema, modules: { app: appModule } }, [
        defineScheduler(),
        defineWorkflow({ workflows: { "app:orderFlow": orderFlow } }),
      ]);

      const logSink = new InMemoryLogSink();
      const adminKey = "TEST_ADMIN_KEY";
      const runtime = await createEmbeddedRuntime({
        store: new SqliteDocStore(new NodeSqliteAdapter()),
        catalog: project.catalog,
        logSink,
        modules: project.moduleMap,
        adminModules: { "_admin:browseTable": browseTableModule },
        verifyAdmin: (key: string) => verifyAdminKey(adminKey, key),
        componentNames: project.componentNames,
        contextProviders: project.contextProviders,
        // REQUIRED for the driver's reactive wake — see `./workflow-e2e.test.ts`'s identical note.
        tableNumbers: project.tableNumbers,
        // REQUIRED for the scheduler (and therefore the workflow component built on it) to run at
        // all — without `bootSteps`/`drivers`, no due job (including `workflow:_advance`/
        // `workflow:_compensate`) ever dispatches. Exact wiring `devCommand`
        // (`packages/cli/src/cli.ts`) must also pass through to `createEmbeddedRuntime`.
        bootSteps: project.bootSteps,
        drivers: project.drivers,
      });

      const adminApi = new AdminApi({
        runtime,
        schemaJson: project.schemaJson,
        tableNumbers: project.tableNumbers,
        manifest: project.manifest,
        logSink,
        catalog: project.catalog,
      });

      const server = await startDevServer(
        runtime,
        { port: 0, ip: "127.0.0.1", admin: { api: adminApi, key: adminKey } },
      );
      const wsUrl = `ws://127.0.0.1:${server.port}/api/sync`;

      try {
        const ws = await openWs(wsUrl);
        const messages = collectMessages(ws);

        /* ------------------------------------------------------------------ */
        /* 1. Client mutation `app:kick` over the real WS -> ctx.workflow.start */
        /*    -> IMMEDIATELY (same event-loop turn, no polling delay) subscribe */
        /*    to `workflow:status(runId)`. The compensate/terminal cascade runs */
        /*    reactively via microtask chaining with no artificial delay of its */
        /*    own (this in-process SQLite setup has no real I/O yield), so a    */
        /*    `waitFor`-style poll with a real `setTimeout` gap here would give */
        /*    the ENTIRE saga (compensating -> failed) enough wall-clock time   */
        /*    to finish before the subscription is even registered — the very  */
        /*    gap this test exists to drive through. Subscribing the instant    */
        /*    the WS "message" event for kick1's response fires (no poll gap)   */
        /*    is what actually gives the live query a chance to observe the     */
        /*    transient "compensating" state.                                  */
        /* ------------------------------------------------------------------ */
        const runId = await new Promise<string>((resolve, reject) => {
          const onMessage = (raw: Buffer): void => {
            const msg = JSON.parse(raw.toString("utf8")) as ServerMsg;
            if (msg.type !== "MutationResponse" || msg.requestId !== "kick1") return;
            ws.off("message", onMessage);
            if (!msg.success) {
              reject(new Error(`kick1 mutation failed: ${String(msg.error)}`));
              return;
            }
            const id = msg.value as string;
            send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "workflow:status", args: { runId: id } }], remove: [] });
            resolve(id);
          };
          ws.on("message", onMessage);
          send(ws, { type: "Mutation", requestId: "kick1", udfPath: "app:kick", args: {} });
        });
        expect(typeof runId).toBe("string");
        await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");

        /* ------------------------------------------------------------------ */
        /* 3. It reaches terminal "failed" — purely via the driver's reactive  */
        /*    wake, no manual tick anywhere in this test.                     */
        /* ------------------------------------------------------------------ */
        await waitFor(() => {
          const m = latestMod(messages, 1);
          return m?.type === "QueryUpdated" && (m.value as { state?: string } | undefined)?.state === "failed";
        });
        const finalStatus = latestMod(messages, 1)!.value as { state: string; error?: string };
        expect(finalStatus.state).toBe("failed");
        expect(finalStatus.error).toMatch(/payment gateway declined/);

        /* ------------------------------------------------------------------ */
        /* 4. Along the way, the live subscription actually passed through     */
        /*    "compensating" — proving the unwind ran as a distinct reactive   */
        /*    phase, not just a straight-to-failed transition.                 */
        /* ------------------------------------------------------------------ */
        const seenStates = modValues(messages, 1).map((v) => (v as { state?: string } | null)?.state);
        expect(seenStates).toContain("compensating");

        /* ------------------------------------------------------------------ */
        /* 5. The compensation's own effect (a "refunds" row) is visible via   */
        /*    the real admin HTTP browse route — the refund mutation actually  */
        /*    ran through the real reactive loop, not a unit-test stub.        */
        /* ------------------------------------------------------------------ */
        const res = await fetch(`${server.url}/_admin/tables/refunds/data`, {
          headers: { authorization: `Bearer ${adminKey}` },
        });
        expect(res.status).toBe(200);
        const page = (await res.json()) as { documents: Array<{ amt: number }> };
        expect(page.documents.map((d) => d.amt)).toEqual([100]);

        ws.close();
      } finally {
        await server.close();
      }
    },
    15_000,
  );
});
