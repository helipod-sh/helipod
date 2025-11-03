/**
 * T5 — the public, typed `OptimisticLocalStore` (verdict §(b)). Wraps T4's internal, untyped
 * `OptimisticStoreView` (the raw read/write composed-state view `LayeredQueryStore.recompose`
 * threads through an updater) with the v1 API surface a `withOptimisticUpdate` closure actually
 * sees:
 *
 *  - **Typed `getQuery`/`setQuery`/`getAllQueries`** — `Q`'s declared `__args`/`__returns` (a
 *    codegen-generated `FunctionReference`) drive `args`/`value`'s types; the client's own untyped
 *    `{ __path }` ref or a raw string path fall back to `Record<string, Value>`/`Value` (see
 *    `RefArgs`/`RefReturn` below — the same fallback shape `api.ts`'s `AnyFunctionRef` bridges).
 *  - **`placeholderId(table)`** — deterministic per (entry, table, call-ordinal): replaying the
 *    SAME pending mutation (same `entry.seed`, verdict §(c) event 2d's rebuild) mints the SAME id
 *    sequence, while two calls to `placeholderId("messages")` within ONE updater invocation are
 *    ordinal-distinct, and two DIFFERENT entries (distinct `seed.entropy`) never collide. Built from
 *    `entry.seed.entropy` — NOT `crypto.randomUUID()` (verdict D11's replay-purity rule; Convex's
 *    own docs example is the footgun this API shape is designed to make structurally impossible to
 *    reach for).
 *  - **`now()`** — `entry.seed.now`, fixed at mutation creation, stable across every replay. NOT
 *    `Date.now()` (same D11 rule).
 *  - **dev-mode `Object.freeze`** on every value `getQuery`/`getAllQueries` hands back — Convex's
 *    documented "mutating the returned value in place will corrupt the client's internal state"
 *    footgun becomes an immediate `TypeError` in development (strict-mode ESM) instead of silent
 *    corruption. Gated on `process.env.NODE_ENV !== "production"` (no existing dev/prod convention
 *    was found in this package at T1 — this is the convention going forward) so a production build
 *    pays no freeze cost.
 */
import type { Value } from "@stackbase/values";
import type { AnyFunctionRef } from "./api";
import type { AnyFunctionReference } from "./function-types";
import type { OptimisticStoreView } from "./layered-store";

/** `Q`'s declared args if `Q` carries codegen's `__args`/`__returns`; else the untyped default —
 *  covers the client's own `{ __path }` ref and a raw string path (mirrors `api.ts`'s `AnyFunctionRef`). */
export type RefArgs<Q> = Q extends AnyFunctionReference<infer A, any> ? A : Record<string, Value>;

/** `Q`'s declared return type — same fallback rule as `RefArgs`. */
export type RefReturn<Q> = Q extends AnyFunctionReference<any, infer R> ? R : Value;

/** The typed store an optimistic updater receives (verdict §(b)'s v1 API surface, verbatim). */
export interface OptimisticLocalStore {
  getQuery<Q extends AnyFunctionRef>(ref: Q, args?: RefArgs<Q>): RefReturn<Q> | undefined;
  setQuery<Q extends AnyFunctionRef>(ref: Q, args: RefArgs<Q>, value: RefReturn<Q> | undefined): void;
  getAllQueries<Q extends AnyFunctionRef>(ref: Q): Array<{ args: RefArgs<Q>; value: RefReturn<Q> | undefined }>;
  /** Deterministic per (entry, table, call-ordinal) — see file doc. NOT `crypto.randomUUID()`. */
  placeholderId(table: string): string;
  /** Entry-creation time, stable across every replay. NOT `Date.now()`. */
  now(): number;
}

/** Reads `process.env.NODE_ENV` via `globalThis` (no ambient `process` type — this package's
 *  tsconfig disables Node's global types, and browser bundles may not define `process` at all). */
function isDevMode(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.NODE_ENV !== "production";
}

function freezeDev<T>(value: T): T {
  if (isDevMode() && value !== null && typeof value === "object") Object.freeze(value);
  return value;
}

/**
 * Builds the typed store for ONE updater invocation. The per-table ordinal counter is created
 * fresh here (a local `Map`, not carried on `seed`) — every call to this factory starts every
 * table's ordinal back at 0, which is exactly what makes replaying the same entry (same `seed`)
 * deterministic: the Nth `placeholderId("messages")` call within a run always gets the same id.
 */
export function createOptimisticLocalStore(
  view: OptimisticStoreView,
  seed: { entropy: string; now: number },
): OptimisticLocalStore {
  const ordinals = new Map<string, number>();
  return {
    getQuery: (ref, args) => freezeDev(view.getQuery(ref as unknown as string, args as Record<string, Value> | undefined) as any),
    setQuery: (ref, args, value) =>
      view.setQuery(ref as unknown as string, args as Record<string, Value>, value as Value | undefined),
    getAllQueries: (ref) =>
      view.getAllQueries(ref as unknown as string).map(({ args, value }) => ({
        args: args as any,
        value: freezeDev(value as any),
      })),
    placeholderId: (table) => {
      const n = ordinals.get(table) ?? 0;
      ordinals.set(table, n + 1);
      return `${seed.entropy}:${table}:${n}`;
    },
    now: () => seed.now,
  };
}
