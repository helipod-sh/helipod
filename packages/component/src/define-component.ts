import type { SchemaDefinition, Validator, JSONValue } from "@stackbase/values";
import type { RegisteredFunction, TablePolicy, PolicyContextProvider, GuestDatabaseWriter, ActionApi } from "@stackbase/executor";
import type { ComponentContext } from "@stackbase/executor";
import type { SerializedKeyRange } from "@stackbase/index-key-codec";

export interface BootContext { db: GuestDatabaseWriter; now: number }

/**
 * One observed change in the MVCC log, as surfaced by `DriverContext.readLog` (the change-feed seam
 * `@stackbase/triggers` consumes). `op` is derived from the log entry: `value === null` → `"delete"`,
 * else `prev_ts === null` → `"insert"`, else `"update"`. `oldDoc` is the previous revision reached
 * through the `prev_ts` chain (`null` for an insert, and — the documented edge — `null` for an
 * `"update"` whose `prev_ts` points at a tombstone, i.e. a delete→re-insert reusing the id).
 * `changeId` is the change's immutable log coordinate `"<table>:<id>:<ts>"`, stable across
 * redelivery — a consumer dedups on it.
 */
export interface LogChange {
  /** App-visible table name (component-namespaced and app-root system tables are never surfaced). */
  table: string;
  /** The document's public id string. */
  id: string;
  op: "insert" | "update" | "delete";
  /** The revision's value as JSON (`null` for a delete). */
  newDoc: JSONValue | null;
  /** The prior revision's value as JSON (`null` for an insert or a tombstone-prev update). */
  oldDoc: JSONValue | null;
  /** The commit timestamp of this revision (safe below 2^53 — the driver seam's number convention). */
  ts: number;
  /** Immutable log coordinate `"<table>:<id>:<ts>"` — stable across redelivery. */
  changeId: string;
}

/**
 * A host's ability to wake the process at a wall-clock instant. The runtime multiplexes ALL driver
 * timers down to ONE pending wake, so a host implements exactly one alarm — which is all a Durable
 * Object has.
 *
 * Absolute, never a delay: a delay forces the runtime to compute `T - now()` and the host to add it
 * back, across two clocks that disagree (a hibernating host's process clock may have skipped hours),
 * and it would restart the countdown on every cold boot — so repeated sleeps could defer a job
 * forever. An absolute instant keeps one source of truth, and a timer armed by yesterday's process
 * is correctly already-overdue when today's process re-peeks.
 */
export interface WakeHost {
  /** Arm a single wake at absolute `atMs`, replacing any prior. `null` = nothing pending. */
  armWake(atMs: number | null): void;
}

