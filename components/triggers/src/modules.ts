import { query, mutation } from "@stackbase/executor";
import type { QueryCtx, MutationCtx } from "@stackbase/executor";
import { computeBackoff } from "@stackbase/scheduler";

/**
 * Internal modules for `@stackbase/triggers` — registered on `defineTriggers()`'s `modules` map
 * (reachable as `triggers:_initCursor` / `triggers:_getCursor` / etc.), consumed by the driver
 * loop (`./driver.ts`) via `DriverContext.runFunction`, which dispatches privileged
 * (`runtime-embedded/src/runtime.ts`'s `driverCtx.runFunction` sets `privileged: true`) —
 * privileged calls bypass namespace prefixing, so these modules use the fully-qualified table
 * name `"triggers/cursors"` (mirrors `@stackbase/scheduler`'s `./modules.ts` module doc comment).
 *
 * `resume` is deliberately NOT `_`-prefixed (unlike every other module here): it's meant to be an
 * ordinary callable mutation an operator/the dashboard's function runner invokes directly
 * (`triggers:resume`, per the design spec) — see `defineTriggers`'s doc comment in `./index.ts`.
 */

/** After this many CONSECUTIVE handler failures, a trigger pauses itself (design spec D2). */
export const MAX_CONSECUTIVE_FAILURES = 8;

/** Drop `undefined`-valued keys before a `db.replace` (the wire codec rejects `undefined`). Mirrors `@stackbase/scheduler`'s `compact` (duplicated per that package's own established convention — see its `modules.ts`/`facade.ts`). */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

export interface CursorRow {
  _id: string;
  name: string;
  cursorTs: number;
  state: "running" | "paused";
  failureCount: number;
  lastError?: string;
  pausedReason?: string;
}

/** `triggers:_getCursor` — a QUERY: the cursor row for `name`, or `null` if never initialized. */
export const _getCursor = query(async (ctx: QueryCtx, args: { name: string }): Promise<CursorRow | null> => {
  const rows = await ctx.db.query("triggers/cursors", "by_name").eq("name", args.name).take(1).collect();
  return (rows[0] as unknown as CursorRow) ?? null;
});

/** `triggers:_status` — a QUERY: every trigger's cursor row (dashboard/operator introspection). */
export const _status = query(async (ctx: QueryCtx): Promise<CursorRow[]> => {
  const rows = await ctx.db.query("triggers/cursors", "by_creation").collect();
  return rows as unknown as CursorRow[];
});

/**
 * `triggers:_initCursor` — a MUTATION: insert-or-return-existing, so a driver's lazy
 * first-tick-for-this-trigger init (`./boot.ts`'s `ensureCursor`) is safe to call every time a
 * cursor row might not exist yet without a separate existence check racing the insert — the
 * single-writer OCC transactor serializes this mutation, so "read, then conditionally insert" is
 * atomic. `cursorTs` is the caller's already-computed starting point (`0` for `fromStart`, or the
 * log's current tip peeked via `readLog({ limit: 0 })` — see `./boot.ts`); this mutation has no
 * way to compute it itself (a mutation has no `readLog`).
 */
export const _initCursor = mutation(async (ctx: MutationCtx, args: { name: string; cursorTs: number }): Promise<CursorRow> => {
  const existing = await ctx.db.query("triggers/cursors", "by_name").eq("name", args.name).take(1).collect();
  if (existing[0]) return existing[0] as unknown as CursorRow;
  const id = await ctx.db.insert("triggers/cursors", {
    name: args.name,
    cursorTs: args.cursorTs,
    state: "running",
    failureCount: 0,
  });
  return { _id: id as unknown as string, name: args.name, cursorTs: args.cursorTs, state: "running", failureCount: 0 };
});

/**
 * `triggers:_advanceCursor` — a MUTATION: moves `cursorTs` forward to `newCursorTs` (a delivered
 * batch's advance point, or a quiet-table's `maxScannedTs`) and clears the failure streak
 * (`failureCount: 0`, `lastError` cleared) — every call site only ever advances after a
 * CONFIRMED-clean state (a successful handler run, or no matches at all), so a reset here is
 * always correct, not just convenient.
 *
 * OCC-guarded by `expectedPrev` (the workflow `generationNumber` pattern, per the design spec): a
 * stale driver instance that's still mid-pass after its runtime stopped being the default-shard
 * holder (a fleet default-shard move — see `Driver.stop`/the driver lifecycle) must not
 * double-advance a cursor a NEWER driver instance already moved past. If `cursorTs !==
 * expectedPrev`, this no-ops — the stale caller's advance is silently dropped rather than
 * corrupting the newer instance's progress. (`_recordFailure`/`_pause`/`resume` below are NOT
 * OCC-guarded this way: over-counting a failure or double-pausing from a stale instance is merely
 * over-cautious, never a missed/duplicated delivery — only cursor advancement can silently skip
 * changes, so only it needs the guard.)
 */
