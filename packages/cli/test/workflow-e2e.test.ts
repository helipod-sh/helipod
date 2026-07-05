/**
 * End-to-end test: Convex-parity `@helipod/workflow` through the REAL dev server.
 *
 * Tasks 1-6 built the durable workflow engine (replay, journal, OCC guard, cancel, action/sleep
 * steps, fan-out, waitForEvent) — each proven by unit/integration tests against a hand-composed
 * `EmbeddedRuntime` (`components/workflow/test/helpers.ts`'s `makeRuntimeWithWorkflow`). This test
 * proves the WHOLE loop works through the shipped `helipod dev` server (real `startDevServer` +
 * `loadProject`, real WebSocket, real HTTP admin browse) the way "test through the shipped
 * entrypoint" has caught wiring gaps before in this project (admin browse, scheduler driver
 * wiring — see `./scheduler-e2e.test.ts`'s doc comment): `loadProject` composes
 * `@helipod/scheduler` + `@helipod/workflow` exactly the way a project's `helipod.config.ts`
 * would (see `examples/auth-demo/helipod.config.ts`), and `createEmbeddedRuntime` is wired with
 * the composed `bootSteps`/`drivers`/`tableNumbers` the same way `packages/cli/src/cli.ts`'s
 * `devCommand` wires them.
 *
 * Scenario: a client mutation (`app:kick`, over the real WS) calls `ctx.workflow.start` for a
 * multi-step workflow — `step.runMutation` -> `step.runAction` -> `step.waitForEvent("go")` ->
 * return. The client subscribes to `workflow:status(runId)` (a LIVE query) and watches it reach
 * `"running"` (parked on `waitForEvent`, having already run the mutation + action steps — the
 * action step's own side effect, a row written via its own `ctx.runMutation`, is asserted via the
 * real admin HTTP browse route). A second client mutation (`app:go`, `ctx.workflow.sendEvent`)
 * resolves the wait; the SAME live subscription is asserted to transition to `"completed"` with the
 * expected composed result — with NO manual `__tick()`/`__wake()` anywhere: every step of the
 * cascade (mutation step -> action step -> parked wait -> resolved wait -> completion) must
 * advance via the driver's reactive `onCommit` wake, wired through the real commit fan-out, exactly
 * as it would for an app author.
 */
import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@helipod/values";
import { mutation, action, InMemoryLogSink } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime } from "@helipod/runtime-embedded";
import { AdminApi, browseTableModule, verifyAdminKey } from "@helipod/admin";
import { defineScheduler } from "@helipod/scheduler";
import { defineWorkflow, workflow } from "@helipod/workflow";
import { loadProject, startDevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const schema = defineSchema({ logs: defineTable({ tag: v.string() }) });

/** `app:orderFlow` — runMutation -> runAction -> waitForEvent("go") -> return the composed result. */
const orderFlow = workflow.define({
  handler: async (step: unknown, _args: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = step as any;
    const r1 = await s.runMutation("app:step1", {});
    const r2 = await s.runAction("app:step2", {});
    const approval = await s.waitForEvent("go");
    return { r1, r2, approval };
  },
});

const appModule = {
  step1: mutation<Record<string, never>, string>({
    handler: async (ctx, {}) => {
      await ctx.db.insert("logs", { tag: "step1" });
      return "step1-done";
    },
  }),
  writeLog: mutation<{ tag: string }, string>({
    handler: (ctx, { tag }) => ctx.db.insert("logs", { tag }),
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step2: action<Record<string, never>, string>({
    handler: async (ctx: any, {}) => {
      await ctx.runMutation("app:writeLog", { tag: "step2" });
      return "step2-done";
    },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kick: mutation<Record<string, never>, string>({ handler: (ctx: any) => ctx.workflow.start("app:orderFlow", {}) }),
  go: mutation<{ runId: string }, null>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (ctx: any, { runId }) => {
      await ctx.workflow.sendEvent(runId, "go", { approved: true });
      return null;
    },
  }),
};

/* -------------------------------------------------------------------------- */
/* WS helpers (mirrors action-e2e.test.ts / scheduler-e2e.test.ts)            */
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

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 20));
  }
}