/** The capabilities a `Driver` gets to wake on commits/timers and act outside a request. */
export interface DriverContext {
  /** Runs a registered fn privileged + namespaced, outside a request. */
  runFunction(path: string, args: JSONValue): Promise<unknown>;
  /** Taps the commit fan-out (every committed write, across the whole runtime). Returns an unsubscribe. */
  onCommit(cb: (inv: { tables: string[]; ranges: readonly SerializedKeyRange[]; commitTs: number }) => void): () => void;
  /** Arms a wake at wall-clock `atMs`; returns a handle for `clearTimer`. */
  setTimer(atMs: number, cb: () => void): number;
  clearTimer(handle: number): void;
  now(): number;
  /**
   * Cadence for a PURE BACKSTOP poll (not a next-work wake). A long-lived host returns `defaultMs`
   * unchanged; a host where every wake costs a cold start may stretch it. The CALL SITE is the tag:
   * calling this is how a driver declares "this timer is a backstop, not real work".
   */
  backstopMs(defaultMs: number): number;
  /**
   * Read committed changes from the MVCC log after `afterTs`, in ascending ts order — the durable
   * change feed (`@stackbase/triggers`). `limit` bounds the number of SCANNED revisions (not matched
   * ones), so a quiet watched table on a busy log still makes cursor progress; `tables` filters the
   * returned `changes` to those app tables by name (unset → every app table).
   *
   * `maxScannedTs` is how far the scan definitively reached (only past fully-scanned timestamps) —
   * ADVANCE THE CURSOR TO THIS, not to the last change's ts, so scanned-but-unmatched ranges are not
   * rescanned forever. The scan's upper bound is the stable log prefix (in a fleet, `min(frontier_ts)`;
   * otherwise the max committed ts), so a change above an in-flight gap is never surfaced or skipped.
   *
   * `limit: 0` — a deliberate, documented escape hatch: "peek the current stable bound without
   * scanning anything." Returns `{ changes: [], maxScannedTs: <the bound> }` at O(1) cost (no
   * `load_documents` scan at all). This is how `@stackbase/triggers` seeds a NEW (non-`fromStart`)
   * trigger's cursor at the log's current tip cheaply, instead of paying for a scan just to discover
   * where "now" is — see `@stackbase/triggers`' `src/boot.ts`.
   */
  readLog(opts: { afterTs: number; tables?: string[]; limit?: number }): Promise<{
    changes: LogChange[];
    maxScannedTs: number;
  }>;
  /**
   * Resolves a registered path's real kind (`"query"`/`"mutation"`/`"action"`/`"httpAction"`), or
   * `undefined` if the path isn't registered at all — the same resolver `ComponentContext.
   * functionKind` exposes to an in-transaction facade (see its doc comment in
   * `packages/executor/src/executor.ts`), threaded onto `DriverContext` too so a driver's own
   * startup can validate a config-supplied function path (e.g. `@stackbase/triggers`' `handler`
   * option) BEFORE ever calling it — "unknown path" vs "wrong kind" are both fail-fast, instructive
   * errors at driver start, not a confusing runtime crash on the first commit.
   *
   * Optional (not every `DriverContext` implementation/test fake provides it) — a driver that
   * doesn't need path validation (e.g. `@stackbase/scheduler`'s, which dispatches whatever `fnPath`
   * a `jobs` row already carries) can ignore it entirely; existing drivers/fakes are unaffected.
   */
  functionKind?(path: string): "query" | "mutation" | "action" | "httpAction" | undefined;
  /**
   * M2c: re-run/re-push every live subscription whose read set intersects `inv` — table-level
   * invalidation only (`ranges: []`), the shape a GLOBAL (D1-backed) table's change signal takes
   * (a `.global()` write leaves no local MVCC range to intersect; see
   * `@stackbase/runtime-cloudflare`'s `GlobalReactivityPoller`). Delegates to
   * `SyncProtocolHandler.notifyWrites`, already in scope wherever `DriverContext` is built.
   * Optional (not every `DriverContext` implementation/test fake provides it) — a driver that
   * writes through the normal `runFunction`/transaction path instead (nearly all of them) never
   * needs to invalidate a subscription directly and can ignore this entirely.
   */
  notifyWrites?(inv: { tables: string[]; ranges: readonly SerializedKeyRange[]; commitTs: number }): Promise<void>;
  /**
   * M2c: global (D1-backed) table names with at least one live subscriber right now — the only
   * thing a `GlobalReactivityPoller` needs to decide which tables are worth polling D1 for.
   * Delegates to `SubscriptionManager.subscribedGlobalTables()` (via `SyncProtocolHandler`).
   * Optional, same reasoning as `notifyWrites` above.
   */
  subscribedGlobalTables?(): string[];
}

/** A recurring runtime seam: started once after boot, woken by commits and/or timers. */
export interface Driver {
  name: string;
  start(ctx: DriverContext): void | Promise<void>;
  stop?(): void | Promise<void>;
}

