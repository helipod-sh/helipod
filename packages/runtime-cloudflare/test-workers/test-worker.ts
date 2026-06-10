/**
 * The test Worker loaded into workerd by the vitest-pool-workers project. Exports two Durable Object
 * classes:
 *   - `SqlProbeDO` — a bare DO used to reach the REAL `ctx.storage.sql` / `transactionSync` for the
 *     `DoSqliteAdapter` conformance (`runInDurableObject`).
 *   - `FixtureStackbaseDO` — the real DO host booting the minimal fixture app, for the serve →
 *     subscribe → commit → push proof inside workerd.
 */
import { query, mutation } from "@stackbase/executor";
import { v, defineSchema, defineTable } from "@stackbase/values";
import type { LoadedProject } from "@stackbase/cli/project";
import { StackbaseDurableObject, type DurableObjectAppConfig } from "@stackbase/runtime-cloudflare";

/** A bare DO exposing its storage — the test reaches `state.storage.sql` via `runInDurableObject`. */
export class SqlProbeDO {
  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly ctx: { storage: { sql: unknown; transactionSync: unknown } },
    readonly env: unknown,
  ) {}
  // A DO needs at least one handler for workerd to instantiate it; `runInDurableObject` reaches
  // `ctx.storage` directly, so this is never actually called.
  async fetch(): Promise<Response> {
    return new Response("ok");
  }
}

const schema = defineSchema({
  messages: defineTable({ conversationId: v.string(), body: v.string() }).index("by_conversation", ["conversationId"]),
});
const messages = {
  send: mutation<{ conversationId: string; body: string }, string>({
    handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
  }),
  list: query<{ conversationId: string }, unknown[]>({
    handler: (ctx, { conversationId }) =>
      ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect(),
  }),
};
const loaded: LoadedProject = { schema, modules: { messages } };

export class FixtureStackbaseDO extends StackbaseDurableObject {
  protected appConfig(): DurableObjectAppConfig {
    return { loaded, adminKey: "workerd-test-admin-key" };
  }
}

// THROWAWAY audit re-export (cloudflare-feature-completeness audit) — a DO class must be exported
// from the Worker's main module for workerd to instantiate it.
export { AuditDO } from "./audit-fixture";

// File-storage (R2) + component-route (OAuth) fixture — a DO class must be exported from the Worker's
// main module for workerd to instantiate it.
export { StorageDO } from "./storage-fixture";

// M2b `.global()` D1-backed table fixture — a DO class must be exported from the Worker's main
// module for workerd to instantiate it.
export { GlobalD1DO } from "./global-d1-fixture";

// A Worker needs a default handler even when tests drive the DOs directly.
export default {
  async fetch(): Promise<Response> {
    return new Response("stackbase do test worker");
  },
};
