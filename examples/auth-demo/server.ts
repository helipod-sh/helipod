/**
 * Auth-demo dev server.
 *
 * Starts a Stackbase engine with:
 *   - The auth component (signUp / signIn / signOut / getUserId)
 *   - One app query: `whoami:get` — returns the current user id from the auth context
 *
 * Run with:  bun server.ts
 */
import { query } from "@stackbase/executor";
import { defineSchema } from "@stackbase/values";
import { composeComponents } from "@stackbase/component";
import { auth } from "@stackbase/auth";
import { SqliteDocStore, NodeSqliteAdapter, BunSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { startDevServer, detectRuntime } from "@stackbase/cli";
import { systemModules } from "@stackbase/admin";

// Empty app schema (auth component owns its tables)
const appSchema = defineSchema({});

// One protected query that reads userId from the auth context facade.
// Context providers (like auth) are attached to ctx dynamically by the executor,
// so we use `any` to access them — the ABI is verified in the flow test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const whoami = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: query(async (ctx: any) => {
    const authCtx = ctx.auth as { getUserId: () => Promise<string | null> } | undefined;
    return authCtx ? await authCtx.getUserId() : null;
  }),
};

const appModules = {
  "whoami:get": whoami.get,
};

// Compose app + auth component
const composed = composeComponents(
  { schemaJson: appSchema.export(), moduleMap: appModules },
  [auth],
);

// Pick the SQLite adapter for the current runtime (bun:sqlite under Bun, node:sqlite under Node).
const adapter = detectRuntime() === "bun" ? new BunSqliteAdapter() : new NodeSqliteAdapter();

// Create runtime
const runtime = await createEmbeddedRuntime({
  store: new SqliteDocStore(adapter),
  catalog: composed.catalog,
  modules: composed.moduleMap,
  systemModules: systemModules(),
  componentNames: composed.componentNames,
  contextProviders: composed.contextProviders,
});

// Start HTTP + WebSocket server
const server = await startDevServer(
  runtime,
  { functions: Object.keys(composed.moduleMap), tables: Object.keys(composed.tableNumbers) },
  {
    port: 3211,
    ip: "127.0.0.1",
    webDir: new URL("./web", import.meta.url).pathname,
  },
);

console.log(`Auth demo running at ${server.url}`);
