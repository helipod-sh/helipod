import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DocStore } from "@helipod/docstore";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents, type ComponentDefinition } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import type { SchedulerDriver } from "@helipod/scheduler";
import { defineSchema, type SchemaDefinition, type SchemaDefinitionJSON } from "@helipod/values";
import { mutation, matchRoute, type RegisteredFunction, type RouteEntry } from "@helipod/executor";
import {
  STORAGE_TABLE,
  STORAGE_TABLE_NUMBER,
  storageTableDefinition,
  storageModules,
  storageContextProvider,
  storageReaper,
} from "@helipod/storage";
import { FsBlobStore } from "@helipod/blobstore-fs";
import { flattenModules } from "./flatten";
import { createReactivity, type Reactivity } from "./reactivity";

export interface CreateTestOptions {
  modules: Record<string, unknown>;
  components?: ComponentDefinition[];
  schema?: SchemaDefinition | "auto" | false;
  now?: () => number;
  /**
   * The document store to run against. Defaults to an in-memory SQLite store. Pass an alternative
   * (e.g. a `PostgresDocStore`) to exercise the real engine against a different backend — its
   * `setupSchema()` is called by the runtime and `close()` by the harness cleanup. The store must
   * start empty; the harness owns its lifecycle from here.
   */
  store?: DocStore;
  /**
   * The leading path segment `import.meta.glob`-sourced `modules` keys are prefixed with (e.g.
   * `import.meta.glob("./helipod/**\/*.ts")` yields keys like `./helipod/messages.ts`) —
   * stripped so a glob-sourced module registers under the same `messages:send`-style path an
   * explicit `{ "messages.ts": messages }` map would. Defaults to the same value as
   * `DEFAULT_FUNCTIONS_DIR` in `@helipod/cli`. Only needed if `modules` came from a glob AND the
   * project's `helipod.config.ts` sets a non-default `functionsDir` — an explicit `{ "messages.ts":
   * ... }` map (no path prefix to strip) is unaffected either way.
   */
  functionsRoot?: string;
}

/** A single `http.ts` route, with its handler resolved from a `RegisteredFunction` value to the
 * `path:name` function path `runtime.runHttpAction` looks up — mirrors `packages/cli/src/project.ts`'s
 * `ResolvedRoute`. */
export interface ResolvedRoute {
  method: string;
  path?: string;
  pathPrefix?: string;
  handlerPath: string;
}

export interface BuiltRuntime {
  runtime: EmbeddedRuntime;
  tableNumbers: Record<string, number>;
  schemaJson: SchemaDefinitionJSON;
  cleanup: () => Promise<void>;
  /** Sets the callback `_test:_run`'s handler invokes with a full db-writer `ctx`. */
  setRunFn: (fn: ((ctx: unknown) => Promise<unknown>) | null) => void;
  /** Reads back (and clears) the value the last `setRunFn` callback returned. */
  takeRunResult: () => unknown;
  /**
   * Routes a raw `Request` through the app's `http.ts` router (if any), the same way the real
   * `helipod dev`/`serve` HTTP handler dispatches to an `httpAction` — see
   * `packages/cli/src/http-handler.ts`. Returns a plain `Response("Not Found", { status: 404 })`
   * for an unmatched method+path, never throws for that case. `identity` (if non-null) wins over
   * the request's own `Authorization` header, which is used as a fallback and Bearer-stripped
   * (`Bearer abc123` -> `abc123`, non-Bearer -> null) — exact parity with the real engine's
   * httpAction identity passthrough (there, identity is ALWAYS derived from the header, since there
   * is no session concept at the raw-HTTP layer).
   */
  dispatchHttp: (request: Request, identity: string | null) => Promise<Response>;
  /**
   * The harness-shared reactive-subscription surface (`t.subscribe`), built lazily on first use
   * over a real loopback connection to `runtime` — see `./reactivity.ts`. Its `HelipodClient`
   * is closed in `cleanup` BEFORE `runtime.stopDrivers()`, so no loopback session outlives the
   * runtime it's connected to.
   */
  reactivity: Reactivity;
  /**
   * True when this harness owns the virtual clock — i.e. `opts.now` was NOT supplied, so `now()`
   * is backed by the mutable `clockMs` this module owns. When `opts.now` WAS supplied, the caller
   * owns time and `advanceClock` throws (mutating `clockMs` would have no effect on `now()`,
   * which reads the caller's own function instead).
   */
  ownsClock: boolean;
  /**
   * Advances the harness-owned virtual clock by `ms` (relative to its current value). Backs
   * `t.advanceTimers`/`t.finishScheduledFunctions` (see `./scheduler.ts`). Throws if `ownsClock`
   * is false.
   */
  advanceClock: (ms: number) => void;
  /**
   * Finds `@helipod/scheduler`'s driver among the composed drivers (by `name === "scheduler"`),
   * if `defineScheduler()` was included in `opts.components` — `undefined` otherwise. Used by
   * `./scheduler.ts` to drive `__tick()`.
   */
  getSchedulerDriver: () => SchedulerDriver | undefined;
}

