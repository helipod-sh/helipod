/**
 * End-to-end test: the admin live-browse path through the REAL dev server WebSocket (/api/sync).
 *
 * This proves the wiring that a unit test of SyncProtocolHandler cannot cover:
 *   - startDevServer upgrades the /api/sync path and routes messages to the handler
 *   - SetAdminAuth + ModifyQuerySet through the wire reaches verifyAdmin / runAdminQuery
 *   - A session without admin auth (or wrong key) gets QueryFailed through the wire
 */
import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { browseTableModule } from "@stackbase/admin";
import { loadProject, startDevServer } from "../src/index";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const schema = defineSchema({ notes: defineTable({ body: v.string() }) });
const notesModule = {
  add: mutation<{ body: string }, string>({
    handler: (ctx, { body }) => ctx.db.insert("notes", { body }),
  }),
};

/* -------------------------------------------------------------------------- */
/* WS helpers (adapted from ws.test.ts)                                       */
/* -------------------------------------------------------------------------- */

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Collect every `Transition` message the server sends on this socket. */
function collectTransitions(ws: WebSocket): { modifications: Array<{ type: string; queryId: number; value?: unknown; error?: string }> }[] {
  const transitions: { modifications: Array<{ type: string; queryId: number; value?: unknown; error?: string }> }[] = [];
  ws.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString("utf8")) as { type: string; modifications?: Array<{ type: string; queryId: number; value?: unknown; error?: string }> };
    if (msg.type === "Transition" && msg.modifications) transitions.push(msg as { modifications: Array<{ type: string; queryId: number; value?: unknown; error?: string }> });
  });
  return transitions;
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

/** Find the latest modification for a given queryId across all received transitions. */
function latestMod(
  transitions: { modifications: Array<{ type: string; queryId: number; value?: unknown; error?: string }> }[],
  queryId: number,
): { type: string; queryId: number; value?: unknown; error?: string } | undefined {
  for (let i = transitions.length - 1; i >= 0; i--) {
    const mods = transitions[i]?.modifications ?? [];
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

describe("admin live browse — end-to-end through /api/sync", () => {
  it("admin gets a live page; non-admin and wrong-key are rejected through the real server", async () => {
    // --- Build runtime ---
    const project = loadProject({ schema, modules: { notes: notesModule } });
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
      adminModules: { "_admin:browseTable": browseTableModule },
      verifyAdmin: (k) => k === "SECRET",
    });

    // Seed a row before any WS connects so the initial subscription push carries real data.
    await runtime.run("notes:add", { body: "hello from e2e" });

    const server = await startDevServer(
      runtime,
      { port: 0, ip: "127.0.0.1" },
    );
    const wsUrl = `ws://127.0.0.1:${server.port}/api/sync`;

    try {
      /* ------------------------------------------------------------------ */
      /* 1. Non-admin session: subscribing to _admin:* must yield QueryFailed */
      /* ------------------------------------------------------------------ */
      {
        const ws = await openWs(wsUrl);
        const transitions = collectTransitions(ws);

        // Subscribe without sending SetAdminAuth first.
        send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: { table: "notes" } }], remove: [] });

        await waitFor(() => latestMod(transitions, 1) !== undefined);
        const mod = latestMod(transitions, 1)!;
        expect(mod.type, "non-admin must get QueryFailed, not a live page").toBe("QueryFailed");

        ws.close();
      }

      /* ------------------------------------------------------------------ */
      /* 2. Wrong-key session: same rejection                                */
      /* ------------------------------------------------------------------ */
      {
        const ws = await openWs(wsUrl);
        const transitions = collectTransitions(ws);

        send(ws, { type: "SetAdminAuth", key: "WRONG_KEY" });
        send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: { table: "notes" } }], remove: [] });

        await waitFor(() => latestMod(transitions, 1) !== undefined);
        const mod = latestMod(transitions, 1)!;
        expect(mod.type, "wrong-key session must get QueryFailed").toBe("QueryFailed");

        ws.close();
      }

      /* ------------------------------------------------------------------ */
      /* 3. Admin session: SetAdminAuth("SECRET") → live page with seeded doc */
      /* ------------------------------------------------------------------ */
      {
        const ws = await openWs(wsUrl);
        const transitions = collectTransitions(ws);

        send(ws, { type: "SetAdminAuth", key: "SECRET" });
        send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: { table: "notes" } }], remove: [] });

        await waitFor(() => {
          const m = latestMod(transitions, 1);
          return m?.type === "QueryUpdated";
        });

        const mod = latestMod(transitions, 1)!;
        expect(mod.type).toBe("QueryUpdated");
        const page = mod.value as { documents: Array<{ body: string }> };
        expect(page.documents.map((d) => d.body)).toContain("hello from e2e");

        /* Bonus: insert another row via runtime.run and assert live-update  */
        await runtime.run("notes:add", { body: "live update" });
        await waitFor(() => {
          const m = latestMod(transitions, 1);
          if (m?.type !== "QueryUpdated") return false;
          const docs = (m.value as { documents: Array<{ body: string }> }).documents;
          return docs.some((d) => d.body === "live update");
        });

        const updated = latestMod(transitions, 1)!;
        const updatedPage = updated.value as { documents: Array<{ body: string }> };
        const bodies = updatedPage.documents.map((d) => d.body).sort();
        expect(bodies).toContain("hello from e2e");
        expect(bodies).toContain("live update");

        ws.close();
      }
    } finally {
      await server.close();
    }
  });
});
