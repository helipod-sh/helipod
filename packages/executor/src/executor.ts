/**
 * `InlineUdfExecutor` — runs a function in-process through the syscall channel. "Inline"
 * means the guest is plain JS in the same process (no isolate yet), but it still reaches the
 * engine ONLY via JSON syscalls, so swapping in a real V8 isolate is a drop-in change.
 *
 * Queries and mutations run inside `transactor.runInTransaction`, so OCC validation and
 * deterministic replay come for free. Actions run OUTSIDE any transaction (see `runActionFn`)
 * with native capabilities and no `ctx.db` — they reach data only via `ctx.runQuery`/`runMutation`.
 */
import type { OplogDelta, Transactor } from "@stackbase/transactor";
import type { QueryRuntime, FilterExpr } from "@stackbase/query-engine";
import type { KeyRange, SerializedKeyRange } from "@stackbase/index-key-codec";
import { convexToJson, jsonToConvex, validate, type JSONValue, type Value } from "@stackbase/values";
import { DEFAULT_SHARD, shardIdForKeyValue, type ShardId } from "@stackbase/id-codec";
import { ArgumentValidationError } from "@stackbase/errors";
import { COLLECT_BRAND, createKernelRouter, InlineSyscallChannel, type CollectTrace, type KernelContext, type SyscallRouter } from "./kernel";
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

/**
 * Fleet write-routing seam (Tier 2), PER-SHARD. Lets a node that does NOT own a mutation's
 * resolved shard forward that mutation to whichever node currently owns the shard, instead of
 * committing locally (which would fence its OCC ring). Checked at the executor's ONE chokepoint —
 * AFTER `shardBy`/privileged shard resolution — so every entry point routes identically: client WS
 * mutations, `/api/run`, an action's inner `ctx.runMutation` (via `ExecutorDeps.invoke`), AND the
 * scheduler/driver path (which calls `run()` directly and previously bypassed routing entirely,
 * the driver hazard this move fixes). Queries are never routed. `isLocalWriter` is consulted per
 * call (never cached), so a per-shard role flip takes effect on the very next mutation.
 */
/**
 * A replay of a prior client-mutation verdict (the Receipted Outbox, verdict §(c)) surfaced through
 * the executor/forward boundary — see {@link UdfResult.clientReplay}. JSON-friendly (`value` is a
 * `JSONValue`) so it survives the fleet forward hop; the sync tier maps it to its own `Value`-typed
 * replay. Distinct from a fleet `idempotency` replay (per-hop, `ee/`): this is the DURABLE client
 * dedup verdict.
 */
export interface ClientReplay {
  verdict: "applied" | "failed" | "stale";
  commitTs?: number;
  value?: JSONValue;
  valueMissing?: true;
  code?: string;
}

export interface WriteRouter {
  /** true → this node owns `shardId`; commit locally. false → forward to the owner. Per call. */
  isLocalWriter(shardId: ShardId): boolean;
  /** Forward a write to the shard's owner; resolves with the function's JSON result (plus, when the
   *  owner reports them, the commit's `commitTs`/`shardId`) or throws the owner's typed error.
   *  `dedup` (Receipted Outbox): the durable `(clientId, seq)` rides the forward so the OWNER — never
   *  a follower's replica — does the classification (verdict §(c) repair 3). When the owner replays a
   *  recorded verdict instead of running, it comes back as `replay` (and `value` is that replay's
   *  value, or absent). */
  forward(
    kind: "mutation" | "action",
    path: string,
    args: JSONValue,
    identity: string | null,
    shardId: ShardId,
    dedup?: { clientId: string; seq: number },
  ): Promise<{ value: JSONValue; commitTs?: number; shardId?: string; replay?: ClientReplay }>;
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
  /**
   * Per-shard write routing (fleet Tier 2). When set and this node is NOT the owner of a mutation's
   * resolved shard, the mutation is forwarded instead of committed locally — see `WriteRouter`. On
   * `ExecutorDeps` (not `RunOptions`) so the trusted `invoke` path sees it too: an action's inner
   * `ctx.runMutation` forwards per-shard exactly like a top-level mutation. Unset → never routes
   * (byte-identical to a single-node engine).
   */
  writeRouter?: WriteRouter;
  /**
   * Hybrid-node split-read seam (Fleet B3, D1). When set, `run()` for `fn.type === "query"` uses
   * `queryPath.transactor` for `runInTransaction` AND `queryPath.queryRuntime` for
   * `kctx.queryRuntime` — BOTH together, never one without the other (a half-switched wiring
   * would let a query's index scans read one store while nothing else changed, or — worse, if
   * ever misapplied to a mutation — split a mutation's scans from its point reads across two
   * stores, corrupting read-your-own-writes). Mutations and actions always use `deps.transactor`/
   * `deps.queryRuntime`, the primary pair, regardless of `queryPath`. Unset → every call uses the
   * primary pair, byte-identical to before this seam existed.
   */
  queryPath?: { transactor: Transactor; queryRuntime: QueryRuntime };
}

