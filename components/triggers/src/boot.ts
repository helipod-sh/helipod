import type { DriverContext } from "@stackbase/component";
import type { TriggersOpts } from "./driver";

/**
 * Boot-time work for `@stackbase/triggers`: handler-path validation (fail-fast) and cursor
 * initialization (tip or `fromStart`). Both are called from `driver.ts`'s `start()`, NOT wired as
 * a `ComponentDefinition.boot` step — despite the file name, matching the brief's file layout.
 * Here's why, spelled out so a future reader doesn't wonder:
 *
 * `ComponentDefinition.boot` runs with a `BootContext` (`packages/component/src/
 * define-component.ts`), which is exactly `{ db, now }` — a namespaced, non-user `db` and a
 * wall-clock reading. It has neither `readLog` (needed to peek the log's current tip for a new,
 * non-`fromStart` trigger — see `ensureCursor` below) nor `functionKind` (needed to validate a
 * configured `handler` path resolves to a real registered mutation/action — see
 * `validateHandlers` below). Both capabilities live ONLY on `DriverContext`
 * (`packages/component/src/define-component.ts`), which a component's `driver.start(ctx)` DOES
 * receive. Since `EmbeddedRuntime.create()` runs boot steps and THEN awaits every driver's
 * `start()` in a synchronous `for` loop before returning (`packages/runtime-embedded/src/
 * runtime.ts`), a validation error thrown from `start()` still fails the whole runtime
 * construction — "boot fails fast" holds end-to-end even though the check itself runs a beat
 * later than a literal `ComponentDefinition.boot` step would. Extending `BootContext` with
 * `readLog`/`functionKind` just to move this code into an actual boot step would be a needless
 * cross-package surface change for a purely cosmetic win — `driver.start()` already gives the
 * exact capabilities this needs.
 */

/** Internal-path convention check — mirrors `runtime-embedded/src/runtime.ts`'s private `isInternalPath` (not exported, so re-implemented here rather than reaching across a package boundary for a one-line predicate). A path is "internal" when some `:`-separated segment starts with `_` (e.g. `"notifications:_onMessage"`). */
function isInternalPath(path: string): boolean {
  return path.split(":").some((seg) => seg.startsWith("_"));
}

/**
 * Validates every configured trigger's `handler` path BEFORE the driver starts dispatching —
 * three fail-fast, instructive errors (design spec D2 / the error-handling table):
 *  1. the path isn't a registered function at all ("unknown handler path"),
 *  2. the path isn't internal — trigger handlers must not be directly client-callable, the same
 *     `internalMutation`/`internalAction` convention Convex uses ("non-internal"),
 *  3. the path resolves but isn't a mutation or action (e.g. a query — "wrong kind").
 *
 * Throws on the FIRST violation found (config iteration order) rather than collecting every
 * error — one bad handler is enough to refuse to start, and a single clear message beats a wall
 * of them.
 */
export function validateHandlers(ctx: DriverContext, opts: TriggersOpts): void {
  if (!ctx.functionKind) {
    throw new Error(
      "@stackbase/triggers: the runtime's DriverContext does not provide functionKind — handler validation " +
        "cannot run. This means the composed runtime is older than @stackbase/component's triggers support; " +
        "upgrade @stackbase/runtime-embedded.",
    );
  }
  for (const [table, cfg] of Object.entries(opts)) {
    const kind = ctx.functionKind(cfg.handler);
    if (kind === undefined) {
      throw new Error(
        `@stackbase/triggers: trigger "${table}" references handler "${cfg.handler}", which is not a registered ` +
          `function. Check the path matches an exported mutation or action (e.g. "notifications:_onMessage").`,
      );
    }
    if (!isInternalPath(cfg.handler)) {
      throw new Error(
        `@stackbase/triggers: trigger "${table}"'s handler "${cfg.handler}" must be an internal function — a ` +
          `module or function name segment prefixed with "_" (e.g. "notifications:_onMessage"). Trigger handlers ` +
          `are driven only by the trigger loop and must not be directly client-callable.`,
      );
    }
    if (kind !== "mutation" && kind !== "action") {
      throw new Error(
        `@stackbase/triggers: trigger "${table}"'s handler "${cfg.handler}" is a ${kind}, not a mutation or ` +
          `action. Trigger handlers must be an internal mutation or action.`,
      );
    }
  }
}

/**
 * Ensures a cursor row exists for `name`, creating one lazily on first-ever call if it doesn't:
 * `fromStart` seeds `cursorTs: 0` (replay every existing revision — see the design spec's D3
 * cost note); otherwise seeds at `tipIfNew` — the log's tip AS OF BEFORE this call, already
 * peeked by the caller (`driver.ts`'s `runPass`, via the `limit: 0` "peek the bound, don't scan"
 * idiom — `DriverContext.readLog`'s doc comment, `@stackbase/component`).
 *
 * `tipIfNew` is a CALLER-supplied value, not peeked again in here, on purpose: `runPass` peeks
 * its own `targetBound` (the ceiling this pass will drain up to) BEFORE calling this function, and
 * reuses that exact same peek here. If this function peeked independently, AFTER its own
 * `_initCursor` insert had already landed (a write, which bumps the log's tip by one), a fresh
 * peek taken at that point would see that very insert — creating a self-chasing loop where a
 * brand-new trigger's first pass perpetually discovers "one more" entry that is actually its OWN
 * housekeeping write. Reusing the caller's PRE-write peek value sidesteps this: `_initCursor`'s
 * own commit lands strictly AFTER `tipIfNew` was captured, so it can never be mistaken for part
 * of what this pass needs to catch up to.
 *
 * Called at the top of every pass (`driver.ts`), not cached after the first success: a resumed
 * trigger's `state` can flip back to `"running"` from an external `triggers:resume` call at any
 * time, and the driver must observe that on its next wake regardless of whether it already
 * initialized this cursor earlier in the process's lifetime.
 */
export async function ensureCursor(
  ctx: DriverContext,
  name: string,
  fromStart: boolean,
  tipIfNew: number,
): Promise<{ cursorTs: number; state: "running" | "paused" }> {
  const existing = (await ctx.runFunction("triggers:_getCursor", { name })) as
    | { cursorTs: number; state: "running" | "paused" }
    | null;
  if (existing) return existing;

  const cursorTs = fromStart ? 0 : tipIfNew;
  const created = (await ctx.runFunction("triggers:_initCursor", { name, cursorTs })) as {
    cursorTs: number;
    state: "running" | "paused";
  };
  return created;
}
