/**
 * `InlineUdfExecutor` — runs a function in-process through the syscall channel. "Inline"
 * means the guest is plain JS in the same process (no isolate yet), but it still reaches the
 * engine ONLY via JSON syscalls, so swapping in a real V8 isolate is a drop-in change.
 *
 * Queries and mutations run inside `transactor.runInTransaction`, so OCC validation and
 * deterministic replay come for free. (Actions, which run outside a transaction with native
 * capabilities, are a later slice.)
 */
import type { OplogDelta, Transactor } from "@stackbase/transactor";
import type { QueryRuntime } from "@stackbase/query-engine";
import type { KeyRange } from "@stackbase/index-key-codec";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import { createKernelRouter, InlineSyscallChannel, type KernelContext, type SyscallRouter } from "./kernel";
import { profileFor } from "./profile";
import { createSeededRandom } from "./seeded-random";
import { GuestDatabaseReader, GuestDatabaseWriter, type FunctionReference } from "./guest";
import type { IndexCatalog } from "./catalog";
import type { RegisteredFunction } from "./functions";
import type { LogKind, LogSink } from "./log-sink";
import type { PolicyRegistry, PolicyContextProvider, RuleContext, RelationRegistry } from "./policy";

/** `ref` may be a path string or a codegen'd `FunctionReference` (which carries `__path`). */
function resolveRef(ref: FunctionReference | string): string {
  return typeof ref === "string" ? ref : ref.__path;
}

export interface ExecutorDeps {
  transactor: Transactor;
  queryRuntime: QueryRuntime;
  catalog: IndexCatalog;
  logSink?: LogSink;
  now?: () => number;
  /**
   * Trusted server re-entrancy: resolves ANY registered path — including `_`-prefixed
   * component-internal modules — unlike the public `runtime.run`/`runAction`, which block `_`.
   * An action's `runQuery`/`runMutation`/`runAction` go through this to start a fresh,
   * independent top-level run (its own transaction, or its own action execution).
   */
  invoke?: (path: string, args: JSONValue, opts?: { identity?: string | null }) => Promise<UdfResult>;
}

export interface ComponentContext {
  readonly db: GuestDatabaseReader;
  readonly identity: string | null;
  /** Wall-clock ms captured once at execution start (fixed per OCC attempt). */
  readonly now: number;
  /** Facades of components built before this one (the ones it `requires` / can compose on). */
  readonly components: Record<string, unknown>;
}

export interface ContextProvider {
  readonly name: string;
  /** The component's namespace; the facade's db reads (and, if `write`, writes) here. */
  readonly namespace: string;
  readonly build: (cctx: ComponentContext) => object;
  /**
   * Opt-in: when true AND the calling function is a mutation, `cctx.db` is a `GuestDatabaseWriter`
   * (still namespaced to this component's own tables) so the facade can write inside the CALLING
   * mutation's transaction — e.g. `ctx.scheduler.runAfter(...)` inserting a job row that rolls back
   * with the rest of the mutation. During a query call the facade still only gets a read-only db
   * (mutations are the only writers). Defaults to false: most facades are read-only (see "harden:
   * facade runs under read-only profile (two locks on writes)"). `ComponentContext.db` stays typed
   * as `GuestDatabaseReader`; a write-opted-in facade casts to `GuestDatabaseWriter` itself.
   */
  readonly write?: boolean;
}

export interface RunOptions {
  /** Seed for the deterministic RNG (defaults to 0 so re-runs are reproducible). */
  seed?: number;
  /** Function path, recorded in the execution log. */
  path?: string;
  /** Component namespace prefix (e.g. "auth"); bare table names are resolved under this prefix. Defaults to "" (app root). */
  namespace?: string;
  /** When true, bypasses the namespace boundary — raw table names are used as-is and ownership checks are skipped. For admin/_system use only. */
  privileged?: boolean;
  /** Ambient session token for this request, exposed to context facades. */
  identity?: string | null;
  /** Enabled components' context facades, attached as ctx[name]. */
  contextProviders?: ReadonlyArray<ContextProvider>;
  /** Table → policy, consulted by the kernel on non-privileged db ops. */
  policyRegistry?: PolicyRegistry;
  /** Components contributing rule-context fields (e.g. authz → `{ auth }`). */
  policyProviders?: ReadonlyArray<PolicyContextProvider>;
  /** Declared relations, consulted by the kernel when resolving relation predicates. */
  relationRegistry?: RelationRegistry;
}

