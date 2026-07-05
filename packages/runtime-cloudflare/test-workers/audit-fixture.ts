/**
 * THROWAWAY AUDIT FIXTURE (cloudflare-feature-completeness audit, 2026-07-17).
 *
 * A second real-workerd DO host booting an app that exercises features the base host.worker fixture
 * does NOT: an `action` (native Date/Math.random + ctx.runMutation), and an `httpAction` reached
 * through a bundled `http.ts` router (webhook → ctx.runMutation → reactive push). Purpose: PROVE which
 * features run on a genuine Durable Object vs. merely inferring from static analysis.
 *
 * NOT product code. Safe to delete with the audit branch.
 */
import { query, mutation, action, httpAction, httpRouter } from "@helipod/executor";
import { v, defineSchema, defineTable } from "@helipod/values";
import type { LoadedProject } from "@helipod/cli/project";
import { HelipodDurableObject, type DurableObjectAppConfig } from "@helipod/runtime-cloudflare";

const schema = defineSchema({
  notes: defineTable({ topic: v.string(), body: v.string() }).index("by_topic", ["topic"]),
});

// A bundled httpAction webhook that writes via ctx.runMutation — registered as a named export of the
// `notes` module so loadProject can resolve the http.route handler back to a `notes:hook` path.
const hook = httpAction(async (ctx, request: Request) => {
  const { topic, body } = (await request.json()) as { topic: string; body: string };
  await ctx.runMutation("notes:add", { topic, body });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
});

const notes = {
  add: mutation<{ topic: string; body: string }, string>({
    handler: (ctx, { topic, body }) => ctx.db.insert("notes", { topic, body }),
  }),
  list: query<{ topic: string }, unknown[]>({
    handler: (ctx, { topic }) => ctx.db.query("notes", "by_topic").eq("topic", topic).collect(),
  }),
  // An ACTION: no ctx.db, uses native Date/Math.random, orchestrates a write via ctx.runMutation.
  proc: action<{ topic: string }, { id: string; stamp: number; rnd: number }>({
    handler: async (ctx, { topic }) => {
      const stamp = Date.now();
      const rnd = Math.random();
      const id = (await ctx.runMutation("notes:add", { topic, body: `action@${stamp}` })) as string;
      return { id, stamp, rnd };
    },
  }),
  hook,
};

const httpRt = httpRouter();
httpRt.route({ method: "POST", path: "/hook", handler: hook });
const http = { default: httpRt };

const loaded: LoadedProject = { schema, modules: { notes, http } };

export class AuditDO extends HelipodDurableObject {
  protected appConfig(): DurableObjectAppConfig {
    return { loaded, adminKey: "audit-admin-key" };
  }
}
