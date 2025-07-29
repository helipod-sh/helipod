/**
 * End-to-end test: Convex-parity `ctx.scheduler` through the REAL dev server.
 *
 * Proves the whole chain works in the shipped binary, not just in a `makeRuntimeWithScheduler`
 * unit-test harness: `loadProject` composes `@stackbase/scheduler` exactly the way a project's
 * `stackbase.config.ts` would (see `examples/auth-demo/stackbase.config.ts`), `createEmbeddedRuntime`
 * is wired with the composed `bootSteps`/`drivers`/`tableNumbers` the same way `packages/cli/src/
 * cli.ts`'s `devCommand` wires them, and a mutation is invoked over the real HTTP `/api/run` path
 * (mirroring `packages/cli/test/admin-browse-e2e.test.ts`'s "through the real server" pattern).
 * The scheduled job's outcome is observed via the real admin HTTP browse route
 * (`GET /_admin/tables/:table/data`), not a direct runtime/store peek — so this test would catch a
 * regression in EITHER the scheduler's own dispatch OR the CLI's component wiring (the latter was,
 * before this task, a real gap: `devCommand` composed `bootSteps`/`drivers` via `composeComponents`
 * but never passed them to `createEmbeddedRuntime`, so a project listing the scheduler in its
 * config would enqueue jobs that NEVER ran against the shipped dev server).
 *
 * No manual `__tick()`/`__wake()` anywhere below — dispatch must happen via the driver's reactive
 * `onCommit` wake, wired through the real commit fan-out, exactly as it would for an app author.
 */
import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation } from "@stackbase/executor";
import { InMemoryLogSink } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { AdminApi, browseTableModule, verifyAdminKey } from "@stackbase/admin";
import { defineScheduler } from "@stackbase/scheduler";
import { loadProject, startDevServer } from "../src/index";

const schema = defineSchema({ results: defineTable({ tag: v.string() }) });

const appModule = {
  // Mirrors the Convex-parity surface: `ctx.scheduler.runAfter(0, internal.work, {...})` from
  // inside a mutation. `"app:work"` stands in for `internal.work` here — a bare string `FnRef` is
  // exactly what codegen's `internal`/`api` proxy resolves to at runtime (see `../../components/
  // scheduler/src/facade.ts`'s `getFunctionPath`), so this exercises the identical code path.
  sched: mutation<{ tag: string }, string>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (ctx: any, { tag }) => ctx.scheduler.runAfter(0, "app:work", { tag }),
  }),
  work: mutation<{ tag: string }, string>({
    handler: (ctx, { tag }) => ctx.db.insert("results", { tag }),
  }),
};

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("scheduler — Convex parity end-to-end through the real dev server", () => {
  it("ctx.scheduler.runAfter(0, ...) dispatches through the shipped dev server via reactive wake", async () => {
    // Compose the app + the scheduler component exactly as a real `stackbase.config.ts` listing
    // `defineScheduler()` would (see `../src/load-config.ts` / `examples/auth-demo/stackbase.config.ts`).
    const project = loadProject({ schema, modules: { app: appModule } }, [defineScheduler()]);

    const logSink = new InMemoryLogSink();
    const adminKey = "TEST_ADMIN_KEY";
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      logSink,
      modules: project.moduleMap,
      adminModules: { "_admin:browseTable": browseTableModule },
      verifyAdmin: (key: string) => verifyAdminKey(adminKey, key),
      componentNames: project.componentNames,
      contextProviders: project.contextProviders,
      // REQUIRED for the driver's reactive wake: without `tableNumbers`, the runtime can't
      // translate a commit's encoded storage-table ids back into "scheduler/jobs" etc. for the
      // driver's `onCommit` filter — see `packages/runtime-embedded/src/runtime.ts`'s warning.
      tableNumbers: project.tableNumbers,
      // REQUIRED for the scheduler to run at all: without `bootSteps`/`drivers`, the scheduler's
      // component driver (the event loop that actually dispatches due jobs) never starts.
      bootSteps: project.bootSteps,
      drivers: project.drivers,
    });

    const adminApi = new AdminApi({
      runtime,
      schemaJson: project.schemaJson,
      tableNumbers: project.tableNumbers,
      manifest: project.manifest,
      logSink,
      catalog: project.catalog,
    });

    const server = await startDevServer(
      runtime,
      { port: 0, ip: "127.0.0.1", admin: { api: adminApi, key: adminKey } },
    );

    try {
      // Invoke the mutation over the REAL path: a plain HTTP POST to /api/run, exactly how any
      // client (or the dashboard's function runner) would call it.
      const run = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "app:sched", args: { tag: "e2e" } }),
      });
      expect(run.status).toBe(200);
      const runBody = (await run.json()) as { value: string; committed: boolean };
      expect(runBody.committed).toBe(true);

      // Poll scheduler/jobs via the real admin HTTP browse route until the work job is "success".
      // NO tick()/__tick() call — dispatch must happen via the shipped server's own reactive wake.
      let jobRow: { fnPath?: string; state?: string } | undefined;
      await waitFor(async () => {
        const res = await fetch(`${server.url}/_admin/tables/${encodeURIComponent("scheduler/jobs")}/data`, {
          headers: { authorization: `Bearer ${adminKey}` },
        });
        expect(res.status).toBe(200);
        const page = (await res.json()) as { documents: Array<{ fnPath?: string; state?: string }> };
        jobRow = page.documents.find((d) => d.fnPath === "app:work");
        return jobRow?.state === "success";
      });

      expect(jobRow?.state).toBe("success");

      // Bonus: the work function's own side effect (the `results` insert) is visible too — proves
      // this wasn't a false positive from some OTHER job reaching "success".
      const resultsRes = await fetch(`${server.url}/_admin/tables/results/data`, {
        headers: { authorization: `Bearer ${adminKey}` },
      });
      const resultsPage = (await resultsRes.json()) as { documents: Array<{ tag: string }> };
      expect(resultsPage.documents.map((d) => d.tag)).toContain("e2e");
    } finally {
      await server.close();
    }
  });
});