export async function buildRuntime(opts: CreateTestOptions): Promise<BuiltRuntime> {
  const flat = await flattenModules(opts.modules, opts.functionsRoot);
  // Resolve the schema: explicit option wins; else the schema.ts module; else empty.
  const schemaDef: SchemaDefinition =
    // `opts.schema &&` already excludes `false` (falsy) as well as `undefined`, so an explicit
    // `!== false` check afterward is both redundant and a TS error (no overlap once narrowed).
    opts.schema && opts.schema !== "auto"
      ? opts.schema
      : (flat.schemaModule as SchemaDefinition | null) ?? defineSchema({});
  const schemaJson = schemaDef.export();

  // File storage is an ALWAYS-ON core feature (not opt-in) — inject its reserved `_storage` system
  // table into the schema BEFORE composing, mirroring `packages/cli`'s `loadProject` (see
  // `packages/cli/src/project.ts`), so the catalog/tableNumbers include it and `v.id("_storage")`
  // validates. Its table number is pinned via `existingTableNumbers` below so ids encode/decode
  // consistently.
  schemaJson.tables[STORAGE_TABLE] = storageTableDefinition.export();

  const composed = composeComponents({ schemaJson, moduleMap: flat.moduleMap }, opts.components ?? [], {
    [STORAGE_TABLE]: STORAGE_TABLE_NUMBER,
  });

  // Extract + resolve the `http.ts` router (if any): its default export is an `HttpRouter` whose
  // route handlers are `RegisteredFunction` VALUES — resolve each to its `path:name` function path
  // by identity over `composed.moduleMap` (the same objects the router references), for
  // `runtime.runHttpAction` to look up — mirrors `packages/cli/src/project.ts`'s route resolution.
  const resolvedRoutes: ResolvedRoute[] = [];
  const router = flat.httpModule as { routes?: RouteEntry[] } | null;
  if (router?.routes) {
    const pathByFn = new Map<RegisteredFunction, string>();
    for (const [path, fn] of Object.entries(composed.moduleMap)) pathByFn.set(fn, path);
    for (const r of router.routes) {
      const handlerPath = pathByFn.get(r.handler);
      if (!handlerPath) {
        const where = r.path ?? r.pathPrefix ?? "?";
        throw new Error(
          `http.route handler for "${where}" must be an exported httpAction (declare it as a named export of an app module)`,
        );
      }
      resolvedRoutes.push({
        method: r.method,
        ...(r.path !== undefined ? { path: r.path } : { pathPrefix: r.pathPrefix }),
        handlerPath,
      });
    }
  }

  // Per-instance temp dir for the FS blob backend — removed in `cleanup`.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-test-"));
  const blobStore = new FsBlobStore({ root: tempDir });

  // The harness-owned virtual clock — only used when `opts.now` isn't supplied. `advanceClock`
  // (below) mutates `clockMs`; `now` reads it fresh on every call, so `EmbeddedRuntime` (and
  // everything downstream — the scheduler's `_peekDue`/`_claim`/`_complete`, `ctx.now()` in app
  // code, etc.) always sees the harness's current virtual time with no real timers involved.
  const ownsClock = opts.now === undefined;
  let clockMs = 1_700_000_000_000;
  const now = opts.now ?? (() => clockMs);

  // `_test:_run` — the mechanism behind `t.run(fn)`: a system mutation whose handler invokes
  // whatever callback `t.run` most recently parked in `currentRunFn`, giving test code a full
  // db-writer `ctx` inside a real transaction without having to define an app function for it.
  let currentRunFn: ((ctx: unknown) => Promise<unknown>) | null = null;
  let runResult: unknown = undefined;
  const systemModules = {
    "_test:_run": mutation(async (ctx: unknown) => {
      if (!currentRunFn) throw new Error("_test:_run invoked with no callback set");
      runResult = await currentRunFn(ctx);
      return null;
    }),
  };

  // `create` can throw before `cleanup` is returned (a driver's `start()`, a boot step, or schema
  // setup failing) — in that case nothing would ever remove the temp dir. Remove it on failure so a
  // failed `createTestHelipod` never orphans a `sb-test-*` dir in the OS temp dir, then rethrow.
  // The store is captured (not constructed inline) so both the success path's `cleanup` and this
  // catch block can close its underlying SQLite handle — otherwise an in-memory db handle (and, on
  // `create`-throws, the process-visible file descriptor it holds) leaks for the life of the process.
  const store = opts.store ?? new SqliteDocStore(new NodeSqliteAdapter());
  let runtime: EmbeddedRuntime;
  try {
    runtime = await EmbeddedRuntime.create({
      store,
      catalog: composed.catalog,
      // `_storage:*` built-ins go in `modules` — the action-mode `ctx.storage` reaches them through
      // the trusted `invoke`, and the reaper driver through `runFunction`, both of which resolve
      // `modules` (not `systemModules`).
      modules: { ...composed.moduleMap, ...storageModules },
      systemModules,
      componentNames: composed.componentNames,
      contextProviders: [
        storageContextProvider(blobStore, { signingKey: "helipod-test-signing-key" }),
        ...composed.contextProviders,
      ],
      policyRegistry: composed.policyRegistry,
      policyProviders: composed.policyProviders,
      relationRegistry: composed.relationRegistry,
      bootSteps: composed.bootSteps,
      drivers: [storageReaper(blobStore), ...composed.drivers],
      tableNumbers: composed.tableNumbers,
      now,
    });
  } catch (err) {
    await store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }

  const reactivity = createReactivity(runtime);
  const cleanup = async () => {
    // Close the shared loopback client BEFORE stopping drivers, so its connection tears down
    // against a still-live runtime rather than racing driver shutdown. The docstore itself is
    // closed AFTER drivers stop (so nothing still-running can touch it mid-close) and before the
    // temp dir backing file storage is removed.
    await reactivity.close();
    await runtime.stopDrivers();
    await store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  // See `packages/cli/src/http-handler.ts`'s "User httpAction routes" block — this is the same
  // match-then-dispatch, minus the wire (de)serialization a real HTTP server needs since `t.fetch`
  // already deals in `Request`/`Response` objects directly.
  const dispatchHttp = async (request: Request, identity: string | null): Promise<Response> => {
    const url = new URL(request.url);
    const match = matchRoute(resolvedRoutes, request.method, url.pathname);
    if (!match) return new Response("Not Found", { status: 404 });
    // Header-fallback identity mirrors the real engine EXACTLY (see
    // `packages/cli/src/http-handler.ts`): the raw `Authorization` header is Bearer-stripped —
    // `Bearer abc123` -> `abc123`, anything else -> null — so a bare `t.fetch(req)`'s httpAction
    // sees the same `ctx.identity` it would in production. The view's `withIdentity` token (already
    // a bare string) still wins when present.
    const auth = request.headers.get("authorization");
    const headerIdentity = auth && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    return runtime.runHttpAction(match.handlerPath, request, { identity: identity ?? headerIdentity });
  };
  // Mirrors `components/scheduler/test/helpers.ts`'s lookup — the scheduler's own driver, if
  // `defineScheduler()` was passed in `opts.components`.
  const schedulerDriver = composed.drivers.find((d) => d.name === "scheduler") as SchedulerDriver | undefined;
  return {
    runtime,
    tableNumbers: composed.tableNumbers,
    schemaJson,
    cleanup,
    setRunFn: (fn) => { currentRunFn = fn; },
    takeRunResult: () => { const r = runResult; runResult = undefined; return r; },
    dispatchHttp,
    reactivity,
    ownsClock,
    advanceClock: (ms) => {
      if (!ownsClock) {
        throw new Error(
          "advanceClock/advanceTimers/finishScheduledFunctions require the harness-owned virtual clock — " +
            "createTestHelipod() was given a custom `now`, so the harness has no clock to advance. " +
            "Omit `opts.now` to use scheduler time control.",
        );
      }
      clockMs += ms;
    },
    getSchedulerDriver: () => schedulerDriver,
  };
}
