/**
 * End-to-end test: the wake seam (`serve --wake-url`) through the REAL `startServe` entry point.
 *
 * This is the test the wake seam shipped WITHOUT, and its absence is exactly why the seam could be
 * 78/78 green while `armWake` was never called once in production. `packages/runtime-embedded/test/
 * wake-host.test.ts` proves the MULTIPLEXER (min-tracking, re-arm, `fireDueTimers`) against a
 * hand-built `EmbeddedRuntime.create`, and every layer it touches genuinely works. The bug lived in
 * the one layer it skips: the boot path that has to carry `wakeHost` from a CLI flag down into
 * `createEmbeddedRuntime` (`bootProject` forwards every key explicitly and simply never forwarded
 * this one — see its comment).
 *
 * So this test hand-builds nothing the shipped server builds itself: a real on-disk `helipod/` dir, a
 * real `helipod.config.ts` composing `@helipod/scheduler`, booted through the real `startServe`
 * (the same call `serveCommand` makes), driven over the real HTTP `/api/run`, with the wake host
 * reached over a real HTTP listener. The test supplies the listener and — in the round-trip test —
 * the alarm, because those are the HOST's jobs (a Durable Object's `schedule()`); it never supplies
 * an arm, which is the engine's job and the thing under proof.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { startServe } from "../src/serve";

const ADMIN_KEY = "TEST_ADMIN_KEY";

/**
 * A job due sooner than ANY backstop poll (the scheduler's sweep is 30s), so the runtime's
 * `min(atMs)` genuinely MOVES to this job and the arm carries the job's own instant. A job due
 * later would be multiplexed behind the sweep — correct behavior, but it proves nothing about the
 * job. (The first draft of this test asserted a 60s job's instant and failed against a WORKING
 * seam for exactly that reason.)
 */
const JOB_DELAY_MS = 2_000;

/* -------------------------------------------------------------------------- */
/* A real HTTP wake listener — stands in for the Cloudflare Outbound Worker    */
/* -------------------------------------------------------------------------- */

/**
 * Records every `armWake` POST the way the real rig's `http://wake.do/arm` would receive it: a bare
 * absolute-ms integer body, or an empty body for `null` (nothing pending). Answers 204, like a DO
 * `schedule()` handler with nothing to say back.
 */
async function wakeListener(): Promise<{ url: string; arms: Array<number | null>; close: () => Promise<void> }> {
  const arms: Array<number | null> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      arms.push(body === "" ? null : Number(body));
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/_wake`,
    arms,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/* -------------------------------------------------------------------------- */
/* Fixture project on disk (helipod/ + helipod.config.ts composing scheduler) */
/* -------------------------------------------------------------------------- */

/** Resolve a package from the CLI's own node_modules (already linked by the workspace install). */
function cliNodeModules(): string {
  return resolve(new URL(".", import.meta.url).pathname, "../node_modules");
}

/**
 * A real project ROOT: `helipod.config.ts` at the top (where `bootProject`'s
 * `loadConfig(dirname(functionsDir))` looks for it) and a dynamically-importable `helipod/`
 * beneath — i.e. the layout a real deployment has, so `bootProject` composes the scheduler for
 * itself rather than being handed a pre-composed project.
 */
function makeFixtureProject(): { root: string; functionsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "sbwake-e2e-"));
  const nm = join(root, "node_modules");
  mkdirSync(nm);
  symlinkSync(join(cliNodeModules(), "@helipod"), join(nm, "@helipod"));

  writeFileSync(
    join(root, "helipod.config.ts"),
    `
    import { defineConfig } from "@helipod/component";
    import { defineScheduler } from "@helipod/scheduler";
    export default defineConfig({ components: [defineScheduler()] });
    `,
  );

  const functionsDir = join(root, "helipod");
  mkdirSync(functionsDir);
  mkdirSync(join(functionsDir, "_generated"));
  // `serveCommand` fail-fasts on a missing `_generated/server.ts`; `bootProject` never reads it, but
  // a real project always has it committed, so the fixture does too.
  writeFileSync(join(functionsDir, "_generated", "server.ts"), `export {};`);

  writeFileSync(
    join(functionsDir, "schema.ts"),
    `
    import { v, defineSchema, defineTable } from "@helipod/values";
    export default defineSchema({ results: defineTable({ tag: v.string() }) });
    `,
  );

  writeFileSync(
    join(functionsDir, "jobs.ts"),
    `
    import { mutation } from "@helipod/executor";
    export const schedule = mutation({
      handler: (ctx, { tag, delayMs }) => ctx.scheduler.runAfter(delayMs, "jobs:work", { tag }),
    });
    export const work = mutation({
      handler: (ctx, { tag }) => ctx.db.insert("results", { tag }),
    });
    `,
  );

  return { root, functionsDir };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Boot the fixture through the real `startServe` — the same call `serveCommand` makes. */
async function serveFixture(opts: { wakeUrl?: string } = {}) {
  const { root, functionsDir } = makeFixtureProject();
  const booted = await startServe({
    functionsDir,
    dataPath: join(root, "data", "db.sqlite"),
    ip: "127.0.0.1",
    port: 0,
    dashboard: false,
    allowDeploy: false,
    fleet: false,
    replica: false,
    adminKey: ADMIN_KEY,
    ...(opts.wakeUrl !== undefined ? { wakeUrl: opts.wakeUrl } : {}),
  });
  cleanups.push(async () => {
    await booted.server.close();
    await booted.store.close();
  });
  return booted;
}

/** Commit a scheduled job over the REAL HTTP surface, exactly as the repro does. */
async function scheduleJob(url: string, tag: string, delayMs: number): Promise<void> {
  const res = await fetch(`${url}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "jobs:schedule", args: { tag, delayMs } }),
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { committed: boolean }).committed).toBe(true);
}

