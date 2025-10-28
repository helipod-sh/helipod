import { defineSchema, defineTable, v } from "@stackbase/values";

/**
 * The `@stackbase/triggers` component schema (namespaced `triggers/*` when composed) — design
 * spec D2. One `cursors` row per configured trigger, keyed by the WATCHED TABLE NAME (`name`) —
 * see `../docs`/the design spec for why a table rename orphans the cursor rather than migrating
 * it.
 *
 * - `cursorTs`: the log coordinate this trigger has fully delivered through — see
 *   `DriverContext.readLog`'s doc comment (`@stackbase/component`) for why this is ALWAYS
 *   `maxScannedTs`, never a delivered change's own `ts`.
 * - `state`: `"running"` (the driver dispatches this trigger on every relevant wake) or
 *   `"paused"` (max-consecutive-failures or the circuit breaker tripped; the driver skips it
 *   entirely until `triggers:resume` flips it back).
 * - `failureCount`: consecutive handler failures since the last successful delivery (or since
 *   the trigger was created/resumed) — reset to 0 by `_advanceCursor` on every successful
 *   delivery/quiet-table advance. PERSISTED (restart-safe), unlike the backoff retry timer
 *   itself, which is in-memory only (see `driver.ts`'s module doc comment).
 * - `lastError` / `pausedReason`: operator-visible diagnostics; both cleared by `resume`.
 */
export const triggersSchema = defineSchema({
  cursors: defineTable({
    name: v.string(),
    cursorTs: v.number(),
    state: v.union(v.literal("running"), v.literal("paused")),
    failureCount: v.number(),
    lastError: v.optional(v.string()),
    pausedReason: v.optional(v.string()),
  }).index("by_name", ["name"]),
});