/**
 * A reserved engine HTTP route a component contributes (Task A3-1): `{ method, pathPrefix }` mounted
 * by the boot core at a reserved `/api/…` or `/_…` path (an app `http.ts` may not register these —
 * the reserved-path guard rejects them), dispatching to `handler`, a bare httpAction module name in
 * THIS component's `modules`. Collected by `composeComponents` (parallel to `drivers`) and bound to
 * `runtime.runHttpAction` by the boot core — the generic form of how the always-on storage routes
 * mount, for opt-in composed components. Matched by exact-prefix, in declaration order, ahead of user
 * routes — overlapping prefixes across components (one a prefix of another, for the same method) are
 * REJECTED at `composeComponents` time (see `assertValidComponentRoutePrefix`'s caller there), so
 * first-match-by-order can never be ambiguous. The handler parses any sub-path (`<provider>/<phase>`)
 * itself, as this repo's routes carry no named params (see `@stackbase/executor`'s `matchRoute`, and
 * storage's `handleServe`).
 */
export interface ComponentHttpRoute {
  method: string;
  pathPrefix: string;
  /** Bare httpAction module name within this component's `modules` (namespaced at compose time). */
  handler: string;
}

export interface ComponentDefinition {
  name: string;
  schema: SchemaDefinition;
  modules: Record<string, RegisteredFunction>;
  config?: Validator<unknown>;
  requires?: string[];
  grants?: Record<string, { read?: string[]; write?: string[] }>;
  /** Optional facade contributed to every function's ctx as ctx[name]. Runs in this component's namespace. */
  context?: (cctx: ComponentContext) => object;
  /** The TS type this component contributes to ctx, for codegen: ctx[name]: import(import).type. */
  contextType?: { import: string; type: string };
  /**
   * Optional: the ACTION-mode counterpart to `context` — attached as `ctx[name]` inside an action
   * instead of `context`'s in-txn facade (an action has no `db`). Must expose the SAME method
   * signatures as `context`'s facade so a function body is portable between a mutation and an
   * action — implemented by delegating to `api.runMutation`/`api.runQuery` of this component's own
   * (typically `_`-prefixed) modules. See `ContextProvider.buildAction` in `@stackbase/executor`.
   */
  buildAction?: (api: ActionApi) => object;
  /**
   * Extra named values this component wants codegen to re-export from `_generated/server.ts`,
   * sourced from `contextType.import` — e.g. `@stackbase/scheduler` sets `["cronJobs"]` so an
   * app's `crons.ts` can do `import { cronJobs } from "./_generated/server"` unchanged. Requires
   * `contextType` (the import path is shared with it).
   */
  serverExports?: string[];
  /**
   * Opt-in: when true, `context`'s facade gets a writable `cctx.db` during mutation calls (still
   * read-only during queries), so the facade can write inside the calling mutation's transaction.
   * Defaults to false (most facades, e.g. authz, are read-only by design).
   */
  contextWrite?: boolean;
  /** Row policies this component declares for app tables: table → { read?, write? }. */
  policies?: Record<string, TablePolicy>;
  /** Contributes fields to every row policy's rule-context (e.g. authz → `{ auth }`). */
  policyContext?: PolicyContextProvider["build"];
  /** A once-per-process startup step (migrations/index rebuilds). Runs namespaced + non-user. */
  boot?: (ctx: BootContext) => Promise<void>;
  /** A recurring driver, started once after boot; woken by commits and/or timers. */
  driver?: Driver;
  /** Reserved engine HTTP routes this component contributes — see `ComponentHttpRoute`. */
  httpRoutes?: ComponentHttpRoute[];
}

/**
 * Engine-owned paths no component `httpRoute` may shadow. Checked BIDIRECTIONALLY by
 * `assertValidComponentRoutePrefix` below: a component prefix that EQUALS, is MORE SPECIFIC than
 * (`r.startsWith(p)`), OR is an ANCESTOR of (`p.startsWith(r)`) any entry here is rejected. The
 * ancestor direction is the one that matters most — without it, a component declaring `pathPrefix:
 * "/api/"` or `"/_"` would pass this list (neither string equals nor is a substring-prefix of an
 * entry in the naive one-directional sense) yet would swallow every reserved route beneath it at
 * dispatch time, since `matchComponentRoute` in `packages/cli/src/server.ts` runs BEFORE the core
 * `/api/run`, `/_admin/*`, etc. handlers — a silent, no-boot-error shadow of the whole engine API.
 */