export interface UdfResult<T = unknown> {
  value: T;
  logs: string[];
  committed: boolean;
  commitTs: bigint;
  /** Read set (for the sync tier to subscribe on). */
  readRanges: KeyRange[];
  /** Write delta (for mutations); null for pure reads. */
  oplog: OplogDelta | null;
}

/**
 * A sentinel a mutation RETURNS (never throws) to persist its writes and THEN surface an error.
 * Returned → the transactor commits the staged writes (which FAN OUT to subscriptions, so reactive
 * queries re-run) → the executor detects it (instanceof) post-commit and throws to the caller.
 *
 * ⚠️ The writes commit and become visible to subscribers even though the caller sees an error.
 * Use ONLY for incidental side-effects that must survive a rejection — failed-attempt counters,
 * audit rows, lockout state — NEVER for a mutation's primary effect (the client would believe it
 * failed while subscribers see the change). UNSTABLE/internal primitive, not part of the frozen
 * public component ABI; the export exists so first-party components (auth) can use it.
 */
export class CommitThenThrow {
  constructor(readonly message: string) {}
}

/** Build a CommitThenThrow sentinel — RETURN it from a mutation (see the class doc + its ⚠️). */
export function commitThenThrow(message: string): CommitThenThrow {
  return new CommitThenThrow(message);
}

export class InlineUdfExecutor {
  private readonly router: SyscallRouter = createKernelRouter();

  constructor(private readonly deps: ExecutorDeps) {}