/** The job's observable outcome, read via the real admin browse route (never a store peek). */
async function jobState(url: string): Promise<string | undefined> {
  const res = await fetch(`${url}/_admin/tables/${encodeURIComponent("scheduler/jobs")}/data`, {
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  });
  expect(res.status).toBe(200);
  const page = (await res.json()) as { documents: Array<{ fnPath?: string; state?: string }> };
  return page.documents.find((d) => d.fnPath === "jobs:work")?.state;
}

describe("wake seam — `serve --wake-url` through the real startServe", () => {
  it("a committed scheduled job arms the wake host with its own absolute instant", async () => {
    const wake = await wakeListener();
    cleanups.push(wake.close);
    const { server } = await serveFixture({ wakeUrl: wake.url });

    const before = Date.now();
    await scheduleJob(server.url, "x", JOB_DELAY_MS);

    // The arm IS the claim: on a host that stops the process there is no `setTimeout`, so an arm is
    // the only thing that can ever cause this job to run. Assert on the arm, not on dispatch.
    const due = before + JOB_DELAY_MS;
    await waitFor(() => wake.arms.some((a) => a !== null && Math.abs(a - due) < 1_000));

    // Absolute wall-clock instants, never delays — the property the whole seam rests on (a delay
    // would restart its countdown on every cold boot and defer a job forever). A plausible arm is
    // in the future and no further out than the scheduler's own 30s sweep backstop.
    for (const a of wake.arms) {
      if (a !== null) {
        expect(a).toBeGreaterThan(before);
        expect(a).toBeLessThanOrEqual(before + 31_000);
      }
    }
  });

  it("the host's alarm (POST /_admin/wake) is what dispatches the job — the full Cloudflare loop", async () => {
    const wake = await wakeListener();
    cleanups.push(wake.close);
    const { server } = await serveFixture({ wakeUrl: wake.url });

    const before = Date.now();
    await scheduleJob(server.url, "loop", JOB_DELAY_MS);
    await waitFor(() => wake.arms.some((a) => a !== null && Math.abs(a - (before + JOB_DELAY_MS)) < 1_000));

    // Under a wake host the runtime arms NO `setTimeout` (the host's single alarm is the sole firing
    // mechanism), so the job stays pending past its due instant no matter how long we wait. This is
    // the negative half that makes the positive half mean something.
    await new Promise((r) => setTimeout(r, JOB_DELAY_MS + 500));
    expect(await jobState(server.url)).not.toBe("success");

    // Now play the Durable Object: the alarm fires and calls back into the container. Supplying the
    // ALARM is legitimate (it is the host's job, and on Cloudflare this same request is also what
    // boots a stopped container); supplying an ARM would not be.
    const woke = await fetch(`${server.url}/_admin/wake`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(woke.status).toBe(200);

    await waitFor(async () => (await jobState(server.url)) === "success");
  });

  it("no --wake-url (every existing deployment) never touches a wake host", async () => {
    const wake = await wakeListener();
    cleanups.push(wake.close);

    // Boot WITHOUT `wakeUrl` — the default path. The listener exists only to prove nothing calls it,
    // and the job still dispatches on the plain `setTimeout` path, byte-for-byte as before the seam.
    const { server } = await serveFixture();
    await scheduleJob(server.url, "y", JOB_DELAY_MS);

    await waitFor(async () => (await jobState(server.url)) === "success", 8_000);
    expect(wake.arms).toEqual([]);
  });
});
