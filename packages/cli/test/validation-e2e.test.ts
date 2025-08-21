/**
 * End-to-end test: document schema validation, enforced through the REAL dev server.
 *
 * Document validation (a wrong-typed / extra-field / missing-required insert or replace
 * throws `DocumentValidationError`) is enforced at the executor/kernel layer and proven there
 * by unit/kernel tests. This test proves the WHOLE path works through the shipped `stackbase
 * dev` server (real `startDevServer` + `loadProject`, real HTTP + WebSocket) — the way "test
 * through the shipped entrypoint" has caught wiring gaps before in this project (admin browse,
 * scheduler driver wiring, client actions):
 *
 *   POST /api/run with a well-typed document -> commits, read-back shows the row.
 *   POST /api/run with a wrong-typed document -> rejected (DocumentValidationError surfaces as
 *     a 400 with a DOCUMENT_VALIDATION code), and the row is NOT persisted on read-back — the
 *     load-bearing proof that the transaction did not commit.
 *   A valid insert still fans out reactively to a WS subscription opened before the write.
 */
import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { loadProject, startDevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const schema = defineSchema({ items: defineTable({ n: v.number() }) });

const appModule = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  add: mutation<{ n: any }, string>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (ctx: any, { n }: { n: any }) => ctx.db.insert("items", { n }),
  }),
  list: query<Record<string, never>, number[]>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (ctx) => (await (ctx.db.query("items", "by_creation") as any).collect()).map((d: { n: number }) => d.n),
  }),
};

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

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("document schema validation — end-to-end through the real dev server", () => {
  it("commits a valid write, rejects+does-not-persist an invalid write, and keeps reactivity intact", async () => {
    const project = loadProject({ schema, modules: { app: appModule } });
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
    });

    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });

    try {
      /* ------------------------------------------------------------------ */
      /* 0. Open a WS subscription to app:list BEFORE any writes, so we can  */
      /*    prove the later valid write fans out reactively.                */
      /* ------------------------------------------------------------------ */
      const wsUrl = `ws://127.0.0.1:${server.port}/api/sync`;
      const ws = await openWs(wsUrl);
      const messages = collectMessages(ws);
      send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "app:list", args: {} }], remove: [] });
      await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");
      expect(latestMod(messages, 1)!.value).toEqual([]);

      /* ------------------------------------------------------------------ */
      /* 1. A well-typed insert COMMITS: 200 + read-back shows the row.      */
      /* ------------------------------------------------------------------ */
      const validRes = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:add", args: { n: 1 } }),
      });
      expect(validRes.status).toBe(200);
      const validBody = (await validRes.json()) as { value: string };
      expect(typeof validBody.value).toBe("string");

      const afterValid = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:list", args: {} }),
      });
      expect(afterValid.status).toBe(200);
      const afterValidBody = (await afterValid.json()) as { value: number[] };
      expect(afterValidBody.value).toEqual([1]);

      /* ------------------------------------------------------------------ */
      /* 2. Reactivity intact: the valid write above fanned out to the      */
      /*    subscription opened before it.                                  */
      /* ------------------------------------------------------------------ */
      await waitFor(() => {
        const m = latestMod(messages, 1);
        return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as number[]).includes(1);
      });
      expect(latestMod(messages, 1)!.value).toEqual([1]);

      /* ------------------------------------------------------------------ */
      /* 3. A wrong-typed insert is REJECTED: non-2xx, DocumentValidationError */
      /*    surfaces with a document/schema-validation-shaped error body,      */
      /*    and — the load-bearing proof — the bad row is ABSENT on read-back, */
      /*    i.e. the transaction did NOT commit.                               */
      /* ------------------------------------------------------------------ */
      const invalidRes = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:add", args: { n: "not-a-number" } }),
      });
      expect(invalidRes.status).toBe(400);
      const invalidBody = (await invalidRes.json()) as { error: string; code: string };
      expect(invalidBody.code).toBe("DOCUMENT_VALIDATION");
      expect(invalidBody.error).toMatch(/does not match schema/);

      const afterInvalid = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:list", args: {} }),
      });
      expect(afterInvalid.status).toBe(200);
      const afterInvalidBody = (await afterInvalid.json()) as { value: number[] };
      // Still exactly the one valid row — the invalid write left no trace.
      expect(afterInvalidBody.value).toEqual([1]);
      expect(afterInvalidBody.value).not.toContain("not-a-number");

      ws.close();
    } finally {
      await server.close();
    }
  });
});
