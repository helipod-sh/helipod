/**
 * The wake seam (`EmbeddedRuntimeOptions.wakeHost`/`backstopMs`): the runtime multiplexes every live
 * driver timer down to the ONE alarm a host offers, and fires them on demand via `fireDueTimers()`.
 *
 * Driven through the REAL `EmbeddedRuntime.create` + a capturing driver (the `read-log.test.ts`
 * harness shape), never a hand-built `DriverContext` — the whole point is what the shipped runtime's
 * own `setTimer`/`clearTimer` do, so faking those would test nothing. Only the host and the clock are
 * fakes.
 *
 * This also closes a real standing gap: nothing else proves a `setTimer` fires and does work. The
 * E2Es exercise only the reactive `onCommit` path (5-8s budgets vs 30-60s timers), so every
 * fixed-interval path was previously unit-tested solely via `__tick()`/`__wake()` seams against a
 * FAKE `DriverContext` — i.e. against a stand-in for the very code under test here.
 */
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents, type DriverContext, type WakeHost } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation } from "@stackbase/executor";

/** Records every `armWake` crossing the seam — the arms are the assertion in most tests below. */
function fakeWakeHost(): { host: WakeHost; arms: Array<number | null> } {
  const arms: Array<number | null> = [];
  return { host: { armWake: (atMs) => void arms.push(atMs) }, arms };
}

/**
 * Build a runtime over a fresh in-memory SQLite store, capturing the `DriverContext` its component
 * driver is started with. `now` is a settable fake so `fireDueTimers()`'s due-ness is deterministic;
 * omit `wakeHost` to exercise the DEFAULT (`setTimeout`) path with the real clock.
 */
async function harness(opts?: { wakeHost?: WakeHost; backstopMs?: (d: number) => number; now?: () => number }) {
  let ctx!: DriverContext;
  const driver = { name: "cap", start(c: DriverContext) { ctx = c; } };
  const schema = defineSchema({ messages: defineTable({ body: v.string() }) });
  const c = composeComponents(
    { schemaJson: schema.export(), moduleMap: { "app:noop": mutation(async () => null) } },
    [{ name: "sys", schema: defineSchema({ log: defineTable({ body: v.string() }) }), modules: {}, driver }],
  );
  const runtime = await EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: c.catalog, modules: c.moduleMap, componentNames: c.componentNames,
    contextProviders: c.contextProviders, policyRegistry: c.policyRegistry, policyProviders: c.policyProviders,
    relationRegistry: c.relationRegistry, bootSteps: c.bootSteps, drivers: c.drivers, tableNumbers: c.tableNumbers,
    ...(opts?.wakeHost ? { wakeHost: opts.wakeHost } : {}),
    ...(opts?.backstopMs ? { backstopMs: opts.backstopMs } : {}),
    ...(opts?.now ? { now: opts.now } : {}),
  });
  return { ctx, runtime };
}

/** A settable clock, so "due" is decided by the test rather than by wall time. */
function fakeClock(start: number): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (next) => void (t = next) };
}

const T0 = 1_000_000;