  async run<T = unknown>(fn: RegisteredFunction, args: unknown, options: RunOptions = {}): Promise<UdfResult<T>> {
    if (fn.type === "httpAction") throw new Error("the inline executor does not yet run httpAction functions");
    if (fn.type === "action") return this.runActionFn<T>(fn, args, options);
    const profile = profileFor(fn.type);
    const seed = options.seed ?? 0;
    const clock = this.deps.now ?? Date.now;
    const startedAt = clock();
    const logEntry = (status: "ok" | "error", error?: string): void => {
      this.deps.logSink?.push({
        path: options.path ?? "<anonymous>",
        kind: fn.type as LogKind,
        ts: startedAt,
        durationMs: clock() - startedAt,
        status,
        ...(error !== undefined ? { error } : {}),
      });
    };

    try {
      const commit = await this.deps.transactor.runInTransaction(async (txn) => {
        // Base context: NO policy enforcement. Used for the facade readers and the rule-context's own
        // db reader, so a policy's internal reads are never themselves re-gated (no re-entrancy).
        const baseKctx: KernelContext = {
          profile,
          txn,
          queryRuntime: this.deps.queryRuntime,
          catalog: this.deps.catalog,
          snapshotTs: txn.snapshotTs,
          random: createSeededRandom(seed),
          logs: [],
          namespace: options.namespace ?? "",
          privileged: options.privileged ?? false,
          identity: options.identity ?? null,
          now: startedAt,
          policyRegistry: new Map(),
          getRuleContext: null,
          relationRegistry: { toMany: new Map(), toOne: new Map() },
        };

        const reserved = new Set(["db", "random", "now"]);
        const guestCtx: Record<string, unknown> = { random: () => baseKctx.random.next(), now: () => baseKctx.now };
        const builtFacades: Record<string, unknown> = {};
        for (const p of options.contextProviders ?? []) {
          if (reserved.has(p.name) || p.name in guestCtx) throw new Error(`context provider "${p.name}" collides with a reserved ctx key`);
          const canWrite = p.write === true && fn.type === "mutation";
          const pctx: KernelContext = { ...baseKctx, namespace: p.namespace, privileged: false, profile: profileFor(canWrite ? "mutation" : "query") };
          const channel = new InlineSyscallChannel(this.router, pctx);
          const preader = canWrite ? new GuestDatabaseWriter(channel) : new GuestDatabaseReader(channel);
          const facade = Object.freeze(p.build({ db: preader, identity: baseKctx.identity, now: baseKctx.now, components: builtFacades }));
          guestCtx[p.name] = facade;
          builtFacades[p.name] = facade;
        }

        // Memoized rule-context: built lazily on the first policy hit, once per call.
        const policyProviders = options.policyProviders ?? [];
        let rcCache: Promise<RuleContext> | undefined;
        const getRuleContext: (() => Promise<RuleContext>) | null = policyProviders.length === 0 ? null : () =>
          (rcCache ??= (async () => {
            const merged: Record<string, unknown> = {};
            for (const p of policyProviders) {
              const pctx: KernelContext = { ...baseKctx, namespace: p.namespace, privileged: false, profile: profileFor("query") };
              const preader = new GuestDatabaseReader(new InlineSyscallChannel(this.router, pctx));
              Object.assign(merged, await p.build({ db: preader, identity: baseKctx.identity, now: baseKctx.now, components: builtFacades }));
            }
            const db = new GuestDatabaseReader(new InlineSyscallChannel(this.router, { ...baseKctx, profile: profileFor("query") }));
            return { ...merged, db } as RuleContext;
          })());

        // Main context: carries the registry + rule-context builder → policy enforcement is ON.
        const kctx: KernelContext = { ...baseKctx, policyRegistry: options.policyRegistry ?? new Map(), getRuleContext, relationRegistry: options.relationRegistry ?? baseKctx.relationRegistry };
        const channel = new InlineSyscallChannel(this.router, kctx);
        const db = fn.type === "query" ? new GuestDatabaseReader(channel) : new GuestDatabaseWriter(channel);
        guestCtx.db = db;

        const value = await fn.handler(guestCtx, args);
        return { value: value as T, logs: kctx.logs, readRanges: txn.reads.toArray() };
      });
      // A mutation may return CommitThenThrow to persist its writes (e.g. a failed-attempt
      // counter) while still surfacing an error to the caller. The transaction is already
      // committed at this point, so throwing here is safe.
      if (commit.value.value instanceof CommitThenThrow) {
        logEntry("error", commit.value.value.message);
        throw new Error(commit.value.value.message);
      }
      logEntry("ok");
      return {
        value: commit.value.value,
        logs: commit.value.logs,
        committed: commit.committed,
        commitTs: commit.commitTs,
        readRanges: commit.value.readRanges,
        oplog: commit.oplog,
      };
    } catch (e) {
      logEntry("error", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /**
   * Actions run OUTSIDE `transactor.runInTransaction` — no read/write-set tracking, no commit
   * of their own. `ctx.db` is structurally absent (see `ActionCtx`); all data access goes
   * through `runQuery`/`runMutation`/`runAction`, each a fresh top-level `invoke` — its own
   * transaction (for query/mutation) or its own action execution.
   */
  private async runActionFn<T>(fn: RegisteredFunction, args: unknown, options: RunOptions): Promise<UdfResult<T>> {
    const clock = this.deps.now ?? Date.now;
    const startedAt = clock();
    const invoke = this.deps.invoke;
    if (!invoke) throw new Error("action execution requires an `invoke` runner (runtime wiring missing)");
    const run = (_kind: "query" | "mutation" | "action") =>
      async (ref: FunctionReference | string, a: Record<string, unknown> = {}) => {
        const path = resolveRef(ref);
        const res = await invoke(path, convexToJson(jsonToConvex(a as unknown as JSONValue) as Value) as JSONValue, { identity: options.identity ?? null });
        return res.value;
      };
    const actionCtx: Record<string, unknown> = {
      runQuery: run("query"),
      runMutation: run("mutation"),
      runAction: run("action"),
      // Task 2 augments actionCtx with scheduler + component facades before the handler runs.
    };
    try {
      const value = await fn.handler(actionCtx, args);
      this.deps.logSink?.push({ path: options.path ?? "<anonymous>", kind: "action", ts: startedAt, durationMs: clock() - startedAt, status: "ok" });
      return { value: value as T, logs: [], committed: false, commitTs: 0n, readRanges: [], oplog: null };
    } catch (e) {
      this.deps.logSink?.push({ path: options.path ?? "<anonymous>", kind: "action", ts: startedAt, durationMs: clock() - startedAt, status: "error", error: String(e) });
      throw e;
    }
  }
}
