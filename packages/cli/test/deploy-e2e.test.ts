/**
 * End-to-end test: `stackbase deploy` through the REAL `startServe` + the REAL `deployCommand` —
 * mirrors `serve-e2e.test.ts`/`http-action-e2e.test.ts`'s "test through the shipped entrypoint"
 * pattern. This is the load-bearing gate for slice 6b: it proves a live deploy hot-swaps functions
 * on a RUNNING server AND its writes still fan out reactively to an already-open WS subscription —
 * not just that the mechanism unit-tests (`deploy-apply.test.ts`, `serve-deploy.test.ts`) pass in
 * isolation.
 *
 * Proves, through the real serve server:
 *   1. `notes:list` is empty on the v1-only server.
 *   2. A real `deployCommand` run pushes v2 (adds `notes:add` + an additive optional field) live —
 *      no restart — and the mutation is immediately callable via `POST /api/run`, with its write
 *      fanning out to the WS subscription opened BEFORE the deploy (event-driven, not a sleep).
 *   3. A destructive deploy (`deploy-bad`, drops the `notes` table) is rejected (exit 1) and v2
 *      stays live — proven by successfully calling `notes:add` again afterward.
 *   4. A second server started WITHOUT `--allow-deploy` rejects `deployCommand` with the
 *      "not enabled" message.
 *   5. A wrong admin key against the allow-deploy server is a 401 (auth checked before apply).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { startServe } from "../src/serve";
import { deployCommand } from "../src/deploy";
import { loadFunctionsDir } from "../src/load-modules";
import { push } from "../src/push-pipeline";
import { writeGenerated } from "@stackbase/codegen";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function fixtureFunctionsDir(name: string): string {
  return resolve(new URL(".", import.meta.url).pathname, "fixtures", name, "stackbase");
}

/** Refresh a fixture's committed `_generated/` in place — the same load->push->write codegen
 * step `deployCommand` itself performs before packaging, so this keeps the committed output
 * honest (deterministic; running it again produces byte-identical files, i.e. no git diff). */
async function regenerate(functionsDir: string): Promise<void> {
  const loaded = await loadFunctionsDir(functionsDir);
  const { generated } = push(loaded, []);
  writeGenerated(generated.files, join(functionsDir, "_generated"));
}

/* -------------------------------------------------------------------------- */
/* WS helpers (mirrors serve-e2e.test.ts / http-action-e2e.test.ts)           */
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

/** Subscribe to `notes:list` over WS and wait for the initial `QueryUpdated`. Event-driven — no
 * polling on the WS itself, only a spin-wait on the in-memory `messages` array the socket's own
 * "message" handler mutates. */
async function subscribeToNotesList(wsUrl: string): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
  const ws = await openWs(wsUrl);
  const messages = collectMessages(ws);
  send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: {} }], remove: [] });
  await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");
  return { ws, messages };
}

/* -------------------------------------------------------------------------- */
/* Test                                                                        */
/* -------------------------------------------------------------------------- */

