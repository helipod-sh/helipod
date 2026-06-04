import type { D1Client, D1PreparedStatement, D1Session } from "./d1-client";

/** Minimal structural shape of the Cloudflare D1 binding we use (avoids a hard @cloudflare/workers-types
 *  dep in the engine — same discipline as the other adapters' driver seams). */
export interface D1BindingStatement { bind(...v: unknown[]): D1BindingStatement; all(): Promise<{ results: unknown[] }>; run(): Promise<{ meta: { changes: number } }>; }
export interface D1Binding {
  prepare(sql: string): D1BindingStatement;
  exec(sql: string): Promise<unknown>;
  withSession?(bookmark?: string): D1Binding & { getBookmark?(): string | null };
}

/** Adapt a real Cloudflare D1 binding (`env.DB`) to the D1Client seam. Uses D1's Sessions API for
 *  read-your-writes when the binding supports `withSession`; degrades to the plain binding otherwise. */
export function bindingD1Client(db: D1Binding): D1Client {
  const wrapStmt = (s: D1BindingStatement): D1PreparedStatement => ({
    bind: (...v: unknown[]) => wrapStmt(s.bind(...v)),
    all: async () => ({ results: (await s.all()).results as never }),
    run: async () => ({ changes: (await s.run()).meta.changes }),
  });
  const wrap = (binding: D1Binding, sessioned?: { getBookmark?(): string | null }): D1Client => ({
    prepare: (sql) => wrapStmt(binding.prepare(sql)),
    exec: async (sql) => { await binding.exec(sql); },
    withSession: (bookmark?: string): D1Session => {
      const s = binding.withSession ? binding.withSession(bookmark) : binding;
      return { client: wrap(s, s as { getBookmark?(): string | null }), latestBookmark: () => (s as { getBookmark?(): string | null }).getBookmark?.() ?? undefined };
    },
  });
  return wrap(db);
}
