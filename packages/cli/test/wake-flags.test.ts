/**
 * The wake seam's CLI surface: `serve --wake-url` / `--backstop-min-ms` (each flag-or-env, flag
 * wins), and the `POST /_admin/wake` route that fires the due timers when the host's alarm goes off.
 * Pure parser + pure route handler — no spawned process. The multiplexing itself is proven in
 * `packages/runtime-embedded/test/wake-host.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { resolveServeOptions } from "../src/serve";
import { handleHttpRequest } from "../src/http-handler";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import type { AdminApi } from "@stackbase/admin";

const ENV_KEYS = ["STACKBASE_WAKE_URL", "STACKBASE_BACKSTOP_MIN_MS"] as const;

describe("resolveServeOptions — wake seam flags", () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
      delete saved[k];
    }
  });
  function stash(k: (typeof ENV_KEYS)[number], v: string | undefined): void {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  it("both unset → no wake host, no backstop floor (every existing deployment)", () => {
    for (const k of ENV_KEYS) stash(k, undefined);
    const opts = resolveServeOptions([]);
    expect(opts.wakeUrl).toBeUndefined();
    expect(opts.backstopMinMs).toBeUndefined();
  });

  it("reads both from env", () => {
    stash("STACKBASE_WAKE_URL", "http://wake.do/arm");
    stash("STACKBASE_BACKSTOP_MIN_MS", "900000");
    const opts = resolveServeOptions([]);
    expect(opts.wakeUrl).toBe("http://wake.do/arm");
    expect(opts.backstopMinMs).toBe(900_000);
  });

  it("the flag wins over env (mirroring --object-store)", () => {
    stash("STACKBASE_WAKE_URL", "http://env.example/arm");
    stash("STACKBASE_BACKSTOP_MIN_MS", "1000");
    const opts = resolveServeOptions(["--wake-url", "http://flag.example/arm", "--backstop-min-ms", "900000"]);
    expect(opts.wakeUrl).toBe("http://flag.example/arm");
    expect(opts.backstopMinMs).toBe(900_000);
  });

  it("ignores a non-positive/garbage backstop floor rather than booting with a broken cadence", () => {
    for (const k of ENV_KEYS) stash(k, undefined);
    expect(resolveServeOptions(["--backstop-min-ms", "0"]).backstopMinMs).toBeUndefined();
    expect(resolveServeOptions(["--backstop-min-ms", "-5"]).backstopMinMs).toBeUndefined();
    expect(resolveServeOptions(["--backstop-min-ms", "abc"]).backstopMinMs).toBeUndefined();
  });
});

describe("POST /_admin/wake", () => {
  /** Only `fireDueTimers` is ever reached on this route — the rest of the runtime is irrelevant. */
  function fakeRuntime(): { runtime: EmbeddedRuntime; fires: () => number } {
    let n = 0;
    return { runtime: { fireDueTimers: () => void n++ } as unknown as EmbeddedRuntime, fires: () => n };
  }
  const admin = { api: {} as AdminApi, key: "sekret" };
  const info = { functions: [], tables: [] };

  it("fires the due timers on a correct admin key", async () => {
    const { runtime, fires } = fakeRuntime();
    const res = await handleHttpRequest(
      runtime,
      { method: "POST", path: "/_admin/wake", authorization: "Bearer sekret" },
      info,
      admin,
    );
    expect(res.status).toBe(200);
    expect(fires()).toBe(1);
  });

  it("401s on a wrong key WITHOUT firing anything (it drives privileged driver work)", async () => {
    const { runtime, fires } = fakeRuntime();
    const res = await handleHttpRequest(
      runtime,
      { method: "POST", path: "/_admin/wake", authorization: "Bearer wrong" },
      info,
      admin,
    );
    expect(res.status).toBe(401);
    expect(fires()).toBe(0);
  });

  it("401s with no authorization header at all", async () => {
    const { runtime, fires } = fakeRuntime();
    const res = await handleHttpRequest(runtime, { method: "POST", path: "/_admin/wake" }, info, admin);
    expect(res.status).toBe(401);
    expect(fires()).toBe(0);
  });

  it("does not fire on a GET (the wake is a POST, like every other admin write route)", async () => {
    const { runtime, fires } = fakeRuntime();
    await handleHttpRequest(
      runtime,
      { method: "GET", path: "/_admin/wake", authorization: "Bearer sekret" },
      info,
      admin,
    );
    expect(fires()).toBe(0);
  });
});
