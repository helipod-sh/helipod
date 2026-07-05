/**
 * Auth-demo — reactive flow test.
 *
 * Proves the full sign-up → protected query → reactive sign-out cycle end-to-end:
 *   1. signUp returns { token, userId }
 *   2. setAuth(token) → whoami subscription reactively returns the userId
 *   3. signOut + setAuth(null) → the subscription reactively becomes null
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, loopbackTransport, anyApi } from "@helipod/client";
import { query } from "@helipod/executor";
import { defineSchema } from "@helipod/values";
import { composeComponents } from "@helipod/component";
import { auth } from "@helipod/auth";
import { systemModules } from "@helipod/admin";

// ---------------------------------------------------------------------------
// Typed API references
// ---------------------------------------------------------------------------
const api = anyApi as {
  auth: {
    signUp: { __path: string };
    signIn: { __path: string };
    signOut: { __path: string };
    signInAnonymously: { __path: string };
    revokeSession: { __path: string };
  };
  whoami: { get: { __path: string } };
};

// ---------------------------------------------------------------------------
// Build the same runtime as server.ts (inline, no shared state with server.ts)
// ---------------------------------------------------------------------------

const appSchema = defineSchema({});

const appModules = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "whoami:get": query(async (ctx: any) => {
    const authCtx = ctx.auth as { getUserId: () => Promise<string | null> } | undefined;
    return authCtx ? await authCtx.getUserId() : null;
  }),
};

async function makeRuntime(): Promise<EmbeddedRuntime> {
  const composed = composeComponents(
    { schemaJson: appSchema.export(), moduleMap: appModules },
    [auth],
  );
  return createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: composed.catalog,
    modules: composed.moduleMap,
    systemModules: systemModules(),
    componentNames: composed.componentNames,
    contextProviders: composed.contextProviders,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let runtime: EmbeddedRuntime;

beforeEach(async () => {
  runtime = await makeRuntime();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auth-demo — reactive auth flow", () => {
  it("signUp returns a token and userId", async () => {
    const c = new HelipodClient(loopbackTransport(runtime.connect("t0")));
    const result = await c.mutation(api.auth.signUp, { email: "alice@example.com", password: "hunter2!" }) as {
      token: string;
      userId: string;
    };
    expect(typeof result.token).toBe("string");
    expect(result.token.length).toBeGreaterThan(0);
    expect(typeof result.userId).toBe("string");
    expect(result.userId.length).toBeGreaterThan(0);
  });

  it("after signUp + setAuth, whoami.get reactively returns the userId", async () => {
    const c = new HelipodClient(loopbackTransport(runtime.connect("t1")));

    // Sign up and capture the token
    const { token, userId } = await c.mutation(api.auth.signUp, {
      email: "alice@example.com",
      password: "hunter2!",
    }) as { token: string; userId: string };

    // Subscribe to whoami.get BEFORE setAuth — should start as null
    const seen: Array<string | null> = [];
    c.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));
    await waitFor(() => seen.length >= 1);
    expect(seen[0]).toBeNull();

    // Set auth — server re-runs subscriptions with the identity token
    c.setAuth(token);
    await waitFor(() => seen.some((v) => v !== null));

    const last = seen.at(-1)!;
    expect(last).toBe(userId);
  });

  it("signOut → whoami.get reactively becomes null", async () => {
    const c = new HelipodClient(loopbackTransport(runtime.connect("t2")));

    // Sign up
    const { token, userId } = await c.mutation(api.auth.signUp, {
      email: "bob@example.com",
      password: "hunter2!",
    }) as { token: string; userId: string };

    // Set auth and subscribe
    c.setAuth(token);
    const seen: Array<string | null> = [];
    c.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));

    // Wait until we see the userId
    await waitFor(() => seen.some((v) => v === userId));

    // Sign out: invalidate the session in the store + clear auth on the connection
    await c.mutation(api.auth.signOut, { token });
    c.setAuth(null);

    // The subscription must reactively re-fire with null
    await waitFor(() => {
      const last = seen.at(-1);
      return last === null && seen.some((v) => v === userId); // saw userId AND then null
    });

    expect(seen.at(-1)).toBeNull();
    // We saw the userId at some point before the null
    expect(seen.some((v) => v === userId)).toBe(true);
  });

  it("two clients: sign-up on one, other subscribing to whoami stays isolated", async () => {
    const a = new HelipodClient(loopbackTransport(runtime.connect("a")));
    const b = new HelipodClient(loopbackTransport(runtime.connect("b")));

    // B subscribes first (unauthenticated)
    const bSeen: Array<string | null> = [];
    b.subscribe(api.whoami.get, {}, (v) => bSeen.push(v as string | null));
    await waitFor(() => bSeen.length >= 1);
    expect(bSeen[0]).toBeNull();

    // A signs up and authenticates
    const { token: tokenA, userId: userIdA } = await a.mutation(api.auth.signUp, {
      email: "carol@example.com",
      password: "hunter2!",
    }) as { token: string; userId: string };
    a.setAuth(tokenA);

    const aSeen: Array<string | null> = [];
    a.subscribe(api.whoami.get, {}, (v) => aSeen.push(v as string | null));
    await waitFor(() => aSeen.some((v) => v === userIdA));

    // B's subscription must remain null — each connection has its own identity
    expect(bSeen.every((v) => v === null)).toBe(true);
    expect(aSeen.some((v) => v === userIdA)).toBe(true);
  });

  it("signIn after signUp returns a fresh token and the same userId", async () => {
    const c = new HelipodClient(loopbackTransport(runtime.connect("t5")));

    const { userId } = await c.mutation(api.auth.signUp, {
      email: "dave@example.com",
      password: "hunter2!",
    }) as { token: string; userId: string };

    const { token: token2, userId: userId2 } = await c.mutation(api.auth.signIn, {
      email: "dave@example.com",
      password: "hunter2!",
    }) as { token: string; userId: string };

    expect(typeof token2).toBe("string");
    expect(token2.length).toBeGreaterThan(0);
    expect(userId2).toBe(userId);
  });

  it("anonymous → signUp upgrade preserves the userId", async () => {
    const c = new HelipodClient(loopbackTransport(runtime.connect("anon1")));
    const anon = await c.mutation(api.auth.signInAnonymously, {}) as { userId: string; token: string; sessionId: string };
    c.setAuth(anon.token);
    const seen: Array<string | null> = [];
    c.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));
    await waitFor(() => seen.some((v) => v === anon.userId));
    const up = await c.mutation(api.auth.signUp, { email: "up@example.com", password: "hunter2!" }) as { userId: string; token: string };
    expect(up.userId).toBe(anon.userId);
  });

  it("revokeSession on one connection flips another connection's whoami subscription to null", async () => {
    const c = new HelipodClient(loopbackTransport(runtime.connect("revoke1")));
    const admin = new HelipodClient(loopbackTransport(runtime.connect("revoke2")));

    const s = await c.mutation(api.auth.signUp, {
      email: "erin@example.com",
      password: "hunter2!",
    }) as { token: string; userId: string; sessionId: string };

    c.setAuth(s.token);
    const seen: Array<string | null> = [];
    c.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));
    await waitFor(() => seen.some((v) => v === s.userId));

    // A second connection, holding the same token, revokes the session.
    admin.setAuth(s.token);
    await admin.mutation(api.auth.revokeSession, { sessionId: s.sessionId });

    // The first connection's live subscription reactively flips to null.
    await waitFor(() => seen.at(-1) === null);
    expect(seen.at(-1)).toBeNull();
  });
});
