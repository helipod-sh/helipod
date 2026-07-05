/**
 * Auth A1 — E2E through the real `helipod dev` server (e2e-through-shipped-entrypoint rule).
 * A REAL `@helipod/client` over a REAL WebSocket to a REAL server with `@helipod/auth` composed.
 *
 *  (1) reactive revocation: a live `whoami` subscription flips to null when ANOTHER connection calls
 *      `auth:revokeSession` — the session-row delete fans out through the read-set;
 *  (2) rotate-while-subscribed: a full `auth:refresh` cycle keeps identity continuous (the client
 *      re-`setAuth`s the new access token; the subscription never loses the user);
 *  (3) anonymous → upgrade: a row written while anonymous is still readable by the upgraded user
 *      through the SAME live subscription (userId continuity).
 */
import { describe, it, expect, afterAll } from "vitest";
import { v, defineSchema, defineTable } from "@helipod/values";
import { query, mutation } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, webSocketTransport, anyApi } from "@helipod/client";
import { defineAuth, type MintResult } from "@helipod/auth";
import { loadProject, startDevServer, type DevServer } from "../src/index";

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

const appSchema = defineSchema({
  notes: defineTable({ userId: v.string(), body: v.string() }).index("byUser", ["userId"]),
});

const appModules = {
  whoami: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: query(async (ctx: any) => (ctx.auth ? await ctx.auth.getUserId() : null)),
    // Returns the caller's own notes — proves an anonymous-written row survives an upgrade.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    myNotes: query(async (ctx: any) => {
      const uid = ctx.auth ? await ctx.auth.getUserId() : null;
      if (!uid) return [];
      return (ctx.db.query("notes", "byUser") as any).eq("userId", uid).collect();
    }),
  },
  notes: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    add: mutation(async (ctx: any, { body }: { body: string }) => {
      const uid = await ctx.auth.getUserId();
      if (!uid) throw new Error("not authenticated");
      return ctx.db.insert("notes", { userId: uid, body });
    }),
  },
};

const api = anyApi as {
  auth: { signUp: { __path: string }; signInAnonymously: { __path: string }; refresh: { __path: string }; revokeSession: { __path: string } };
  whoami: { get: { __path: string }; myNotes: { __path: string } };
  notes: { add: { __path: string } };
};

const servers: DevServer[] = [];
async function startServer(): Promise<{ server: DevServer; wsUrl: string }> {
  const project = loadProject({ schema: appSchema, modules: appModules }, [defineAuth()]);
  const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
    componentNames: project.componentNames,
    contextProviders: project.contextProviders,
    bootSteps: project.bootSteps,
    drivers: project.drivers,
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  servers.push(server);
  return { server, wsUrl: `ws://127.0.0.1:${server.port}/api/sync` };
}

afterAll(async () => { for (const s of servers) await s.close(); });

describe("auth A1 E2E through the real dev server", () => {
  it("(1) revocation fans out reactively to a live whoami subscription", async () => {
    const { wsUrl } = await startServer();
    const c = new HelipodClient(webSocketTransport(wsUrl, { reconnect: false }));
    const admin = new HelipodClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      const s = (await c.mutation(api.auth.signUp, { email: "a@b.co", password: "pw", deviceLabel: "Chrome" })) as unknown as MintResult;
      c.setAuth(s.token);
      const seen: Array<string | null> = [];
      c.subscribe(api.whoami.get, {}, (v2) => seen.push(v2 as string | null));
      await waitFor(() => seen.some((x) => x === s.userId), 5000, "authed");
      // A second connection (the same user, holding the same token) revokes the session.
      admin.setAuth(s.token);
      await admin.mutation(api.auth.revokeSession, { sessionId: s.sessionId });
      await waitFor(() => seen.at(-1) === null, 5000, "reactive revoke");
      expect(seen.at(-1)).toBeNull();
    } finally {
      c.close();
      admin.close();
    }
  });

  it("(2) rotate-while-subscribed keeps identity continuous", async () => {
    const { wsUrl } = await startServer();
    const c = new HelipodClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      const s = (await c.mutation(api.auth.signUp, { email: "b@b.co", password: "pw" })) as unknown as MintResult;
      c.setAuth(s.token);
      const seen: Array<string | null> = [];
      c.subscribe(api.whoami.get, {}, (v2) => seen.push(v2 as string | null));
      await waitFor(() => seen.some((x) => x === s.userId), 5000, "authed");
      const rotated = (await c.mutation(api.auth.refresh, { refreshToken: s.refreshToken })) as unknown as MintResult;
      expect(rotated.sessionId).toBe(s.sessionId);
      c.setAuth(rotated.token);                       // client re-applies the new access token
      // Identity continuous: after re-setAuth the subscription resolves the same userId again. A
      // transient null frame between the rotation commit (old tokenHash overwritten) and the
      // setAuth re-run is EXPECTED and inherent to the design — do not assert its absence.
      await waitFor(() => seen.at(-1) === s.userId, 5000, "continuity");
      expect(seen.at(-1)).toBe(s.userId);
    } finally {
      c.close();
    }
  });

  it("(3) anonymous → upgrade: a row written while anonymous survives, readable by the upgraded user", async () => {
    const { wsUrl } = await startServer();
    const c = new HelipodClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      const anon = (await c.mutation(api.auth.signInAnonymously, {})) as unknown as MintResult;
      c.setAuth(anon.token);
      await c.mutation(api.notes.add, { body: "written-while-anon" });
      const notes: Array<Array<{ body: string }>> = [];
      c.subscribe(api.whoami.myNotes, {}, (v2) => notes.push(v2 as Array<{ body: string }>));
      await waitFor(() => notes.at(-1)?.some((n) => n.body === "written-while-anon") ?? false, 5000, "anon note");
      // Upgrade in place (same userId); re-apply the fresh session token.
      const up = (await c.mutation(api.auth.signUp, { email: "c@b.co", password: "pw" })) as unknown as MintResult;
      expect(up.userId).toBe(anon.userId);
      c.setAuth(up.token);
      // The SAME live subscription still shows the anon-written note under the upgraded identity.
      await waitFor(() => notes.at(-1)?.some((n) => n.body === "written-while-anon") ?? false, 5000, "survives upgrade");
      expect(notes.at(-1)?.some((n) => n.body === "written-while-anon")).toBe(true);
    } finally {
      c.close();
    }
  });
});
