import type { SchemaDefinition, Validator, JSONValue } from "@stackbase/values";
import type { RegisteredFunction, TablePolicy, PolicyContextProvider, GuestDatabaseWriter, ActionApi } from "@stackbase/executor";
import type { ComponentContext } from "@stackbase/executor";
import type { SerializedKeyRange } from "@stackbase/index-key-codec";

export interface BootContext { db: GuestDatabaseWriter; now: number }

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
}

/** A recurring runtime seam: started once after boot, woken by commits and/or timers. */
export interface Driver {
  name: string;
  start(ctx: DriverContext): void | Promise<void>;
  stop?(): void | Promise<void>;
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
  return def;
}
