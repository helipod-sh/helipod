/**
 * End-to-end test: incremental (delta) `stackbase deploy` through the REAL `startServe` + the
 * REAL `deployCommand` — mirrors `deploy-e2e.test.ts`'s "test through the shipped entrypoint"
 * pattern, but targets the ONE-FILE DELTA path specifically (the incremental-push slice), not the
 * legacy full-push path `deploy-e2e.test.ts` already covers.
 *
 * The boot/WS harness below is copied verbatim in shape from `deploy-e2e.test.ts` (same
 * `startServe`/`deployCommand`/WS-subscribe machinery) since that file exports no reusable helpers.
 *
 * Proves, through the real serve server:
 *   1. `GET /_admin/deploy/modules` is `{}` before any deploy this server lifetime (boot loads the
 *      app directly, not via `/_admin/deploy` — so it never populates the tracked module set).
 *   2. Deploying v1 (fixture with two function modules, `f1` and `f2`, plus `schema.ts`) is
 *      necessarily a FULL push (nothing tracked yet) — after it, `GET /_admin/deploy/modules`
 *      returns non-empty hashes covering v1's modules.
 *   3. Deploying v2 — which changes ONLY `f2.ts` (`f1.ts`/`schema.ts` byte-identical to v1) — sends
 *      a DELTA POST body whose `changed` is exactly the `f2` module and whose `unchanged` covers
 *      every other pushed module (captured by spying `globalThis.fetch`, not inferred). `f2:add`
 *      (new in v2) is immediately callable AND its write fans out reactively to a WS subscription
 *      to `f2:list` opened BEFORE the v2 deploy — event-driven, no sleep. `f1:ping` (untouched)
 *      keeps its exact v1 behavior across the hot-swap.
 *
 * Stale-base retry and old-server-fallback (deploy-e2e.test.ts case 4/5 shape) are unit-covered at
 * the `serve-target-incremental.test.ts`/`deploy-apply.test.ts` level (Task 4) — this E2E's own v1
 * (full) -> v2 (delta) sequence already proves "a normal delta deploy works end to end" against a
 * real server, so those two cases aren't re-derived here per the task brief.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { startServe } from "../src/serve";
import { deployCommand } from "../src/deploy";
import { loadConvexDir } from "../src/load-modules";
import { push } from "../src/push-pipeline";
import { writeGenerated } from "@stackbase/codegen";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function fixtureConvexDir(name: string): string {
  return resolve(new URL(".", import.meta.url).pathname, "fixtures", name, "convex");
}

/** Refresh a fixture's committed `_generated/` in place — same codegen step `deployCommand`
 * itself performs before packaging (deterministic; re-running produces byte-identical output). */
async function regenerate(convexDir: string): Promise<void> {
  const loaded = await loadConvexDir(convexDir);
  const { generated } = push(loaded, []);
  writeGenerated(generated.files, join(convexDir, "_generated"));
}

/* -------------------------------------------------------------------------- */
/* WS helpers (copied in shape from deploy-e2e.test.ts)                       */
/* -------------------------------------------------------------------------- */

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolvePromise(ws));
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

/** Subscribe to `f2:list` over WS and wait for the initial `QueryUpdated`. */
async function subscribeToF2List(wsUrl: string): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
  const ws = await openWs(wsUrl);
  const messages = collectMessages(ws);
  send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "f2:list", args: {} }], remove: [] });
  await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");
  return { ws, messages };
}

/* -------------------------------------------------------------------------- */
/* fetch spy — captures the POST body(ies) `serveTarget.push` sends to        */
/* `/_admin/deploy` while `fn` runs, without disturbing the real network I/O. */
/* -------------------------------------------------------------------------- */

async function captureDeployPosts<T>(fn: () => Promise<T>): Promise<{ result: T; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (init?.method === "POST" && url.endsWith("/_admin/deploy") && typeof init.body === "string") {
      bodies.push(JSON.parse(init.body));
    }
    return realFetch(input, init);
  });
  try {
    const result = await fn();
    return { result, bodies };
  } finally {
    spy.mockRestore();
  }
}

/* -------------------------------------------------------------------------- */
/* Test                                                                        */
/* -------------------------------------------------------------------------- */