export interface ComponentContext {
  readonly db: GuestDatabaseReader;
  readonly identity: string | null;
  /** Wall-clock ms captured once at execution start (fixed per OCC attempt). */
  readonly now: number;
  /** Facades of components built before this one (the ones it `requires` / can compose on). */
  readonly components: Record<string, unknown>;
  /**
   * Resolve a target function's registered kind by path (for schedulers tagging a job's
   * `kind:"mutation"|"action"`). Undefined if the runtime didn't supply a resolver or the path
   * is unknown. Optional + additive — facades/tests that build a cctx without it still work.
   */
  readonly functionKind?: (path: string) => "query" | "mutation" | "action" | "httpAction" | undefined;
}

/**
 * The api handed to `ContextProvider.buildAction` — mirrors `ActionCtx`'s `runQuery`/
 * `runMutation`/`runAction` (each a fresh top-level `invoke`) plus the ambient `identity`. No
 * `db`: actions have none (see `ActionCtx`'s doc comment in `./guest.ts`), so an action-mode
 * facade can only reach data by delegating to `runMutation`/`runQuery` of its own component's
 * (typically `_`-prefixed) modules.
 */
export interface ActionApi {
  runQuery<T = unknown>(ref: FunctionReference | string, args?: Record<string, unknown>): Promise<T>;
  runMutation<T = unknown>(ref: FunctionReference | string, args?: Record<string, unknown>): Promise<T>;
  runAction<T = unknown>(ref: FunctionReference | string, args?: Record<string, unknown>): Promise<T>;
  identity: string | null;
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
  /**
   * Optional: the ACTION-mode counterpart to `build` — attached as `ctx[name]` inside an action
   * instead of `build`'s in-txn facade (an action has no `db`, so `build` never runs there). Takes
   * an `ActionApi` (no `db`) and must return a facade with the SAME method signatures as `build`'s,
   * so a function body scheduling/calling through it is portable between a mutation and an action —
   * e.g. `ctx.scheduler.runAfter(...)` delegates to `api.runMutation` of an internal `_`-prefixed
   * mutation instead of writing `db` directly. Optional and additive: a component without it simply
   * doesn't appear on the action ctx (see `InlineUdfExecutor.runActionFn`).
   */
  readonly buildAction?: (api: ActionApi) => object;
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
  /** Resolve a target function's registered kind by path; threaded onto every `ComponentContext` built for `build(cctx)`. See `ComponentContext.functionKind`'s doc comment. */
  functionKind?: (path: string) => "query" | "mutation" | "action" | "httpAction" | undefined;
  /**
   * Number of shards this deployment routes across (boot-time config; NUM_SHARDS). Defaults to 1
   * → every `shardBy` resolves to `"default"` and every kernel shard guard short-circuits, so
   * behavior is byte-identical to a non-sharded engine. T5 threads the real value from boot.
   */
  numShards?: number;
  /**
   * Boot-step / trusted-local escape hatch: when true, the per-shard `writeRouter` check is skipped
   * and the mutation ALWAYS commits locally, even if this node doesn't own the resolved shard. Used
   * by `runtime.create`'s boot steps (they run before the node is ready to be the default-shard
   * owner and must seed locally). Non-boot callers never set this — their write routes normally.
   */
  localOnly?: boolean;
  /**
   * Explicit shard override for the transaction — honored ONLY when `privileged: true`. A
   * privileged run (admin `_system:*` doc edits, drivers) skips the shardBy *declaration* path, so
   * this is its ONLY way onto a non-default ring: the admin/system layer resolves a document's
   * owning shard from its (immutable) shard-key value and passes it here, so a privileged write of
   * a sharded doc lands on the doc's home ring instead of forking its prev_ts chain from the default
   * ring. Ignored for non-privileged callers — their shard comes solely from `shardBy` (one-ring
   * invariant: user code declares its shard, it never overrides it).
   */
  shardId?: ShardId;
  /**
   * Opaque commit metadata (Fleet B3, D3 — effectively-once forwarding), threaded straight
   * through to `Transactor.runInTransaction`'s `commitMeta` and never interpreted by the executor
   * itself. Meaningful for mutations only — a query never reaches the commit path (a pure read
   * returns before `DocStore.commitWrite` is ever called), so setting this on a query call is a
   * harmless no-op. Unset → identical to before this field existed.
   */
  commitMeta?: Record<string, string>;
  /**
   * G4 origin-frontier tag (client-sync verdict §(d) item 2). The originating sync SESSION id,
   * threaded straight through to `Transactor.runInTransaction`'s `origin` (which stamps it onto the
   * emitted `OplogDelta.origin`) and never interpreted by the executor. Meaningful for mutations
   * only — a query never reaches the commit path. Set by the sync handler's `runMutation` (to the
   * committing session's id) so the fan-out can advance that session's own `version.ts` even when
   * the commit touched nothing it subscribes to. Unlike `commitMeta`, it is NEVER made durable.
   * Unset → identical to before this field existed.
   */
  origin?: string;
  /**
   * The durable client-mutation dedup key (Receipted Outbox, verdict §(c)). Meaningful for a
   * mutation that FORWARDS: the executor threads it to `WriteRouter.forward` so the owner classifies
   * it. The LOCAL-commit classification (pre-read + `applied`-receipt guard) is driven by the runtime
   * (which owns the `DocStore`), not here — for a local commit the runtime instead passes the dedup
   * key via `commitMeta`, which the receipts guard reads. Unset → identical to before this field.
   */
  dedup?: { clientId: string; seq: number };
  /**
   * Force this run's reads onto the PRIMARY store even when a hybrid `queryPath` (replica) is
   * configured (Fleet B3). Set by the runtime's DRIVER path (`DriverContext.runFunction`): a
   * component driver (scheduler/cron/reaper/workflow) runs on the writer that OWNS the shard its
   * control tables live on, so its internal queries (`scheduler:_peekDue` scanning `jobs`) MUST
   * read-its-own-writes — a job the app just enqueued on the primary is invisible on the lagging
   * replica, so a replica-backed peek would strand the job until the replica caught up (or forever,
   * under sustained commit load). Ignored when no `queryPath` is configured (single-writer/non-hybrid
   * → reads already hit the primary), so it's a no-op everywhere except a hybrid node's driver loop.
   */
  primaryRead?: boolean;
}