export const _advanceCursor = mutation(
  async (ctx: MutationCtx, args: { name: string; newCursorTs: number; expectedPrev: number }): Promise<null> => {
    const rows = await ctx.db.query("triggers/cursors", "by_name").eq("name", args.name).take(1).collect();
    const row = rows[0];
    if (!row) return null; // shouldn't happen — the cursor is always initialized before this is called
    if ((row.cursorTs as number) !== args.expectedPrev) return null; // stale driver instance — no-op
    await ctx.db.replace(
      row._id as string,
      compact({ ...row, cursorTs: args.newCursorTs, failureCount: 0, lastError: undefined }),
    );
    return null;
  },
);

/**
 * `triggers:_recordFailure` — a MUTATION: increments `failureCount`, records `lastError`, and
 * either computes the next retry's backoff delay or — at `MAX_CONSECUTIVE_FAILURES` — pauses the
 * trigger (`pausedReason: "max-failures"`). The retry delay itself is NOT persisted (the driver's
 * backoff timer is in-memory — see `driver.ts`'s module doc comment: a restart retries
 * immediately, an accepted gap per the design spec); only the fact that a failure happened, and
 * how many in a row, survives a restart.
 *
 * Uses `ctx.random` (the mutation's own seeded PRNG) for `computeBackoff`'s jitter — the same
 * determinism-for-OCC-replay property `@stackbase/scheduler`'s `_complete` relies on (see
 * `computeBackoff`'s doc comment, `@stackbase/scheduler`): a replay of this exact mutation call
 * computes the exact same delay.
 */
export const _recordFailure = mutation(
  async (ctx: MutationCtx, args: { name: string; error: string }): Promise<{ paused: boolean; retryDelayMs: number }> => {
    const rows = await ctx.db.query("triggers/cursors", "by_name").eq("name", args.name).take(1).collect();
    const row = rows[0];
    if (!row) return { paused: false, retryDelayMs: 0 }; // shouldn't happen — defensive, mirrors _advanceCursor
    const failureCount = (row.failureCount as number) + 1;

    if (failureCount >= MAX_CONSECUTIVE_FAILURES) {
      await ctx.db.replace(
        row._id as string,
        compact({ ...row, failureCount, lastError: args.error, state: "paused", pausedReason: "max-failures" }),
      );
      return { paused: true, retryDelayMs: 0 };
    }

    await ctx.db.replace(row._id as string, compact({ ...row, failureCount, lastError: args.error }));
    return { paused: false, retryDelayMs: computeBackoff(failureCount, ctx.random) };
  },
);

/**
 * `triggers:_pause` — a MUTATION: the circuit breaker's write path (`./driver.ts`) — pauses a
 * trigger with an explicit `reason` (`"circuit-breaker"`) without touching `failureCount`/
 * `lastError` (unlike `_recordFailure`'s max-failures pause, a breaker trip isn't a handler
 * failure — the handler may have been succeeding every time, just too often). No-ops if already
 * paused (idempotent — a second trip, or a race with `_recordFailure`'s own pause, doesn't
 * clobber whichever `pausedReason` got there first).
 */
export const _pause = mutation(async (ctx: MutationCtx, args: { name: string; reason: string }): Promise<null> => {
  const rows = await ctx.db.query("triggers/cursors", "by_name").eq("name", args.name).take(1).collect();
  const row = rows[0];
  if (!row || row.state === "paused") return null;
  await ctx.db.replace(row._id as string, compact({ ...row, state: "paused", pausedReason: args.reason }));
  return null;
});

/**
 * `triggers:resume` — a MUTATION, NOT `_`-prefixed (see this file's module doc comment): flips a
 * paused trigger back to `"running"` and clears its failure/pause diagnostics, so it starts its
 * failure streak and breaker window fresh. No-ops if the trigger doesn't exist. Callable from the
 * dashboard's function runner (or directly by an app/operator) per the design spec — via the
 * ORDINARY `runtime.run()`/`/api/run` path (same as any other client-callable mutation), NOT the
 * driver's privileged `DriverContext.runFunction` path. That matters here: unlike every OTHER
 * module in this file (driver-only, dispatched privileged, and so using the fully-qualified
 * `"triggers/cursors"` table name — see this file's module doc comment), a namespaced call runs
 * with `ctx.db` auto-prefixing BARE table names to this component's own namespace — so this one
 * function uses the bare `"cursors"`, not `"triggers/cursors"` (which a namespaced call can't
 * resolve: namespace prefixing only applies to names that AREN'T already `/`-qualified).
 */
export const resume = mutation(async (ctx: MutationCtx, args: { name: string }): Promise<null> => {
  const rows = await ctx.db.query("cursors", "by_name").eq("name", args.name).take(1).collect();
  const row = rows[0];
  if (!row) return null;
  await ctx.db.replace(
    row._id as string,
    compact({ ...row, state: "running", failureCount: 0, lastError: undefined, pausedReason: undefined }),
  );
  return null;
});