/** Find the latest Transition modification for a given queryId across all received messages. */
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

describe("workflow — Convex parity end-to-end through the real dev server", () => {
  it(
    "a WS client starts a multi-step workflow, watches it park on waitForEvent, sends the event, and watches it complete — via reactive wake only",
    async () => {
      // Compose the app + scheduler + workflow components exactly as a real `helipod.config.ts`
      // listing `defineScheduler()`/`defineWorkflow()` would (see
      // `examples/auth-demo/helipod.config.ts`). `workflow` requires `scheduler` — see
      // `defineWorkflow`'s doc comment in `components/workflow/src/index.ts`.
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
        // REQUIRED for the driver's reactive wake — see `./scheduler-e2e.test.ts`'s identical note.
        tableNumbers: project.tableNumbers,
        // REQUIRED for the scheduler (and therefore the workflow component built on it) to run at
        // all — without `bootSteps`/`drivers`, no due job (including `workflow:_advance`) ever
        // dispatches. This is the exact wiring `devCommand` (`packages/cli/src/cli.ts`) must also
        // pass through to `createEmbeddedRuntime`.
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
        /* ------------------------------------------------------------------ */
        send(ws, { type: "Mutation", requestId: "kick1", udfPath: "app:kick", args: {} });
        await waitFor(() => findMutationResponse(messages, "kick1") !== undefined);
        const kickResp = findMutationResponse(messages, "kick1")!;
        expect(kickResp.success).toBe(true);
        const runId = kickResp.value as string;
        expect(typeof runId).toBe("string");

        /* ------------------------------------------------------------------ */
        /* 2. Subscribe to the LIVE `workflow:status(runId)` query.            */
        /* ------------------------------------------------------------------ */
        send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "workflow:status", args: { runId } }], remove: [] });
        await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");

        /* ------------------------------------------------------------------ */
        /* 3. It reaches "running" (parked on waitForEvent) purely via the     */
        /*    driver's reactive wake — no manual tick anywhere in this test.   */
        /* ------------------------------------------------------------------ */
        await waitFor(() => {
          const m = latestMod(messages, 1);
          return m?.type === "QueryUpdated" && (m.value as { state?: string } | undefined)?.state === "running";
        });

        /* ------------------------------------------------------------------ */
        /* 4. The mutation step AND the action step actually ran: both rows    */
        /*    are visible via the real admin HTTP browse route (the action     */
        /*    step's row is its own INNER ctx.runMutation write, proving the   */
        /*    action didn't just no-op).                                      */
        /* ------------------------------------------------------------------ */
        await waitFor(async () => {
          const res = await fetch(`${server.url}/_admin/tables/logs/data`, {
            headers: { authorization: `Bearer ${adminKey}` },
          });
          expect(res.status).toBe(200);
          const page = (await res.json()) as { documents: Array<{ tag: string }> };
          const tags = page.documents.map((d) => d.tag);
          return tags.includes("step1") && tags.includes("step2");
        });

        /* ------------------------------------------------------------------ */
        /* 5. A second client mutation `app:go` -> ctx.workflow.sendEvent      */
        /*    resolves the parked waitForEvent step.                          */
        /* ------------------------------------------------------------------ */
        send(ws, { type: "Mutation", requestId: "go1", udfPath: "app:go", args: { runId } });
        await waitFor(() => findMutationResponse(messages, "go1") !== undefined);
        expect(findMutationResponse(messages, "go1")!.success).toBe(true);

        /* ------------------------------------------------------------------ */
        /* 6. The SAME live subscription transitions to "completed" with the  */
        /*    expected composed result — again purely via reactive wake.      */
        /* ------------------------------------------------------------------ */
        await waitFor(() => {
          const m = latestMod(messages, 1);
          return m?.type === "QueryUpdated" && (m.value as { state?: string } | undefined)?.state === "completed";
        });
        const finalStatus = latestMod(messages, 1)!.value as { state: string; result?: unknown };
        expect(finalStatus.state).toBe("completed");
        expect(finalStatus.result).toEqual({ r1: "step1-done", r2: "step2-done", approval: { approved: true } });

        ws.close();
      } finally {
        await server.close();
      }
    },
    10_000,
  );
});