/**
 * DLR Stage 2b: a query run classified as DIFFABLE_RANGE — its ENTIRE result is exactly the
 * ordered documents of one index-range scan, unmodified by the handler. A subscription carrying
 * this can be re-evaluated by DIFFING the scanned range against a commit's write set instead of
 * fully re-running the query handler (the differ's job; not built by this task). `bounds` is
 * byte-identical to the `index:` range this run's own `readRanges` recorded for `keyspace`, so a
 * downstream differ can re-scan the exact same interval. Absent whenever the executor has ANY
 * doubt about passthrough purity — see `classifyDiffableRange`'s guard.
 */
export interface DiffableRange {
  keyspace: string;
  bounds: SerializedKeyRange;
  filters: FilterExpr[];
  order: "asc" | "desc";
  fields: string[];
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
  /**
   * Set instead of a fresh commit when a dedup-keyed mutation forwarded to an owner that REPLAYED a
   * recorded verdict (the Receipted Outbox, verdict §(c)). No commit happened this call; `committed`
   * is false and `oplog` is null. The runtime/sync tier surfaces this as a `MutationReplay` rather
   * than a fresh `MutationResponse`. Absent on every non-dedup / freshly-committed run.
   */
  clientReplay?: ClientReplay;
  /**
   * DLR Stage 2b (query runs only): set when this run's ENTIRE result is one passthrough
   * index-range collect — see `DiffableRange`'s doc comment. Absent for mutations/actions, and for
   * any query the executor can't PROVE is a clean passthrough (conservative: any doubt → absent).
   */
  diffableRange?: DiffableRange;
}

