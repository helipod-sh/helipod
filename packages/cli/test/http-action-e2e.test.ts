/**
 * End-to-end test: the public HTTP router (`httpAction` + `http.ts`) through the REAL dev server
 * (mirrors `action-e2e.test.ts`'s "test through the shipped entrypoint" pattern — this project has
 * caught wiring gaps 4x by exercising `startDevServer` directly instead of a runtime-level stub).
 *
 * Tasks 1-5 built the pieces (the httpAction definer/executor path, the HttpRouter/matchRoute
 * table, `runtime.runHttpAction`, project loading resolving `http.ts` -> `ProjectArtifacts.routes`,
 * and both server backends' dispatch arm) — each proven by unit/integration tests against handlers
 * directly. This test proves the WHOLE path works through the shipped `helipod dev` server:
 *
 *   real HTTP request -> the dev server's route table (built from `loadProject`'s resolved
 *   `http.ts` routes) -> `runtime.runHttpAction` -> the executor's httpAction branch ->
 *   `ctx.runMutation` writes a row -> that mutation's commit fans out reactively -> a SEPARATE
 *   live WS query subscription (`pings:list`) receives the write.
 *
 * Also covers: an unmatched path 404s, a reserved-path route fails to register (guarded at
 * `http.route()` call time, before `loadProject` ever sees it), and `server.setRoutes(...)`
 * (the hot-reload wiring `cli.ts`'s watch loop calls) actually takes effect on the next request.
 */
import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@helipod/values";
import { query, mutation, httpAction, httpRouter } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime } from "@helipod/runtime-embedded";
import { loadProject, startDevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const schema = defineSchema({ pings: defineTable({ msg: v.string() }) });

const pingsModule = {
  add: mutation<{ msg: string }, string>({
    handler: (ctx, { msg }) => ctx.db.insert("pings", { msg }),
  }),
  list: query<Record<string, never>, string[]>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (ctx) => (await (ctx.db.query("pings", "by_creation") as any).collect()).map((d: { msg: string }) => d.msg),
  }),
};

/** The webhook: reads a JSON body, writes via ctx.runMutation, returns the row as JSON. */
const hook = httpAction(async (ctx, request: Request) => {
  const body = (await request.json()) as { msg: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx as any).runMutation("pings:add", { msg: body.msg });
  return new Response(JSON.stringify({ ok: true, msg: body.msg }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

const httpModule: Record<string, unknown> = { hook };
const router = httpRouter();
router.route({ method: "POST", path: "/hook", handler: hook });
httpModule.default = router;

/* -------------------------------------------------------------------------- */
/* WS helpers (mirrors action-e2e.test.ts)                                    */
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
  modifications?: Array<{ type: string; queryId: number; value?: unknown; error?: string }>;
};

/** Collect every message the server sends on this socket. */
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

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 10));
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

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("public HTTP router — end-to-end through the real dev server", () => {
  it("webhook -> ctx.runMutation -> reactive fan-out; 404 for unmatched; setRoutes reload wiring", async () => {
    const project = loadProject({ schema, modules: { pings: pingsModule, http: httpModule } });
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
    });

    // Start the server with NO routes wired — mirrors the moment before `http.ts` is pushed — so
    // that a subsequent `server.setRoutes(project.routes)` call is a real, observable transition
    // (closes the reload-wiring coverage gap Task 5's tests didn't exercise).
    const server = await startDevServer(
      runtime,
      { port: 0, ip: "127.0.0.1" },
    );
    const wsUrl = `ws://127.0.0.1:${server.port}/api/sync`;

    try {
      /* ------------------------------------------------------------------ */
      /* 0. Before setRoutes: the webhook path isn't wired yet -> 404.       */
      /* ------------------------------------------------------------------ */
      const preRes = await fetch(`${server.url}/hook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msg: "too-early" }),
      });
      expect(preRes.status).toBe(404);

      /* ------------------------------------------------------------------ */
      /* setRoutes: the same call `cli.ts`'s watch loop makes after a hot    */
      /* reload re-resolves `http.ts`. Must take effect on the NEXT request. */
      /* ------------------------------------------------------------------ */
      server.setRoutes(project.routes);

      /* ------------------------------------------------------------------ */
      /* 1. Subscribe to pings:list over WS; expect an initial empty page.   */
      /* ------------------------------------------------------------------ */
      const ws = await openWs(wsUrl);
      const messages = collectMessages(ws);
      send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "pings:list", args: {} }], remove: [] });
      await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");
      expect(latestMod(messages, 1)!.value).toEqual([]);

      /* ------------------------------------------------------------------ */
      /* 2. Real HTTP POST /hook -> the httpAction runs, returns its JSON.   */
      /*    Proves headers/body actually cross the Node HTTP backend into a */
      /*    real `Request` (untested at the pure-`handleHttpRequest` level). */
      /* ------------------------------------------------------------------ */
      const hookRes = await fetch(`${server.url}/hook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msg: "hi" }),
      });
      expect(hookRes.status).toBe(200);
      const hookBody = (await hookRes.json()) as { ok: boolean; msg: string };
      expect(hookBody).toEqual({ ok: true, msg: "hi" });

      /* ------------------------------------------------------------------ */
      /* 3. The webhook's INNER ctx.runMutation write fanned out reactively  */
      /*    to the SEPARATE pings:list subscription.                        */
      /* ------------------------------------------------------------------ */
      await waitFor(() => {
        const m = latestMod(messages, 1);
        return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as string[]).includes("hi");
      });
      expect(latestMod(messages, 1)!.value).toEqual(["hi"]);

      /* ------------------------------------------------------------------ */
      /* 4. An unmatched path falls through to 404.                         */
      /* ------------------------------------------------------------------ */
      const nopeRes = await fetch(`${server.url}/nope`);
      expect(nopeRes.status).toBe(404);

      ws.close();
    } finally {
      await server.close();
    }
  });

  it("a reserved-path route (/api/*) is rejected at registration time — before loadProject ever sees it", () => {
    const boom = httpAction(async () => new Response("nope"));
    expect(() => {
      // Mirrors what a real `http.ts` does at module-evaluation time: build the router, then
      // register a route. `route()` guards reserved paths itself (Task 2) so a malformed
      // `http.ts` can never shadow `/api/*`/`/_*` — the throw happens before `loadProject`
      // (and thus `loadFunctionsDir`'s dynamic import of `http.ts`) can complete.
      const reservedRouter = httpRouter();
      reservedRouter.route({ method: "GET", path: "/api/x", handler: boom });
      loadProject({
        schema: defineSchema({}),
        modules: { http: { boom, default: reservedRouter } },
      });
    }).toThrow(/reserved/);
  });
});
