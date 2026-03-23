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
 * mount, for opt-in composed components. Matched by longest/any prefix ahead of user routes; the
 * handler parses any sub-path (`<provider>/<phase>`) itself, as this repo's routes carry no named
 * params (see `@stackbase/executor`'s `matchRoute`, and storage's `handleServe`).
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
    if (!(r.pathPrefix.startsWith("/api/") || r.pathPrefix.startsWith("/_"))) {
      throw new Error(`component "${def.name}" httpRoute pathPrefix "${r.pathPrefix}" must be a reserved path (start with "/api/" or "/_")`);
    }
    if (!def.modules[r.handler] || def.modules[r.handler]!.type !== "httpAction") {
      throw new Error(`component "${def.name}" httpRoute handler "${r.handler}" must name an httpAction in this component's modules`);
    }
  }
  return def;
}
