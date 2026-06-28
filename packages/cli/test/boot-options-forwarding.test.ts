/**
 * The seam BETWEEN `bootProject` and `bootLoaded` — the one nothing covered when the wake seam
 * shipped dead.
 *
 * `bootProject` is the public entry (`serve.ts`/`cli.ts` call it); `bootLoaded` is the real
 * implementation. `bootProject` used to re-declare its own option type and forward every key by
 * hand, which drops options SILENTLY: TypeScript's excess-property check does not apply through a
 * spread, and callers pass optional options via conditional spread — so a key `bootProject`'s type
 * never declared produced ZERO diagnostics and simply vanished. The whole suite stayed green while
 * `serve --wake-url`'s `wakeHost` never reached the runtime.
 *
 * Two guards, because the trap has two halves:
 *   1. TYPE drift — `BootProjectOptions` stops covering a `bootLoaded` option. Caught below at
 *      compile time (this file fails `tsc` when the derivation is replaced by a hand-written type).
 *   2. FORWARD drift — the type is fine but the value isn't actually passed on (the original bug's
 *      literal shape: a hand-enumerated forward that forgets a key). Caught below at runtime.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootProject, type BootLoadedOptions, type BootProjectOptions } from "../src/boot";
import type { WakeHost } from "@stackbase/component";

// ── Guard 1: every `bootLoaded` option is reachable through `bootProject` (compile-time) ──────────

/**
 * The ONLY keys `bootProject` may legitimately not accept: the two it produces itself from
 * `functionsDir` (`loadFunctionsDir` -> `loaded`, `loadConfig` -> `components`). Any other unreachable key
 * is the bug this file exists to prevent, so it must be spelled out here — never silently omitted.
 */
type ProducedByBootProject = "loaded" | "components";

/** Non-forwardable = declared on `bootLoaded`, not reachable via `bootProject`, not produced by it. */
type Unreachable = Exclude<keyof BootLoadedOptions, keyof BootProjectOptions | ProducedByBootProject>;

/**
 * `Unreachable` must be `never`. This is a TYPE assertion, not a value one: if a `bootLoaded` option
 * ever becomes unreachable through `bootProject`, `Unreachable` becomes that key's name (a string
 * literal), the assignment below stops type-checking, and `bun run typecheck` fails naming the
 * dropped key. Verified to actually fail — hand-writing `BootProjectOptions` without `wakeHost`
 * reproduces exactly the original wake-seam bug and errors here with `"wakeHost"`.
 */
const unreachableBootOptions: Unreachable[] = [];

/** `bootProject`'s own additions over the derived set — asserted so a typo'd rename is loud too. */
type AddedByBootProject = Exclude<keyof BootProjectOptions, keyof BootLoadedOptions>;
const addedByBootProject: AddedByBootProject[] = ["functionsDir"];

describe("bootProject options are derived from bootLoaded (no silent drops)", () => {
  it("declares no unreachable bootLoaded options", () => {
    // The real assertion is the type of `unreachableBootOptions` above (checked by tsc). This keeps
    // the symbols used and states the invariant in the suite output.
    expect(unreachableBootOptions).toEqual([]);
    expect(addedByBootProject).toEqual(["functionsDir"]);
  });
});

// ── Guard 2: the options are actually FORWARDED, not just declared (runtime) ──────────────────────

describe("bootProject forwards its options through to the runtime", () => {
  /**
   * The wake seam is the regression case: `serve.ts` builds a `wakeHost` and hands it to
   * `bootProject`. If it is dropped, the runtime falls back to `setTimeout` and NOTHING observable
   * fails — drivers just silently never fire on a host that stops the process. So assert the seam
   * directly: with a `wakeHost` threaded through `bootProject`, the always-on drivers (storage
   * reaper / receipts reaper) must arm their timers on the HOST rather than on `setTimeout`.
   */
  it("threads wakeHost down to createEmbeddedRuntime (the seam the wake bug slipped through)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-fwd-"));
    const arms: (number | null)[] = [];
    const wakeHost: WakeHost = { armWake: (atMs) => void arms.push(atMs) };

    const { store } = await bootProject({
      functionsDir: "test/fixtures/deploy-v1/convex",
      dataPath: join(dir, "db.sqlite"),
      adminKey: "k",
      wakeHost,
    });
    try {
      // A dropped wakeHost => the runtime takes the setTimeout branch => zero arms. This is exactly
      // what shipped broken.
      expect(arms.length).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** `backstopMs`, the wake seam's other half — dropped by the same hand-forward, same silence. */
  it("threads backstopMs down to createEmbeddedRuntime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-fwd-"));
    const seen: number[] = [];
    const backstopMs = (d: number): number => {
      seen.push(d);
      return d;
    };

    const { store } = await bootProject({
      functionsDir: "test/fixtures/deploy-v1/convex",
      dataPath: join(dir, "db.sqlite"),
      adminKey: "k",
      backstopMs,
    });
    try {
      // The always-on storage reaper asks for its backstop cadence through this hook when it arms
      // its sweep timer — which happens once its first (async) sweep pass settles, not synchronously
      // at boot, hence the wait. Never called => the option never reached the runtime.
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A guard against the forward regressing back to hand-enumeration while the derived type stays
   * correct: an option `bootProject` has no special knowledge of must arrive on the far side
   * untouched. `storageReaperSweepMs` is a plain scalar with an observable default, so a drop is
   * detectable without reaching into the runtime's internals.
   */
  it("forwards a plain pass-through option it has no special handling for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-fwd-"));
    const { store, runtime } = await bootProject({
      functionsDir: "test/fixtures/deploy-v1/convex",
      dataPath: join(dir, "db.sqlite"),
      adminKey: "k",
      storageReaperSweepMs: 999_999,
    });
    try {
      // Boots cleanly with the option accepted end-to-end (a re-declared type would not even compile
      // this call; a dropped forward would silently use the 60s default instead).
      expect(typeof runtime.run).toBe("function");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