describe("stackbase deploy — incremental (delta) push end-to-end through the real serve server", () => {
  it("v1 full push populates /modules; v2 one-file delta is live + reactive; unrelated module untouched", async () => {
    const v1Dir = fixtureConvexDir("incremental-v1");
    const v2Dir = fixtureConvexDir("incremental-v2");
    await regenerate(v1Dir);
    await regenerate(v2Dir);

    const deployRoot = join(process.cwd(), ".stackbase-deploy");
    const OLD_ADMIN_KEY = process.env.STACKBASE_ADMIN_KEY;

    let round1: Awaited<ReturnType<typeof startServe>> | undefined;
    try {
      /* ---------------------------------------------------------------------- */
      /* 0. Boot with --allow-deploy, app loaded directly from v1Dir (not via   */
      /*    /_admin/deploy) — so the tracked module set starts genuinely empty. */
      /* ---------------------------------------------------------------------- */
      round1 = await startServe({
        convexDir: v1Dir,
        dataPath: join(mkdtempSync(join(tmpdir(), "sbincr-e2e-db-")), "db.sqlite"),
        ip: "127.0.0.1",
        port: 0,
        adminKey: "k",
        dashboard: false,
        allowDeploy: true,
      });
      process.env.STACKBASE_ADMIN_KEY = "k";
      const headers = { authorization: "Bearer k" };

      /* ---------------------------------------------------------------------- */
      /* PROOF (1): before any deploy, /modules is empty — boot loading the app */
      /* directly never populates the tracked-push set.                         */
      /* ---------------------------------------------------------------------- */
      const modulesBefore = await fetch(`${round1.server.url}/_admin/deploy/modules`, { headers });
      expect(modulesBefore.status).toBe(200);
      expect(await modulesBefore.json()).toEqual({});

      /* ---------------------------------------------------------------------- */
      /* Deploy v1 — necessarily a full push (nothing tracked yet).             */
      /* ---------------------------------------------------------------------- */
      const deployV1Code = await deployCommand(["--url", round1.server.url, "--dir", v1Dir]);
      expect(deployV1Code).toBe(0);

      /* ---------------------------------------------------------------------- */
      /* PROOF (1->2): /modules now reflects v1's pushed set — real hashes for  */
      /* real paths, including both function modules and the schema file.      */
      /* ---------------------------------------------------------------------- */
      const modulesAfterV1Res = await fetch(`${round1.server.url}/_admin/deploy/modules`, { headers });
      expect(modulesAfterV1Res.status).toBe(200);
      const modulesAfterV1 = (await modulesAfterV1Res.json()) as Record<string, string>;
      const pathsAfterV1 = Object.keys(modulesAfterV1).sort();
      expect(pathsAfterV1).toContain("f1.js");
      expect(pathsAfterV1).toContain("f2.js");
      expect(pathsAfterV1).toContain("schema.js");
      for (const sha of Object.values(modulesAfterV1)) expect(sha).toMatch(/^[0-9a-f]{64}$/);

      /* ---------------------------------------------------------------------- */
      /* Open the WS subscription to f2:list BEFORE the v2 deploy — the         */
      /* reactive proof below requires this to already be live at deploy time.  */
      /* ---------------------------------------------------------------------- */
      const wsUrl = `ws://127.0.0.1:${round1.server.port}/api/sync`;
      const { ws, messages } = await subscribeToF2List(wsUrl);
      expect(latestMod(messages, 1)!.value).toEqual([]);

      /* ---------------------------------------------------------------------- */
      /* PROOF (3): deploy v2, which changes ONLY f2.ts. Capture the real POST  */
      /* body `serveTarget.push` sends — assert it's a genuine one-file delta.  */
      /* ---------------------------------------------------------------------- */
      const { result: deployV2Code, bodies } = await captureDeployPosts(() =>
        deployCommand(["--url", round1!.server.url, "--dir", v2Dir]),
      );
      expect(deployV2Code).toBe(0);
      expect(bodies).toHaveLength(1);
      const deltaBody = bodies[0] as {
        changed: Array<{ path: string; code: string }>;
        unchanged: Array<{ path: string; sha256: string }>;
      };
      expect(deltaBody.changed).toHaveLength(1);
      expect(deltaBody.changed[0]!.path).toBe("f2.js");
      expect(deltaBody.changed[0]!.code).toContain("add");
      const unchangedPaths = deltaBody.unchanged.map((u) => u.path).sort();
      // Every module v1 pushed OTHER than f2.js must be unchanged — none dropped, none re-sent.
      expect(unchangedPaths).toEqual(pathsAfterV1.filter((p) => p !== "f2.js").sort());
      expect(unchangedPaths).toContain("f1.js");
      expect(unchangedPaths).toContain("schema.js");
      // Their hashes in the delta must match what /modules reported after v1 — genuinely the SAME
      // bytes, not just the same path.
      for (const u of deltaBody.unchanged) expect(u.sha256).toBe(modulesAfterV1[u.path]);

      /* ---------------------------------------------------------------------- */
      /* f2:add didn't exist a moment ago — now it's live, and its write fans   */
      /* out to the subscription opened before the deploy (event-driven).      */
      /* ---------------------------------------------------------------------- */
      const addRes = await fetch(`${round1.server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "f2:add", args: { box: "b1", text: "hello" } }),
      });
      expect(addRes.status).toBe(200);
      expect(((await addRes.json()) as { committed: boolean }).committed).toBe(true);

      await waitFor(() => {
        const m = latestMod(messages, 1);
        return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as unknown[]).length > 0;
      });
      expect(latestMod(messages, 1)!.value).toEqual([{ box: "b1", text: "hello" }]);

      /* ---------------------------------------------------------------------- */
      /* f1:ping (untouched module) keeps its exact v1 behavior across the      */
      /* one-file delta hot-swap.                                               */
      /* ---------------------------------------------------------------------- */
      const pingRes = await fetch(`${round1.server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "f1:ping", args: {} }),
      });
      expect(pingRes.status).toBe(200);
      expect(((await pingRes.json()) as { value: string }).value).toBe("v1");

      ws.close();
    } finally {
      if (OLD_ADMIN_KEY === undefined) delete process.env.STACKBASE_ADMIN_KEY;
      else process.env.STACKBASE_ADMIN_KEY = OLD_ADMIN_KEY;
      if (round1) {
        await round1.server.close();
        round1.store.close();
      }
      rmSync(deployRoot, { recursive: true, force: true });
    }
  });
});