describe("EmbeddedRuntimeOptions.wakeHost", () => {
  it("multiplexes three timers down to ONE arm, at the minimum", async () => {
    const { host, arms } = fakeWakeHost();
    const clock = fakeClock(T0);
    const { ctx } = await harness({ wakeHost: host, now: clock.now });

    // Earliest first, then two later ones: a driver arming far-future timers must not thrash the
    // host's schedule — a host has exactly ONE alarm, and the earliest is all it can be.
    ctx.setTimer(T0 + 1_000, () => {});
    ctx.setTimer(T0 + 2_000, () => {});
    ctx.setTimer(T0 + 3_000, () => {});

    expect(arms).toEqual([T0 + 1_000]);
  });

  it("re-arms when a LATER timer becomes the minimum by arriving first, but never for a later one", async () => {
    const { host, arms } = fakeWakeHost();
    const clock = fakeClock(T0);
    const { ctx } = await harness({ wakeHost: host, now: clock.now });

    ctx.setTimer(T0 + 3_000, () => {}); // nothing armed → arms
    ctx.setTimer(T0 + 1_000, () => {}); // moves the minimum → re-arms
    ctx.setTimer(T0 + 2_000, () => {}); // behind the minimum → silent

    expect(arms).toEqual([T0 + 3_000, T0 + 1_000]);
  });

  it("re-arms to the next timer when the minimum is cleared, and to null when the last one is", async () => {
    const { host, arms } = fakeWakeHost();
    const clock = fakeClock(T0);
    const { ctx } = await harness({ wakeHost: host, now: clock.now });

    const first = ctx.setTimer(T0 + 1_000, () => {});
    const second = ctx.setTimer(T0 + 2_000, () => {});
    expect(arms).toEqual([T0 + 1_000]);

    ctx.clearTimer(first);
    expect(arms).toEqual([T0 + 1_000, T0 + 2_000]);

    ctx.clearTimer(second);
    expect(arms).toEqual([T0 + 1_000, T0 + 2_000, null]);

    // An unknown/stale handle changes nothing — no timer left the map, so the minimum didn't move.
    ctx.clearTimer(first);
    expect(arms).toHaveLength(3);
  });

  it("fireDueTimers() runs ONLY the due timers, drops them, and re-arms to the remainder", async () => {
    const { host, arms } = fakeWakeHost();
    const clock = fakeClock(T0);
    const { ctx, runtime } = await harness({ wakeHost: host, now: clock.now });
    const fired: string[] = [];

    ctx.setTimer(T0 + 1_000, () => fired.push("a"));
    ctx.setTimer(T0 + 2_000, () => fired.push("b"));
    ctx.setTimer(T0 + 3_000, () => fired.push("c"));
    expect(arms).toEqual([T0 + 1_000]);

    // The host's alarm goes off at the minimum — `b` is due too (same instant), `c` is not.
    clock.set(T0 + 2_000);
    runtime.fireDueTimers();

    expect(fired).toEqual(["a", "b"]);
    expect(arms).toEqual([T0 + 1_000, T0 + 3_000]);

    // Fired timers are gone: a second wake at the same instant repeats nothing.
    runtime.fireDueTimers();
    expect(fired).toEqual(["a", "b"]);
  });

  it("re-arms the unchanged minimum on a wake that finds nothing due (the alarm was consumed)", async () => {
    const { host, arms } = fakeWakeHost();
    const clock = fakeClock(T0);
    const { ctx, runtime } = await harness({ wakeHost: host, now: clock.now });
    ctx.setTimer(T0 + 5_000, () => {});
    expect(arms).toEqual([T0 + 5_000]);

    // An early/stale wake: a fired alarm doesn't re-arm itself, so the minimum must be re-pushed —
    // otherwise this wake would silently swallow the only pending one.
    runtime.fireDueTimers();
    expect(arms).toEqual([T0 + 5_000, T0 + 5_000]);
  });

  it("a throwing callback can't strand the later due timers or the re-arm", async () => {
    const { host, arms } = fakeWakeHost();
    const clock = fakeClock(T0);
    const { ctx, runtime } = await harness({ wakeHost: host, now: clock.now });
    const fired: string[] = [];

    ctx.setTimer(T0 + 1_000, () => {
      throw new Error("boom");
    });
    ctx.setTimer(T0 + 1_000, () => fired.push("survivor"));
    ctx.setTimer(T0 + 9_000, () => {});

    clock.set(T0 + 1_000);
    expect(() => runtime.fireDueTimers()).not.toThrow();

    // The later due callback still ran, and the host still got re-armed — a throw here would
    // otherwise leave NO alarm pending at all (the seam's silent-death case).
    expect(fired).toEqual(["survivor"]);
    expect(arms).toEqual([T0 + 1_000, T0 + 9_000]);
  });

  it("a callback's own re-arm (the backstop-driver shape) leaves exactly one pending wake", async () => {
    const { host, arms } = fakeWakeHost();
    const clock = fakeClock(T0);
    const { ctx, runtime } = await harness({ wakeHost: host, now: clock.now });
    let passes = 0;

    // What every backstop driver does: fire, then arm the next one from inside the callback.
    const arm = (): void => {
      ctx.setTimer(ctx.now() + 1_000, () => {
        passes++;
        arm();
      });
    };
    arm();
    expect(arms).toEqual([T0 + 1_000]);

    clock.set(T0 + 1_000);
    runtime.fireDueTimers();
    expect(passes).toBe(1);
    // The callback's fresh timer must NOT be swept by the pass that fired it, and the re-arm it
    // triggered must be the only one — not doubled by the end-of-pass re-arm.
    expect(arms).toEqual([T0 + 1_000, T0 + 2_000]);
  });
});

describe("EmbeddedRuntimeOptions.wakeHost — unset (the default: every existing deployment)", () => {
  it("fires a timer through the real setTimeout path", async () => {
    // Real clock, no fake: the default path hands `atMs - now()` to `setTimeout`, so a fake clock
    // would decouple the delay from wall time. ("armWake is never called" needs no assertion here —
    // no host object exists to call.)
    const { ctx, runtime } = await harness();
    let fired = false;
    const done = new Promise<void>((resolve) => {
      ctx.setTimer(Date.now() + 5, () => {
        fired = true;
        resolve();
      });
    });

    await done;
    expect(fired).toBe(true);

    // A fired timer is dropped, so `/_admin/wake` (registered on every deployment, host or not) can
    // only ever be a no-op here — it never re-runs work the `setTimeout` path already did.
    runtime.fireDueTimers();
    expect(fired).toBe(true);
  });

  it("clearTimer stops a pending timer from ever firing", async () => {
    const { ctx } = await harness();
    let fired = false;
    const h = ctx.setTimer(Date.now() + 5, () => void (fired = true));
    ctx.clearTimer(h);
    await new Promise((r) => setTimeout(r, 25));
    expect(fired).toBe(false);
  });
});

describe("DriverContext.backstopMs", () => {
  it("defaults to identity — a driver's declared cadence is its cadence", async () => {
    const { ctx } = await harness();
    expect(ctx.backstopMs(30_000)).toBe(30_000);
    expect(ctx.backstopMs(60_000)).toBe(60_000);
  });

  it("is answered by the host's policy when one is configured", async () => {
    // The Cloudflare shape: floor every backstop at 15min, so an idle app isn't cold-started every 30s.
    const { ctx } = await harness({ backstopMs: (d) => Math.max(d, 900_000) });
    expect(ctx.backstopMs(30_000)).toBe(900_000);
    expect(ctx.backstopMs(3_600_000)).toBe(3_600_000);
  });
});