/**
 * DLR Stage 2b passthrough guard. A run is DIFFABLE_RANGE only if EXACTLY ONE index-range
 * `db.query` collect ran (`trace.length === 1`), no OTHER read syscall touched the transaction
 * (cross-checked against the run's own `readRanges` — a `db.get` records no `CollectTrace` entry
 * but DOES land a `table:`-keyspace point read there), no read policy was merged into that
 * collect (dynamic authz can't be soundly re-applied by a downstream differ), and the handler's
 * returned value is the EXACT, UNMODIFIED array that collect returned — proven by IDENTITY, not
 * content: the guest branded that array (non-enumerably, {@link COLLECT_BRAND}) with the collect's
 * `token`, and any `slice`/`filter`/`map`/spread/`[...docs]` produces a fresh, unbranded array that
 * fails this check and correctly falls to a full RERUN. Content equality is deliberately NOT used:
 * a JS post-op that is a no-op ON THE CURRENT DATA (`docs.slice(0, 10)` when ≤10 rows, or
 * `docs.filter(d => d.big)` when every row is `big`) is content-indistinguishable from a real
 * passthrough, yet would silently cap/exclude a later inserted in-range row the differ still emits —
 * permanent wrong data the drift checksum can't catch (server and client agree on the same wrong
 * set). Declining harmless copies to RERUN is the correct conservative trade ("any doubt → RERUN").
 * Also declines whenever the collect declared a `.take(n)` limit (`hadLimit`): the recorded range
 * is the TRUNCATED top-N window, not the full matching range, so a downstream range-differ would
 * neither apply the limit (rendering every matching row, not just the top N) nor notice a write
 * that should promote a new document into the top-N — see `CollectTrace.hadLimit`'s doc comment.
 * Only the executor can make this call: it alone sees both the kernel's collect trace AND the
 * handler's final returned value. Any doubt → `undefined` (the caller falls back to a full RERUN);
 * this guard is deliberately the ONLY defense here — the drift-XOR-checksum safety net downstream
 * can't catch a mis-classified post-processed handler, since a checksum over the (already wrong)
 * returned value looks internally consistent.
 *
 * ISOLATE NOTE: the `COLLECT_BRAND` identity check works because the guest and this classifier share
 * one heap under the current `InlineUdfExecutor`. Across a real V8-isolate boundary the guest array
 * would be serialized (dropping the Symbol brand), so the brand check would have to run guest-side
 * and travel as an explicit wire flag on the return value — out of scope now.
 */