export const RESERVED_ENGINE_PREFIXES = ["/api/run", "/api/health", "/api/sync", "/api/storage/", "/_admin/", "/_fleet/", "/_dashboard"];

/** Non-empty path segments, e.g. `"/api/auth/oauth/"` -> `["api", "auth", "oauth"]`. */
function pathSegments(p: string): string[] {
  return p.split("/").filter(Boolean);
}

/**
 * Validate a component's declared `httpRoute.pathPrefix`, throwing a descriptive error if it's
 * unsafe. Shared by BOTH `defineComponent` (fail fast when a component author writes `httpRoutes`)
 * and `composeComponents` (defense-in-depth, in case a `ComponentDefinition` object is ever
 * constructed/composed without going through `defineComponent`) — kept in one place so the two call
 * sites can't drift out of sync. Three rules, all enforced:
 *
 *  1. Must live under a reserved namespace (`/api/` or `/_`) — an app's own `http.ts` mounts
 *     everywhere else, so a component route can never collide with an app route.
 *  2. Must have at least 2 non-empty path segments (e.g. `/api/auth/`, NOT `/api/`) — a structural
 *     floor that makes whole-namespace shadowing impossible BY CONSTRUCTION, even if
 *     `RESERVED_ENGINE_PREFIXES` above is later incomplete or a new engine route is added without
 *     updating it.
 *  3. Must not collide with a `RESERVED_ENGINE_PREFIXES` entry in EITHER direction (see that
 *     constant's doc comment for why the ancestor direction is the one that was missing).
 */
export function assertValidComponentRoutePrefix(componentName: string, pathPrefix: string): void {
  if (!(pathPrefix.startsWith("/api/") || pathPrefix.startsWith("/_"))) {
    throw new Error(`component "${componentName}" httpRoute pathPrefix "${pathPrefix}" must be a reserved path (start with "/api/" or "/_")`);
  }
  if (pathSegments(pathPrefix).length < 2) {
    throw new Error(
      `component "${componentName}" httpRoute pathPrefix "${pathPrefix}" is too shallow — a component pathPrefix must have at ` +
        `least 2 path segments (e.g. "/api/${componentName}/", not "/api/", and not "/_") so it cannot shadow a whole reserved namespace`,
    );
  }
  for (const r of RESERVED_ENGINE_PREFIXES) {
    if (pathPrefix === r || r.startsWith(pathPrefix) || pathPrefix.startsWith(r)) {
      throw new Error(`component "${componentName}" httpRoute "${pathPrefix}" collides with a built-in engine prefix "${r}"`);
    }
  }
}

export function defineComponent(def: ComponentDefinition): ComponentDefinition {
  if (!def.name) throw new Error("component name must be non-empty");
  if (def.name.startsWith("_") || def.name === "app") throw new Error(`component name "${def.name}" is reserved`);
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(def.name)) {
    throw new Error(`component name "${def.name}" may contain only letters, digits, underscores (no "/" or ":")`);
  }
  if (def.contextType && !def.context) {
    throw new Error(
      `component "${def.name}" declares contextType but no context builder — ctx.${def.name} would be typed but undefined at runtime`,
    );
  }
  for (const r of def.httpRoutes ?? []) {
    assertValidComponentRoutePrefix(def.name, r.pathPrefix);
    if (!def.modules[r.handler] || def.modules[r.handler]!.type !== "httpAction") {
      throw new Error(`component "${def.name}" httpRoute handler "${r.handler}" must name an httpAction in this component's modules`);
    }
  }
  return def;
}
