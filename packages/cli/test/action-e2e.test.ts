/**
 * End-to-end test: the client-action path through the REAL dev server WebSocket (/api/sync).
 *
 * Tasks 1-4 built action execution, scheduled actions, and the client WS `Action` message —
 * each proven by unit/integration tests against handlers/executors directly. This test proves
 * the WHOLE path works through the shipped `stackbase dev` server (real `startDevServer` +
 * `loadProject`, real WebSocket, real HTTP), the way "test through the shipped entrypoint" has
 * caught wiring gaps twice before in this project (admin browse, scheduler driver wiring):
 *
 *   client `Action` frame over the real WS -> SyncProtocolHandler.handleAction -> the gated
 *   public `runAction` -> the executor's action branch -> `ctx.runMutation` writes a row ->
 *   that mutation's commit fans out reactively -> a SEPARATE live query subscription
 *   (`app:list`) receives the write.
 *
 * Also asserts the HTTP fallback (`POST /api/run` with an action path, no WebSocket needed)
 * and that an unknown action path over WS replies `ActionResponse{success:false}` rather than
 * hanging or crashing the connection.
 */
import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation, action } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { loadProject, startDevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const schema = defineSchema({ items: defineTable({ body: v.string() }) });

const appModule = {
  add: mutation<{ body: string }, string>({
    handler: (ctx, { body }) => ctx.db.insert("items", { body }),
  }),
  list: query<Record<string, never>, string[]>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (ctx) => (await (ctx.db.query("items", "by_creation") as any).collect()).map((d: { body: string }) => d.body),
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  act: action<{ body: string }, string>({
    handler: async (ctx: any, { body }: { body: string }) => {
      await ctx.runMutation("app:add", { body });
      return body;
    },
  }),
};

/* -------------------------------------------------------------------------- */
/* WS helpers (mirrors admin-browse-e2e.test.ts)                              */
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

function findActionResponse(messages: ServerMsg[], requestId: string): ServerMsg | undefined {
  return messages.find((m) => m.type === "ActionResponse" && m.requestId === requestId);
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("client actions — end-to-end through /api/sync and /api/run", () => {
  it("a WS Action runs, writes via ctx.runMutation, and a separate live subscription sees the write", async () => {
    const project = loadProject({ schema, modules: { app: appModule } });
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
    });

    const server = await startDevServer(
      runtime,
      { port: 0, ip: "127.0.0.1" },
    );
    const wsUrl = `ws://127.0.0.1:${server.port}/api/sync`;

    try {
      const ws = await openWs(wsUrl);
      const messages = collectMessages(ws);

      /* ------------------------------------------------------------------ */
      /* 1. Subscribe to app:list; expect an initial empty page.             */
      /* ------------------------------------------------------------------ */
      send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "app:list", args: {} }], remove: [] });
      await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");
      expect(latestMod(messages, 1)!.value).toEqual([]);

      /* ------------------------------------------------------------------ */
      /* 2. Send a client Action; assert ActionResponse.success === true    */
      /*    and its returned value.                                         */
      /* ------------------------------------------------------------------ */
      send(ws, { type: "Action", requestId: "r1", udfPath: "app:act", args: { body: "live" } });
      await waitFor(() => findActionResponse(messages, "r1") !== undefined);
      const actionResp = findActionResponse(messages, "r1")!;
      expect(actionResp.success).toBe(true);
      expect(actionResp.value).toBe("live");

      /* ------------------------------------------------------------------ */
      /* 3. The action's INNER ctx.runMutation write fanned out reactively  */
      /*    to the SEPARATE app:list subscription, with no direct link      */
      /*    between the Action handling and the subscription.               */
      /* ------------------------------------------------------------------ */
      await waitFor(() => {
        const m = latestMod(messages, 1);
        return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as string[]).includes("live");
      });
      expect(latestMod(messages, 1)!.value).toEqual(["live"]);

      /* ------------------------------------------------------------------ */
      /* 4. An unknown action path over WS replies ActionResponse{success:  */
      /*    false}, not a hang or crash.                                    */
      /* ------------------------------------------------------------------ */
      send(ws, { type: "Action", requestId: "r2", udfPath: "app:doesNotExist", args: {} });
      await waitFor(() => findActionResponse(messages, "r2") !== undefined);
      expect(findActionResponse(messages, "r2")!.success).toBe(false);

      ws.close();

      /* ------------------------------------------------------------------ */
      /* 5. HTTP fallback: POST /api/run with an action path (no WebSocket) */
      /*    returns the action's value directly.                            */
      /* ------------------------------------------------------------------ */
      const httpRes = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:act", args: { body: "http" } }),
      });
      expect(httpRes.status).toBe(200);
      const httpBody = (await httpRes.json()) as { value: string };
      expect(httpBody.value).toBe("http");
    } finally {
      await server.close();
    }
  });
});