describe("stackbase deploy — end-to-end through the real serve server", () => {
  it("v1 -> v2 live hot-swap with reactive fan-out; destructive rejected; opt-in gate; wrong key 401", async () => {
    const v1Dir = fixtureFunctionsDir("deploy-v1");
    const v2Dir = fixtureFunctionsDir("deploy-v2");
    const badDir = fixtureFunctionsDir("deploy-bad");
    await regenerate(v1Dir);
    await regenerate(v2Dir);
    await regenerate(badDir);

    const deployRoot = join(process.cwd(), ".stackbase-deploy");
    const OLD_ADMIN_KEY = process.env.STACKBASE_ADMIN_KEY;

    let round1: Awaited<ReturnType<typeof startServe>> | undefined;
    let round2: Awaited<ReturnType<typeof startServe>> | undefined;
    try {
      /* ---------------------------------------------------------------------- */
      /* 1. Boot v1 with --allow-deploy; subscribe to notes:list -> [].         */
      /* ---------------------------------------------------------------------- */
      round1 = await startServe({
        functionsDir: v1Dir,
        dataPath: join(mkdtempSync(join(tmpdir(), "sbdeploy-e2e-db-")), "db.sqlite"),
        ip: "127.0.0.1",
        port: 0,
        adminKey: "k",
        dashboard: false,
        allowDeploy: true,
      });
      const wsUrl = `ws://127.0.0.1:${round1.server.port}/api/sync`;
      const { ws, messages } = await subscribeToNotesList(wsUrl);
      expect(latestMod(messages, 1)!.value).toEqual([]);

      /* ---------------------------------------------------------------------- */
      /* 2. Deploy v2 live (real deployCommand). notes:add didn't exist a       */
      /*    moment ago — now it's callable, and its write fans out to the       */
      /*    subscription opened BEFORE the deploy.                              */
      /* ---------------------------------------------------------------------- */
      process.env.STACKBASE_ADMIN_KEY = "k";
      const deployV2Code = await deployCommand(["--url", round1.server.url, "--dir", v2Dir]);
      expect(deployV2Code).toBe(0);

      const addRes = await fetch(`${round1.server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "notes:add", args: { box: "b1", text: "hello" } }),
      });
      expect(addRes.status).toBe(200);
      const addBody = (await addRes.json()) as { committed: boolean };
      expect(addBody.committed).toBe(true);

      await waitFor(() => {
        const m = latestMod(messages, 1);
        return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as unknown[]).length > 0;
      });
      expect(latestMod(messages, 1)!.value).toEqual([{ box: "b1", text: "hello" }]);

      /* ---------------------------------------------------------------------- */
      /* 3. A wrong admin key against the allow-deploy server: 401, auth        */
      /*    checked before apply.                                               */
      /* ---------------------------------------------------------------------- */
      const wrongKeyRes = await fetch(`${round1.server.url}/_admin/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        body: JSON.stringify({ files: [] }),
      });
      expect(wrongKeyRes.status).toBe(401);

      /* ---------------------------------------------------------------------- */
      /* 4. Deploy the destructive fixture (drops `notes`) -> rejected, exit 1. */
      /*    v2 stays live: notes:add is still callable and fans out.            */
      /* ---------------------------------------------------------------------- */
      const deployBadCode = await deployCommand(["--url", round1.server.url, "--dir", badDir]);
      expect(deployBadCode).toBe(1);

      const addRes2 = await fetch(`${round1.server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "notes:add", args: { box: "b2", text: "world" } }),
      });
      expect(addRes2.status).toBe(200);
      expect(((await addRes2.json()) as { committed: boolean }).committed).toBe(true);

      await waitFor(() => {
        const m = latestMod(messages, 1);
        return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as unknown[]).length > 1;
      });
      expect(latestMod(messages, 1)!.value).toEqual([
        { box: "b1", text: "hello" },
        { box: "b2", text: "world" },
      ]);

      ws.close();

      /* ---------------------------------------------------------------------- */
      /* 5. A SECOND server WITHOUT --allow-deploy: deployCommand exits 1 with  */
      /*    the "not enabled" message.                                          */
      /* ---------------------------------------------------------------------- */
      round2 = await startServe({
        functionsDir: v1Dir,
        dataPath: join(mkdtempSync(join(tmpdir(), "sbdeploy-e2e-db2-")), "db.sqlite"),
        ip: "127.0.0.1",
        port: 0,
        adminKey: "k",
        dashboard: false,
        allowDeploy: false,
      });
      const stderrChunks: string[] = [];
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk: unknown) => {
          stderrChunks.push(String(chunk));
          return true;
        });
      const deployDisabledCode = await deployCommand(["--url", round2.server.url, "--dir", v2Dir]);
      stderrSpy.mockRestore();
      expect(deployDisabledCode).toBe(1);
      expect(stderrChunks.join("")).toMatch(/not enabled/);
    } finally {
      if (OLD_ADMIN_KEY === undefined) delete process.env.STACKBASE_ADMIN_KEY;
      else process.env.STACKBASE_ADMIN_KEY = OLD_ADMIN_KEY;
      if (round1) {
        await round1.server.close();
        round1.store.close();
      }
      if (round2) {
        await round2.server.close();
        round2.store.close();
      }
      rmSync(deployRoot, { recursive: true, force: true });
    }
  });
});
