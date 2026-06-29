/**
 * End-to-end test: `stackbase serve` (the production server) through the REAL `startServe` entry
 * point — mirrors `http-action-e2e.test.ts`'s "test through the shipped entrypoint" pattern, but
 * loads a real on-disk `convex/` dir (via `bootProject` -> `loadFunctionsDir`, the same path
 * `serveCommand` uses) instead of an in-memory `loadProject` call, and adds the load-bearing
 * assertion `dev` never needs to make: data survives a full server restart on the same SQLite file.
 *
 * Proves, through the real serve server:
 *   1. webhook -> ctx.runMutation -> reactive fan-out to a separate live WS query subscription
 *      (same shape as http-action-e2e.test.ts, but via `startServe` + a filesystem convex dir).
 *   2. `server.close()` + `store.close()` followed by a SECOND `startServe` on the SAME SQLite file
 *      path comes back up with the row written before the restart still there — the whole point of
 *      a self-hostable prod server backed by a persistent DB file. (SQLite WAL commits are durable
 *      on COMMIT; this assertion proves the row survives the restart, not that `close()` is what
 *      persists it.)
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { startServe } from "../src/serve";

/* -------------------------------------------------------------------------- */
/* Fixture convex/ dir on disk                                                */
/* -------------------------------------------------------------------------- */

/** Resolve a package from the CLI's own node_modules (already linked by the workspace install). */
function cliNodeModules(): string {
  return resolve(new URL(".", import.meta.url).pathname, "../node_modules");
}

/**
 * A real, dynamically-importable `convex/` dir: schema.ts (a `pings` table), pings.ts (an `add`
 * mutation + `list` query), http.ts (a `/hook` route -> an httpAction that `ctx.runMutation`s
 * `pings:add`), and a `_generated/server.ts` stub (bootProject never reads it, but a real project
 * always has it committed).
 */
function makeFixtureFunctionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sbserve-e2e-"));
  const nm = join(dir, "node_modules");
  mkdirSync(nm);
  symlinkSync(join(cliNodeModules(), "@stackbase"), join(nm, "@stackbase"));

  writeFileSync(
    join(dir, "schema.ts"),
    `
    import { v, defineSchema, defineTable } from "@stackbase/values";
    export default defineSchema({ pings: defineTable({ msg: v.string() }) });
    `,
  );

  writeFileSync(
    join(dir, "pings.ts"),
    `
    import { query, mutation } from "@stackbase/executor";
    export const add = mutation({
      handler: (ctx, { msg }) => ctx.db.insert("pings", { msg }),
    });
    export const list = query({
      handler: async (ctx) => (await ctx.db.query("pings", "by_creation").collect()).map((d) => d.msg),
    });
    `,
  );

  writeFileSync(
    join(dir, "http.ts"),
    `
    import { httpAction, httpRouter } from "@stackbase/executor";
    export const hook = httpAction(async (ctx, request) => {
      const body = await request.json();
      await ctx.runMutation("pings:add", { msg: body.msg });
      return new Response(JSON.stringify({ ok: true, msg: body.msg }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const router = httpRouter();
    router.route({ method: "POST", path: "/hook", handler: hook });
    export default router;
    `,
  );

  mkdirSync(join(dir, "_generated"));
  writeFileSync(join(dir, "_generated", "server.ts"), "// stub generated file\n");

  return dir;
}

/* -------------------------------------------------------------------------- */
/* WS helpers (mirrors http-action-e2e.test.ts)                               */
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

/** Subscribe to `pings:list` over WS and wait for the initial `QueryUpdated`. Returns the messages
 * array (event-driven — no polling) so the caller can keep watching for later pushes. */
async function subscribeToList(wsUrl: string): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
  const ws = await openWs(wsUrl);
  const messages = collectMessages(ws);
  send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "pings:list", args: {} }], remove: [] });
  await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");
  return { ws, messages };
}

/* -------------------------------------------------------------------------- */
/* Test                                                                        */
/* -------------------------------------------------------------------------- */

describe("stackbase serve — end-to-end through the real production server", () => {
  it("webhook -> ctx.runMutation -> reactive fan-out; data survives a full server restart", async () => {
    const functionsDir = makeFixtureFunctionsDir();
    const tmpDbPath = join(mkdtempSync(join(tmpdir(), "sbserve-e2e-db-")), "db.sqlite");

    /* ---------------------------------------------------------------------- */
    /* Round 1: boot, subscribe, POST the webhook, observe the reactive push. */
    /* ---------------------------------------------------------------------- */
    const round1 = await startServe({
      functionsDir,
      dataPath: tmpDbPath,
      ip: "127.0.0.1",
      port: 0,
      adminKey: "k",
      dashboard: false,
      allowDeploy: false,
    });
    try {
      const wsUrl1 = `ws://127.0.0.1:${round1.server.port}/api/sync`;
      const { ws: ws1, messages: messages1 } = await subscribeToList(wsUrl1);
      expect(latestMod(messages1, 1)!.value).toEqual([]);

      const hookRes = await fetch(`${round1.server.url}/hook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msg: "hi" }),
      });
      expect(hookRes.status).toBe(200);
      const hookBody = (await hookRes.json()) as { ok: boolean; msg: string };
      expect(hookBody).toEqual({ ok: true, msg: "hi" });

      // The webhook's INNER ctx.runMutation write fans out reactively to the SEPARATE pings:list
      // subscription — observed event-drivenly via the WS message handler, not a polling timer.
      await waitFor(() => {
        const m = latestMod(messages1, 1);
        return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as string[]).includes("hi");
      });
      expect(latestMod(messages1, 1)!.value).toEqual(["hi"]);

      ws1.close();
    } finally {
      await round1.server.close();
      round1.store.close();
    }

    /* ---------------------------------------------------------------------- */
    /* Round 2: boot AGAIN on the SAME SQLite file. The row written before    */
    /* the restart must still be there — this is the load-bearing assertion. */
    /* ---------------------------------------------------------------------- */
    const round2 = await startServe({
      functionsDir,
      dataPath: tmpDbPath,
      ip: "127.0.0.1",
      port: 0,
      adminKey: "k",
      dashboard: false,
      allowDeploy: false,
    });
    try {
      const wsUrl2 = `ws://127.0.0.1:${round2.server.port}/api/sync`;
      const { ws: ws2, messages: messages2 } = await subscribeToList(wsUrl2);
      expect(latestMod(messages2, 1)!.value).toEqual(["hi"]);
      ws2.close();
    } finally {
      await round2.server.close();
      round2.store.close();
    }
  });
});
