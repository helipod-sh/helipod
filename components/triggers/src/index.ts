import { defineComponent, type ComponentDefinition } from "@helipod/component";
import { triggersSchema } from "./schema";
import { _initCursor, _getCursor, _advanceCursor, _recordFailure, _pause, resume, _status } from "./modules";
import { triggersDriver, type TriggersOpts } from "./driver";

export * from "./schema";
export type { TriggerConfig, TriggersOpts, TriggersDriver } from "./driver";
export { triggersDriver, DEFAULT_BATCH_SIZE, BYTE_BUDGET, DEFAULT_MAX_DELIVERIES_PER_WINDOW, BREAKER_WINDOW_MS, cutToByteBudget } from "./driver";
export type { CursorRow } from "./modules";
export { MAX_CONSECUTIVE_FAILURES } from "./modules";

/**
 * `defineTriggers(opts)` — the `@helipod/triggers` component: react to committed data changes
 * server-side, durably, without a queue — a trigger is a durable cursor over the MVCC log (the
 * design spec's core idea; see `docs/superpowers/specs/2025-10-16-onchange-triggers-design.md`).
 *
 * ```ts
 * // helipod.config.ts
 * import { defineTriggers } from "@helipod/triggers";
 * export default defineConfig({
 *   components: [
 *     defineTriggers({
 *       messages: { handler: "notifications:_onMessage" },       // an internalMutation/internalAction
 *       users: { handler: "audit:_onUserChange", fromStart: true },
 *     }),
 *   ],
 * });
 * ```
 *
 * Each key is a WATCHED TABLE NAME; `handler` is an internal (`_`-prefixed) mutation or action
 * receiving `{ changes: LogChange[] }` (`@helipod/component`'s `LogChange` — see its doc
 * comment for `op`/`oldDoc`/`changeId` semantics). No `context`/`contextType` — unlike
 * `@helipod/scheduler`, nothing calls a `ctx.triggers.*` facade from a mutation; the whole
 * surface is this declarative config plus the `triggers:resume` mutation
 * (`./modules.ts`) for un-pausing a tripped/failed trigger.
 *
 * Boot-time handler validation (unknown path / non-internal / wrong kind, all fail-fast) and
 * cursor initialization (tip, or `fromStart: true`'s ts-0 replay) both happen inside the driver's
 * `start()`, not a `ComponentDefinition.boot` step — see `./boot.ts`'s module doc comment for why
 * `BootContext` structurally can't do either.
 */
export function defineTriggers(opts: TriggersOpts): ComponentDefinition {
  return defineComponent({
    name: "triggers",
    schema: triggersSchema,
    modules: { _initCursor, _getCursor, _advanceCursor, _recordFailure, _pause, resume, _status },
    driver: triggersDriver(opts),
  });
}