function classifyDiffableRange(value: unknown, trace: readonly CollectTrace[], readRanges: readonly KeyRange[]): DiffableRange | undefined {
  if (trace.length !== 1) return undefined; // exactly one collect, and no ambiguous second collect
  const t = trace[0]!;
  if (t.hadReadPolicy) return undefined; // dynamic authz was merged in — RERUN, never diff
  if (t.hadLimit) return undefined; // truncated top-N window, not the full range — RERUN, never diff
  // No other read syscall (e.g. a `db.get` alongside the collect) touched this transaction: the
  // run's full read set must be exactly the one range this collect itself scanned.
  if (readRanges.length !== 1 || readRanges[0]!.keyspace !== t.keyspace) return undefined;
  if (!Array.isArray(value)) return undefined; // not a list result
  // Identity, not content: the returned value must be the untouched array THIS collect returned,
  // carrying its token brand. A copy (slice/filter/map/spread) is unbranded → decline.
  if ((value as unknown as Record<PropertyKey, unknown>)[COLLECT_BRAND] !== t.token) return undefined;
  return { keyspace: t.keyspace, bounds: t.bounds, filters: t.filters, order: t.order, fields: t.fields };
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

/**
 * Property key the executor stamps onto an error it throws AFTER its transaction has ALREADY
 * committed (today the only such case is `CommitThenThrow`). The sync handler reads it (via
 * {@link committedTsOfError}) to release the origin-response gate that was registered at commit time
 * — a commit-then-throw from a diff-capable subscribed origin would otherwise leave that gate
 * unresolved and wedge the whole node's reactive drain forever (DLR 2b review). `Symbol.for` keeps it
 * stable across duplicate module instances (tests resolve workspace deps via each package's `dist`).
 */
export const COMMITTED_TS_ERROR_KEY = Symbol.for("stackbase.executor.committedTs");

/** Read the committed-ts the executor stamped onto a post-commit error, or `undefined` (a pre-commit
 *  throw — no commit happened, so no gate was ever registered). */
export function committedTsOfError(e: unknown): number | undefined {
  if (e !== null && typeof e === "object") {
    const ts = (e as Record<PropertyKey, unknown>)[COMMITTED_TS_ERROR_KEY];
    if (typeof ts === "number") return ts;
  }
  return undefined;
}

export class InlineUdfExecutor {
  private readonly router: SyscallRouter = createKernelRouter();

  constructor(private readonly deps: ExecutorDeps) {}

  async run<T = unknown>(fn: RegisteredFunction, args: unknown, options: RunOptions = {}): Promise<UdfResult<T>> {
    if (fn.type !== "httpAction" && fn.argsValidator) {
      const failures = validate(fn.argsValidator, args as Value);
      if (failures.length > 0) {
        const detail = failures.slice(0, 3).map((f) => `${f.path}: ${f.message}`).join("; ");
        throw new ArgumentValidationError(
          `arguments to "${options.path ?? "<anonymous>"}" do not match validator: ${detail}`,
        );
      }
    }
    if (fn.type === "httpAction") return this.runActionFn<T>(fn, args, options, "httpAction");
    if (fn.type === "action") return this.runActionFn<T>(fn, args, options);
    const profile = profileFor(fn.type);
    // Resolve which shard this mutation runs on BEFORE opening the transaction. Only mutations
    // that declare `shardBy` are routed; a query or a no-`shardBy` mutation runs on "default"
    // (all guards short-circuit). The resolved value is canonicalized + jump-hashed by id-codec.
    const numShards = options.numShards ?? 1;
    const privileged = options.privileged ?? false;
    const shardDeclared = fn.type === "mutation" && fn.shardBy !== undefined;
    let shardId: ShardId = DEFAULT_SHARD;
    if (shardDeclared) {
      let shardKeyValue: unknown;
      const shardBy = fn.shardBy!;
      if (typeof shardBy === "string") {
        shardKeyValue = (args as Record<string, unknown> | null | undefined)?.[shardBy];
      } else {
        try {
          shardKeyValue = shardBy(args);
        } catch (e) {
          throw new Error(
            `shardBy resolver for "${options.path ?? "<anonymous>"}" threw: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      shardId = shardIdForKeyValue(shardKeyValue, numShards);
    } else if (privileged && options.shardId !== undefined) {
      // Privileged override (admin/system layer): the ONLY way a privileged run reaches a
      // non-default ring, since it skips shardBy declaration. Non-privileged callers can't set
      // this — their shard comes solely from shardBy (one-doc-one-ring invariant).
      shardId = options.shardId;
    }
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

    // Per-shard write routing (fleet Tier 2): the ONE chokepoint. Now that `shardId` is resolved
    // (from `shardBy` OR a privileged `options.shardId`), forward the mutation to the shard's owner
    // instead of committing locally when this node doesn't own it. Because this sits AFTER
    // resolution, EVERY path routes: WS mutations, `/api/run`, an action's inner `ctx.runMutation`
    // (via `invoke`), and the scheduler/driver path (which calls `run()` directly and used to
    // bypass routing — the node-killing driver hazard this fixes). Queries are never routed
    // (`fn.type` guard); boot steps opt out with `localOnly`. Actions never reach here (they return
    // via `runActionFn` above). `args` are converted `Value`s here, so re-serialize with
    // `convexToJson` for the JSON hop.
    const router = this.deps.writeRouter;
    if (fn.type === "mutation" && router && !options.localOnly && !router.isLocalWriter(shardId)) {
      try {
        // Pass `dedup` only when set, so a non-outbox forward keeps its exact 5-arg call shape
        // (the shipped `WriteRouter` contract + its tests) — the owner classifies only dedup writes.
        const fwd = options.dedup !== undefined
          ? await router.forward("mutation", options.path ?? "<anonymous>", convexToJson(args as Value), options.identity ?? null, shardId, options.dedup)
          : await router.forward("mutation", options.path ?? "<anonymous>", convexToJson(args as Value), options.identity ?? null, shardId);
        logEntry("ok");
        if (fwd.replay) {
          // The owner classified this dedup-keyed forward as a REPLAY (a recorded verdict) — no
          // commit happened. Surface it so the sync tier builds a `MutationReplay`, not a fresh ack.
          return {
            value: jsonToConvex(fwd.replay.value ?? null) as T,
            logs: [],
            committed: false,
            commitTs: fwd.replay.commitTs !== undefined ? BigInt(fwd.replay.commitTs) : 0n,
            readRanges: [],
            oplog: null,
            clientReplay: fwd.replay,
          };
        }
        return {
          value: jsonToConvex(fwd.value) as T,
          logs: [],
          committed: true,
          commitTs: fwd.commitTs !== undefined ? BigInt(fwd.commitTs) : 0n,
          readRanges: [],
          oplog: null,
        };
      } catch (e) {
        logEntry("error", e instanceof Error ? e.message : String(e));
        throw e;
      }
    }

    // Hybrid-node split-read seam (Fleet B3, D1): a query uses `queryPath`'s transactor +
    // QueryRuntime when configured; a mutation always uses the primary pair. Selected ONCE, here,
    // as a single unit — impossible to wire the transactor from one source and the QueryRuntime
    // from another (see `ExecutorDeps.queryPath`'s doc comment for why that split would corrupt
    // reads). Unset `queryPath` (or `fn.type === "mutation"`) → the primary pair, byte-identical.
    const txPath =
      fn.type === "query" && this.deps.queryPath && !options.primaryRead
        ? this.deps.queryPath
        : { transactor: this.deps.transactor, queryRuntime: this.deps.queryRuntime };

    try {
      const commit = await txPath.transactor.runInTransaction(async (txn) => {
        // Base context: NO policy enforcement. Used for the facade readers and the rule-context's own
        // db reader, so a policy's internal reads are never themselves re-gated (no re-entrancy).
        const baseKctx: KernelContext = {
          profile,
          txn,
          queryRuntime: txPath.queryRuntime,
          catalog: this.deps.catalog,
          snapshotTs: txn.snapshotTs,
          random: createSeededRandom(seed),
          logs: [],
          namespace: options.namespace ?? "",
          privileged,
          identity: options.identity ?? null,
          now: startedAt,
          policyRegistry: new Map(),
          getRuleContext: null,
          relationRegistry: { toMany: new Map(), toOne: new Map() },
          shardId,
          numShards,
          shardDeclared,
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
          const facade = Object.freeze(p.build({ db: preader, identity: baseKctx.identity, now: baseKctx.now, components: builtFacades, functionKind: options.functionKind }));
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
        // DLR 2b: `collectTrace` is only armed for a QUERY's own top-level kernel context — never
        // for the facade/rule-context `pctx`s above, so a component facade's internal collects can
        // never be mistaken for the calling function's own passthrough scan.
        const collectTrace = fn.type === "query" ? [] : undefined;
        // DLR 2c: `paginateTrace` is `collectTrace`'s counterpart for `db.query(...).paginate()`
        // calls, armed the same way and for the same reason (never for facade/rule-context `pctx`s).
        const paginateTrace = fn.type === "query" ? [] : undefined;
        // DLR: arm in-flight syscall tracking for a query so reads it initiated but didn't await
        // (a floating `.collect()` whose result the handler discarded) are still captured — see the
        // drain below and `KernelContext.inflight`.
        const inflight = fn.type === "query" ? new Set<Promise<string>>() : undefined;
        const kctx: KernelContext = { ...baseKctx, policyRegistry: options.policyRegistry ?? new Map(), getRuleContext, relationRegistry: options.relationRegistry ?? baseKctx.relationRegistry, collectTrace, paginateTrace, inflight };
        const channel = new InlineSyscallChannel(this.router, kctx);
        const db = fn.type === "query" ? new GuestDatabaseReader(channel) : new GuestDatabaseWriter(channel);
        guestCtx.db = db;

        const value = await fn.handler(guestCtx, args);
        // Drain any read the handler left in-flight (didn't await) BEFORE snapshotting the read set,
        // so its `recordScanReads`/`CollectTrace` have landed. A no-op when the handler awaited all
        // its reads (the set is already empty). Reads never spawn further reads, so this terminates.
        if (inflight !== undefined) {
          while (inflight.size > 0) {
            const pending = [...inflight];
            await Promise.allSettled(pending);
            for (const p of pending) inflight.delete(p);
          }
        }
        return { value: value as T, logs: kctx.logs, readRanges: txn.reads.toArray(), collectTrace: kctx.collectTrace };
      }, { shardId, commitMeta: options.commitMeta, origin: options.origin });
      // A mutation may return CommitThenThrow to persist its writes (e.g. a failed-attempt
      // counter) while still surfacing an error to the caller. The transaction is already
      // committed at this point, so throwing here is safe.
      if (commit.value.value instanceof CommitThenThrow) {
        logEntry("error", commit.value.value.message);
        // The transaction already committed (its fan-out fired, registering an origin-response gate
        // for a diff-capable subscribed origin). Stamp the commit's ts onto the error so the sync
        // handler's catch can release that gate — otherwise the node's reactive drain wedges forever
        // on a never-resolved gate (DLR 2b review). See `committedTsOfError`.
        const err = new Error(commit.value.value.message);
        (err as unknown as Record<PropertyKey, unknown>)[COMMITTED_TS_ERROR_KEY] = Number(commit.commitTs);
        throw err;
      }
      logEntry("ok");
      const diffableRange =
        fn.type === "query" ? classifyDiffableRange(commit.value.value, commit.value.collectTrace ?? [], commit.value.readRanges) : undefined;
      return {
        value: commit.value.value,
        logs: commit.value.logs,
        committed: commit.committed,
        commitTs: commit.commitTs,
        readRanges: commit.value.readRanges,
        oplog: commit.oplog,
        ...(diffableRange ? { diffableRange } : {}),
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
  private async runActionFn<T>(
    fn: RegisteredFunction,
    args: unknown,
    options: RunOptions,
    logKind: LogKind = "action",
  ): Promise<UdfResult<T>> {
    const clock = this.deps.now ?? Date.now;
    const startedAt = clock();
    const invoke = this.deps.invoke;
    if (!invoke) throw new Error("action execution requires an `invoke` runner (runtime wiring missing)");
    // RYOW for actions: track the max commitTs observed across this action's inner
    // runMutation/runAction invokes (queries never commit, so they're excluded). An inner
    // action's own commitTs already reflects ITS max (recursively, by this same tracking) —
    // so propagation through action → action → mutation chains falls out for free.
    let maxCommitTs = 0n;
    const run = (kind: "query" | "mutation" | "action") =>
      async <T = unknown>(ref: FunctionReference | string, a: Record<string, unknown> = {}): Promise<T> => {
        const path = resolveRef(ref);
        const res = await invoke(path, convexToJson(jsonToConvex(a as unknown as JSONValue) as Value) as JSONValue, { identity: options.identity ?? null });
        if (kind !== "query" && res.commitTs > maxCommitTs) maxCommitTs = res.commitTs;
        return res.value as T;
      };
    const runQuery = run("query");
    const runMutation = run("mutation");
    const runAction = run("action");
    const actionCtx: Record<string, unknown> = { runQuery, runMutation, runAction };

    // Component facades: only providers with a `buildAction` appear on the action ctx (a `build`-
    // only component — the common case, e.g. read-only facades — simply doesn't show up here; its
    // `build` is never invoked, since an action has no `db` for it to read through). Same
    // reserved-name collision check as the mutation path's `guestCtx` loop in `run()` above.
    const reserved = new Set(["runQuery", "runMutation", "runAction"]);
    for (const p of options.contextProviders ?? []) {
      if (!p.buildAction) continue;
      if (reserved.has(p.name) || p.name in actionCtx) throw new Error(`context provider "${p.name}" collides with a reserved ctx key`);
      actionCtx[p.name] = Object.freeze(p.buildAction({ runQuery, runMutation, runAction, identity: options.identity ?? null }));
    }
    try {
      const value = await fn.handler(actionCtx, args);
      this.deps.logSink?.push({ path: options.path ?? "<anonymous>", kind: logKind, ts: startedAt, durationMs: clock() - startedAt, status: "ok" });
      return { value: value as T, logs: [], committed: false, commitTs: maxCommitTs, readRanges: [], oplog: null };
    } catch (e) {
      this.deps.logSink?.push({ path: options.path ?? "<anonymous>", kind: logKind, ts: startedAt, durationMs: clock() - startedAt, status: "error", error: String(e) });
      throw e;
    }
  }
}
