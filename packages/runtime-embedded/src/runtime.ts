/**
 * `EmbeddedRuntime` — the Tier 0 engine in one process. It wires DocStore + transactor +
 * query engine + executor + sync handler together, drives the transactor→sync fan-out seam,
 * and hands out in-process loopback connections an unmodified client can talk to. This is the
 * core a single binary (`bun build --compile`) ships.
 *
 * Storage is injected (a `DocStore`), so the runtime is storage- and runtime-agnostic — the
 * CLI picks `BunSqliteAdapter` or `NodeSqliteAdapter`.
 */
import { namespaceForPath, type Driver, type DriverContext } from "@stackbase/component";
import { FunctionNotFoundError } from "@stackbase/errors";
import { decodeStorageTableId, decodeDocumentId, shardIdForKeyValue, DEFAULT_SHARD, type ShardId } from "@stackbase/id-codec";
import { writtenTablesFromRanges, serializeKeyRange, type SerializedKeyRange } from "@stackbase/index-key-codec";
import { jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import type { DocStore } from "@stackbase/docstore";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor, ShardedTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { InlineUdfExecutor, mutation, type GuestDatabaseWriter, type ContextProvider, type IndexCatalog, type LogSink, type RegisteredFunction, type UdfResult, type PolicyContextProvider, type TablePolicy, type RelationRegistry, type WriteRouter } from "@stackbase/executor";
import { SyncProtocolHandler, type SyncUdfExecutor } from "@stackbase/sync";
import {
  EmbeddedWriteFanout,
  InMemoryWriteFanoutAdapter,
  type EmbeddedWriteFanoutAdapter,
} from "./write-fanout";
import { createLoopbackConnection, type LoopbackConnection } from "./loopback";

/**
 * Public-gate check: a path is internal (client-forbidden) if ANY colon-delimited segment
 * starts with `_` — not just the whole path. `path.startsWith("_")` alone misses namespaced
 * component-internal paths like `scheduler:_enqueue` (the string starts with "s"), letting a
 * raw client dispatch privileged jobs directly. Blocks `_system:*`/`_admin:*` too (those have
 * their own privileged/trusted entrypoints — `runSystem`/`runAdmin` — and must stay off this
 * public surface). Do NOT use this to gate `invoke` (trusted server re-entrancy for actions'
 * ctx.runQuery/runMutation/runAction) or the driver's `runFunction` — both MUST still reach
 * `_`-prefixed modules.
 */
function isInternalPath(path: string): boolean {
  return path.split(":").some((seg) => seg.startsWith("_"));
}

/**
 * Single source of truth for building the tableNumber→name map (`fullTableName → tableNumber`
 * inverted) — used both by `create()` (seeding the map before the instance exists) and by the
 * instance method `setTableNumbers` (rebuilding it after an additive deploy), so the two never
 * drift by duplicating the loop.
 */
function rebuildTableNumberToName(map: Map<number, string>, tableNumbers: Record<string, number>): void {
  map.clear();
  for (const [name, num] of Object.entries(tableNumbers)) map.set(num, name);
}

/**
 * Fleet write-routing seam (Tier 2), PER-SHARD. Defined in `@stackbase/executor` (where the
 * per-shard forward chokepoint on `ExecutorDeps.writeRouter` references it, avoiding a circular dep
 * back to this package) and re-exported here as the core seam `@stackbase/fleet` implements. A node
 * that doesn't own a mutation's resolved shard forwards it to that shard's owner; queries are never
 * routed. Actions still forward wholesale at the runtime level (below) to the default-shard holder —
 * an action's INNER mutations then route per-shard from wherever the action runs. See
 * `InlineUdfExecutor.run`'s routing hook.
 */
export type { WriteRouter } from "@stackbase/executor";

export interface EmbeddedRuntimeOptions {
  store: DocStore;
  catalog: IndexCatalog;
  modules: Record<string, RegisteredFunction>;
  /** Privileged built-in functions (`_system:*`). Kept off the public run/sync surface. */
  systemModules?: Record<string, RegisteredFunction>;
  /** Privileged admin functions (`_admin:*`). Served over the admin sync channel. */
  adminModules?: Record<string, RegisteredFunction>;
  /** Validate an admin key presented via `SetAdminAuth`. Defaults to `() => false`. */
  verifyAdmin?: (key: string) => boolean;
  /** Set of component names; used to resolve the namespace for each function path. */
  componentNames?: ReadonlySet<string>;
  /** Swap the Tier 0 in-memory fan-out for a cross-process adapter (no app-code change). */
  fanoutAdapter?: EmbeddedWriteFanoutAdapter;
  originId?: string;
  logSink?: LogSink;
  /** Context providers contributed by composed components; attached as ctx[name] on every function call. */
  contextProviders?: ReadonlyArray<ContextProvider>;
  /** Row-policy registry contributed by components; enforced on every non-privileged run. */
  policyRegistry?: ReadonlyMap<string, TablePolicy>;
  /** Policy context providers contributed by components; used to build rule context for row policies. */
  policyProviders?: ReadonlyArray<PolicyContextProvider>;
  /** Declared relations, consulted by the kernel when resolving relation predicates. */
  relationRegistry?: RelationRegistry;
  /** Wall-clock source; defaults to `Date.now`. Injected for deterministic testing. */
  now?: () => number;
  /** Component boot steps to run once at create, namespaced + non-user (before serving traffic). */
  bootSteps?: { name: string; run: (ctx: { db: GuestDatabaseWriter; now: number }) => Promise<void> }[];
  /** Component drivers to start once at create, after boot steps + the commit fan-out are wired. */
  drivers?: Driver[];
  /**
   * `fullTableName → tableNumber` (the same map `composeComponents`/`loadProject` produce).
   * Used ONLY to translate the encoded storage-table ids on `adapter.subscribe`'s commit payload
   * (e.g. `"3"`) back into full names (e.g. `"scheduler/jobs"`) before handing them to driver
   * `onCommit` callbacks — drivers filter `inv.tables` by name (see `components/scheduler/src/
   * driver.ts`), and a raw storage id never matches. Optional: a runtime with no components (or
   * whose drivers don't inspect `inv.tables`) can omit it and driver callbacks just see raw ids.
   */
  tableNumbers?: Record<string, number>;
  /**
   * Route mutations/actions to another node instead of executing them locally, when
   * `writeRouter.isLocalWriter()` is false. Applies to EVERY mutation/action entry point (the
   * WS `syncExecutor.runMutation`/`runAction` and the public `run`/`runAction` methods) —
   * queries are never routed. See `WriteRouter`.
   */
  writeRouter?: WriteRouter;
  /**
   * Skip starting component drivers at `create()` time; call the returned instance's
   * `startDrivers()` later instead. For a fleet node that boots as a non-writer and only
   * wants drivers running once/if it becomes the writer.
   */
  deferDrivers?: boolean;
  /**
   * Number of shards to run (Shards B2a). When `> 1`, the runtime builds ONE `ShardedTransactor`
   * (N independent per-shard mutexes + OCC rings + oracles) over the store instead of the
   * single-shard `SingleWriterTransactor`, so mutations routed to different shards commit in
   * parallel. Unset / `1` → the single-shard transactor, byte-identical to before (the existing
   * suites are the proof). The executor resolves each mutation's shard (`shardBy`) and passes it
   * through `runInTransaction({ shardId })`; a fleet writer pairs this with the per-shard commit
   * pool so different shards' commits are genuinely concurrent Postgres transactions.
   */
  numShards?: number;
  /**
   * Hybrid-node split-read seam (Fleet B3, D1). When set, `create()` builds a SECOND, separate
   * query-path transactor (`SingleWriterTransactor` — queries never commit, so no sharding is
   * needed here regardless of the write side) + `QueryRuntime` over this store, seeded from ITS
   * OWN `maxTimestamp()` (not the write store's) and wired onto `ExecutorDeps.queryPath`, so
   * `fn.type === "query"` runs against `queryStore` instead of `store`. Its oracle is advanced
   * ONLY by `observeTimestamp` (see below) — never by this runtime's own local commits, which
   * only ever land on the WRITE store. Unset → `queryPath` is never built; every query runs
   * against `store` through the primary pair, byte-identical to before this option existed.
   */
  queryStore?: DocStore;
  /**
   * Hybrid-node RYOW gate (Fleet B3, D2). Awaited in the runtime's serial fan-out `drain()`
   * BEFORE each queued invalidation's `handler.notifyWrites` — e.g. a hybrid node's
   * `tailer.waitFor(commitTs)`, so a locally-committed mutation's subscription re-runs don't fire
   * against a replica that hasn't applied that commit yet. A rejection is caught and logged; the
   * drain loop continues to the next queued invalidation rather than wedging the whole queue on
   * one bad wait. Unset → `drain()` is byte-identical to before this hook existed.
   */
  beforeNotify?: (commitTs: bigint) => Promise<void>;
}

/** The minimal timestamp-observer seam `observeTimestamp` delegates to — a `MonotonicTimestampOracle`
 *  (single-shard) or a `ShardedTransactor` (which fans a learned ts to every shard oracle). */
interface TimestampObserver {
  observeTimestamp(ts: bigint): void;
}

export class EmbeddedRuntime {
  private sessionCounter = 0;

  private constructor(
    readonly store: DocStore,
    readonly executor: InlineUdfExecutor,
    readonly handler: SyncProtocolHandler,
    readonly writeFanoutAdapter: EmbeddedWriteFanoutAdapter,
    private readonly modules: Record<string, RegisteredFunction>,
    private readonly systemModules: Record<string, RegisteredFunction>,
    private readonly adminModules: Record<string, RegisteredFunction>,
    private readonly componentNames: ReadonlySet<string>,
    private readonly contextProviders: ReadonlyArray<ContextProvider>,
    private readonly policyRegistry: ReadonlyMap<string, TablePolicy>,
    private readonly policyProviders: ReadonlyArray<PolicyContextProvider>,
    private readonly relationRegistry: RelationRegistry | undefined,
    private readonly drivers: ReadonlyArray<Driver>,
    private readonly timers: Map<number, ReturnType<typeof setTimeout>>,
    /**
     * Inverse of `tableNumbers` (tableNumber → fullTableName). Mutable (not `readonly`) so
     * `setTableNumbers` can rebuild it in place after an additive deploy — the very same `Map`
     * object `create()`'s `namesForCommit` closure captured, so mutating it here (rather than
     * reassigning the field) keeps that closure correct without any circular-reference dance.
     */
    private tableNumberToName: Map<number, string>,
    /** The WRITE transactor's timestamp observer (the single-shard oracle, or the
     *  `ShardedTransactor` itself). `observeTimestamp` delegates to this UNLESS `queryOracle` is
     *  set (see it below) — this oracle's own local commits always advance it directly via
     *  `ShardWriter.commit`'s `oracle.publishCommitted`; `observeTimestamp` is the SEPARATE
     *  fleet-follower/tailer-observation channel, which a hybrid node must NOT point back at the
     *  write oracle (D1 — own local commits must never advance the query oracle, and observed
     *  foreign timestamps must never advance the write oracle either, once a hybrid has a real
     *  query-path oracle of its own). */
    private readonly oracle: TimestampObserver,
    /** Fleet B3 (D1): the QUERY-path oracle, set only when `EmbeddedRuntimeOptions.queryStore` was
     *  configured. When set, `observeTimestamp` routes to THIS oracle instead of `oracle` — its
     *  purpose is tailer post-apply feeding (a hybrid node's replica-backed query snapshot rises
     *  only as the tailer confirms applied writes), never this runtime's own local commits (those
     *  land on the write store and advance `oracle` directly, as shipped). Undefined when
     *  `queryStore` is unset → `observeTimestamp` keeps the exact shipped write-oracle routing. */
    private readonly queryOracle: TimestampObserver | undefined,
    /** The write path — retained so a fleet writer can take a shard's commit mutex non-blockingly
     *  (`tryRunExclusiveOnShard`) to close idle frontiers without racing that shard's own commits. */
    private readonly transactor: SingleWriterTransactor | ShardedTransactor,
    /** Threaded from `create()` so `startDrivers()` can start deferred drivers later. */
    private readonly driverCtx: DriverContext,
    /** Mutable: false when `deferDrivers` was set and `startDrivers()` hasn't run yet. */
    private driversStarted: boolean,
    /** When set and `isLocalWriter()` is false, every mutation/action entry point forwards
     *  through it instead of executing locally. Queries never consult this. */
    private readonly writeRouter: WriteRouter | undefined,
    /** Shards B2a (T5): the SAME resolved count `create()` used to build the transactor and every
     *  closure's `RunOptions.numShards` — instance methods (`run`/`runAction`/`runHttpAction`/
     *  `runSystem`/`runAdmin`) thread it through here so a call made AFTER construction routes
     *  identically to one made during `create()`. Defaults to 1 (byte-identical to before) when
     *  `EmbeddedRuntimeOptions.numShards` is unset. */
    private readonly numShards: number,
    /** The SAME catalog the executor/kernel enforce ownership against — so `runSystem`'s privileged
     *  doc-mutation routing (`resolveDocMutationShard`) reads a table's `shardKey` from the exact
     *  source of truth the guards use, and can never disagree with them. */
    private readonly catalog: IndexCatalog,
  ) {}

  static async create(options: EmbeddedRuntimeOptions): Promise<EmbeddedRuntime> {
    await options.store.setupSchema();
    // Mirror the primary store's schema setup for `queryStore` (Fleet B3, D1) — idempotent on both
    // backends (SQLite `CREATE TABLE IF NOT EXISTS`; Postgres swallows the duplicate-object race),
    // so a caller handing in an already-initialized replica pays nothing extra, while a fresh store
    // (e.g. a test, or a from-scratch replica) doesn't footgun on missing tables.
    if (options.queryStore) await options.queryStore.setupSchema();

    const adapter = options.fanoutAdapter ?? new InMemoryWriteFanoutAdapter();
    const fanout = new EmbeddedWriteFanout(adapter, options.originId ?? "embedded");

    // Recover the timestamp high-water mark from persisted data, so snapshot reads after a
    // restart see existing documents (a fresh oracle at 0 would read `ts <= 0` and find nothing).
    const startTs = await options.store.maxTimestamp();
    // Shards B2a: with numShards > 1, one `ShardedTransactor` (per-shard mutexes/rings/oracles) so
    // cross-shard commits run in parallel; else the single-shard transactor, byte-identical to before.
    // `observeTimestamp` (fleet follower catch-up + promotion) delegates to whichever we build — the
    // ShardedTransactor fans a learned ts to every shard oracle; the single oracle takes it directly.
    let transactor: SingleWriterTransactor | ShardedTransactor;
    let oracle: TimestampObserver;
    if ((options.numShards ?? 1) > 1) {
      const sharded = new ShardedTransactor(options.store, { fanout });
      sharded.observeTimestamp(startTs); // floor every shard oracle at the recovered high-water mark
      transactor = sharded;
      oracle = sharded;
    } else {
      const singleOracle = new MonotonicTimestampOracle(startTs);
      transactor = new SingleWriterTransactor(options.store, singleOracle, { fanout });
      oracle = singleOracle;
    }
    const queryRuntime = new QueryRuntime(options.store);

    // Hybrid-node split-read seam (Fleet B3, D1): when `queryStore` is configured, build a SEPARATE
    // query-path transactor + QueryRuntime over it. Queries never commit, so a plain
    // `SingleWriterTransactor` is the right shape regardless of whether the WRITE side is sharded —
    // this reuses the sync-node construction (a query transactor over a replica-backed store). Its
    // oracle seeds from `queryStore`'s OWN `maxTimestamp()` (not the write store's `startTs` above)
    // and then rides ONLY `observeTimestamp` (below) — never this runtime's own local commits, which
    // land on `options.store` and advance `oracle` (the write oracle) directly, unaffected by this.
    // Unset `queryStore` → `queryPath`/`queryOracle` stay undefined: `ExecutorDeps.queryPath` is
    // never set, and `observeTimestamp` keeps the exact shipped write-oracle routing (see below).
    let queryPath: { transactor: SingleWriterTransactor; queryRuntime: QueryRuntime } | undefined;
    let queryOracle: TimestampObserver | undefined;
    if (options.queryStore) {
      const queryStartTs = await options.queryStore.maxTimestamp();
      const qOracle = new MonotonicTimestampOracle(queryStartTs);
      const queryTransactor = new SingleWriterTransactor(options.queryStore, qOracle);
      queryPath = { transactor: queryTransactor, queryRuntime: new QueryRuntime(options.queryStore) };
      queryOracle = qOracle;
    }

    // Shards B2a (T5): the SAME resolved count that decided the transactor above must reach every
    // `executor.run` call site's `RunOptions.numShards` — the executor/kernel shard resolution (T3)
    // defaults `numShards` to 1 there, which makes every guard short-circuit onto "default" no matter
    // how many shards the transactor actually runs. Captured once here; every closure below and every
    // instance method (via the constructor field) passes this same value.
    const numShards = options.numShards ?? 1;

    // `invoke` is TRUSTED server re-entrancy for actions' `ctx.runQuery`/`runMutation`/`runAction`:
    // it resolves ANY registered path, including `_`-prefixed component-internal modules — unlike
    // the public `run`/`runAction` below, which block `_`. The executor is constructed before
    // `contextProviders`/`policyRegistry`/etc. below exist and before `modules` is populated, so
    // `invoke` reads them through a mutable closure var (`executorRef`) to break the cycle.
    let executorRef: InlineUdfExecutor;
    const invoke = async (path: string, args: JSONValue, opts?: { identity?: string | null }): Promise<UdfResult> => {
      const fn = modules[path];
      if (!fn) throw new FunctionNotFoundError(`unknown function: ${path}`);
      return executorRef.run(fn, jsonToConvex(args), {
        path,
        namespace: namespaceForPath(path, componentNames),
        contextProviders,
        policyRegistry,
        policyProviders,
        relationRegistry,
        functionKind,
        identity: opts?.identity ?? null,
        numShards,
      });
    };
    const executor = new InlineUdfExecutor({ transactor, queryRuntime, catalog: options.catalog, logSink: options.logSink, now: options.now, invoke, writeRouter: options.writeRouter, queryPath });
    executorRef = executor;

    // Run component boot steps once, before serving: a namespaced, non-user mutation per step.
    // `localOnly: true` bypasses the executor's per-shard write router — a boot step seeds this
    // node's OWN store before it's ready to be any shard's owner; without the flag a fleet node
    // that isn't the default-shard owner would forward its own boot seed to a peer (or fail).
    for (const step of options.bootSteps ?? []) {
      const bootFn = mutation(async (ctx) => {
        await step.run({ db: ctx.db as unknown as GuestDatabaseWriter, now: ctx.now() });
        return null;
      });
      await executor.run(bootFn, {}, { path: `_boot:${step.name}`, namespace: step.name, identity: null, numShards, localOnly: true });
    }

    // A mutable map the closures read, so `setModules` hot-swaps functions in place
    // (preserving the store, oracle, and transactor — no data loss on reload).
    const componentNames = options.componentNames ?? new Set<string>();
    const contextProviders = options.contextProviders ?? [];
    const policyRegistry = options.policyRegistry ?? new Map();
    const policyProviders = options.policyProviders ?? [];
    const relationRegistry = options.relationRegistry;
    const modules: Record<string, RegisteredFunction> = { ...options.modules };
    const systemModules: Record<string, RegisteredFunction> = { ...(options.systemModules ?? {}) };
    const adminModules: Record<string, RegisteredFunction> = { ...(options.adminModules ?? {}) };
    // Resolves a target path's REAL registered kind — threaded onto every `ComponentContext` so
    // component facades (e.g. `@stackbase/scheduler`'s `kindOf`) can tag a job's
    // kind:"mutation"|"action" accurately instead of guessing. See `ComponentContext.functionKind`'s
    // doc comment (packages/executor/src/executor.ts). A plain lookup against the SAME mutable
    // `modules` map `setModules` hot-swaps in place, so it stays correct across a dev reload.
    const functionKind = (path: string): "query" | "mutation" | "action" | "httpAction" | undefined => modules[path]?.type;
    const resolve = (path: string): RegisteredFunction => {
      if (isInternalPath(path)) throw new FunctionNotFoundError(`unknown function: ${path}`);
      const fn = modules[path];
      if (!fn) throw new FunctionNotFoundError(`unknown function: ${path}`);
      return fn;
    };

    const syncExecutor: SyncUdfExecutor = {
      async runQuery(path, args, identity) {
        const r = await executor.run(resolve(path), jsonToConvex(args), { path, namespace: namespaceForPath(path, componentNames), contextProviders, policyRegistry, policyProviders, relationRegistry, functionKind, identity: identity ?? null, numShards });
        return {
          value: r.value as Value,
          tables: writtenTablesFromRanges(r.readRanges),
          readRanges: r.readRanges.map(serializeKeyRange),
        };
      },
      async runMutation(path, args, identity) {
        const fn = resolve(path);
        // Per-shard write routing now lives at the executor chokepoint (`executor.run` forwards a
        // mutation whose resolved shard this node doesn't own — see `InlineUdfExecutor.run`). The
        // old runtime-level `writeRouter` check here was BEFORE shard resolution and so bypassed the
        // driver/scheduler path; it is removed as superseded. A forwarded run comes back with a null
        // oplog, so `tables`/`writeRanges` are empty — the same shape this path reported for a
        // forwarded write before.
        const r = await executor.run(fn, jsonToConvex(args), { path, namespace: namespaceForPath(path, componentNames), contextProviders, policyRegistry, policyProviders, relationRegistry, functionKind, identity: identity ?? null, numShards });
        return {
          value: r.value as Value,
          tables: r.oplog?.writtenTables ?? [],
          writeRanges: r.oplog?.writtenRanges ?? [],
          // `commitTs` (B2b, T2): a LOCAL commit reports it via `r.oplog.commitTs`; a FORWARDED
          // mutation has no local oplog (null), but the executor's forward branch already threads
          // the owner's real commitTs onto `r.commitTs` itself (see `InlineUdfExecutor.run`) — fall
          // back to that instead of silently reporting 0, so a forwarded sharded write's commitTs
          // reaches this path the same way a local one's does.
          commitTs: Number(r.oplog?.commitTs ?? r.commitTs ?? 0n),
        };
      },
      async runAdminQuery(path, args) {
        const fn = adminModules[path];
        if (!fn) throw new Error(`unknown admin function: ${path}`);
        const r = await executor.run(fn, jsonToConvex(args), { path, privileged: true, numShards });
        return { value: r.value as Value, tables: writtenTablesFromRanges(r.readRanges), readRanges: r.readRanges.map(serializeKeyRange) };
      },
      async runAction(path, args, identity) {
        // `resolve` is the SAME public gate `runQuery`/`runMutation` use above — it throws on
        // `_`-prefixed / namespaced-internal paths, so a client Action cannot reach internal
        // modules (e.g. `scheduler:_enqueue`). Also enforce the action-only type check, matching
        // the instance `runAction` (Task 1)'s public gate.
        const fn = resolve(path);
        if (fn.type !== "action") throw new Error(`${path} is not an action`);
        // Actions still forward WHOLESALE at the runtime level (not per-shard: an action has no
        // shard of its own), targeted at the default-shard holder. Once it runs on that writer-ish
        // node, its inner `ctx.runMutation`s route per-shard through the executor chokepoint.
        if (options.writeRouter && !options.writeRouter.isLocalWriter(DEFAULT_SHARD)) {
          const res = await options.writeRouter.forward("action", path, args, identity ?? null, DEFAULT_SHARD);
          return { value: jsonToConvex(res.value) as Value };
        }
        const r = await executor.run(fn, jsonToConvex(args), { path, namespace: namespaceForPath(path, componentNames), contextProviders, policyRegistry, policyProviders, relationRegistry, functionKind, identity: identity ?? null, numShards });
        return { value: r.value as Value };
      },
    };

    // Reactivity is driven by the write fan-out (not inline in the mutation handler), so a
    // commit from ANY path — WebSocket mutation OR `runtime.run()` / HTTP `/api/run` —
    // invalidates live subscriptions. The async drain serializes notifies and runs them after
    // the current call stack (so a MutationResponse is sent before its Transition).
    const handler = new SyncProtocolHandler(syncExecutor, { autoNotifyOnMutation: false, verifyAdmin: options.verifyAdmin });
    const queue: Array<{ tables: string[]; ranges: import("@stackbase/index-key-codec").SerializedKeyRange[]; commitTs: number }> = [];
    let draining = false;
    const drain = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        while (queue.length > 0) {
          const inv = queue.shift()!;
          // Hybrid RYOW gate (Fleet B3, D2): awaited BEFORE this invalidation's `notifyWrites`, so
          // e.g. a hybrid node's `tailer.waitFor(commitTs)` can hold a locally-committed mutation's
          // subscription re-run until the replica-backed query path has actually applied it — the
          // removes-the-briefly-stale-re-run gate. A throwing/rejecting hook is caught and logged;
          // one bad wait must not wedge every OTHER queued invalidation behind it forever.
          if (options.beforeNotify) {
            try {
              await options.beforeNotify(BigInt(inv.commitTs));
            } catch (e) {
              console.error("[runtime] beforeNotify hook threw:", e);
            }
          }
          await handler.notifyWrites(inv);
        }
      } finally {
        draining = false;
      }
    };

    // Driver lifecycle: component drivers wake on every committed write (across the whole
    // runtime, not just their own tables — a driver decides for itself what it cares about)
    // and/or on wall-clock timers. Wired to the SAME commit fan-out as `notifyWrites`, below.
    const commitSubs = new Set<(inv: { tables: string[]; ranges: readonly SerializedKeyRange[]; commitTs: number }) => void>();
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    let timerSeq = 0;
    const driverCtx: DriverContext = {
      runFunction: async (path, args) => {
        const fn = modules[path];
        if (!fn) throw new Error(`driver: unknown function ${path}`);
        const ns = namespaceForPath(path, componentNames);
        const res = await executor.run(fn, jsonToConvex(args), {
          path,
          namespace: ns,
          contextProviders,
          policyRegistry,
          policyProviders,
          relationRegistry,
          functionKind,
          identity: null,
          privileged: true,
          numShards,
        });
        return res.value;
      },
      onCommit: (cb) => {
        commitSubs.add(cb);
        return () => commitSubs.delete(cb);
      },
      setTimer: (atMs, cb) => {
        const h = ++timerSeq;
        timers.set(h, setTimeout(cb, Math.max(0, atMs - (options.now?.() ?? Date.now()))));
        return h;
      },
      clearTimer: (h) => {
        const t = timers.get(h);
        if (t) {
          clearTimeout(t);
          timers.delete(h);
        }
      },
      now: () => options.now?.() ?? Date.now(),
    };

    // Inverse of `tableNumbers` (tableNumber → fullTableName), seeded here from
    // `options.tableNumbers` and later rebuildable via the instance method `setTableNumbers`
    // (after an additive deploy): `payload.tables` (from `adapter.subscribe`) carries ENCODED
    // STORAGE-TABLE IDS (`encodeStorageTableId`'s output, e.g. `"3"`), not full table names — the
    // sync path (`queue`/`notifyWrites` above) works with those ids directly via range
    // intersection, but drivers filter `inv.tables` by full name (e.g. `t.startsWith("scheduler/")`),
    // so the driver fan-out below must translate. This `Map` object is also handed to the
    // constructor as `this.tableNumberToName` — `setTableNumbers` mutates it in place (not a
    // reassignment), so this closure's `namesForCommit` stays correct after a later rebuild.
    const tableNumberToName = new Map<number, string>();
    rebuildTableNumberToName(tableNumberToName, options.tableNumbers ?? {});
    const namesForCommit = (tableIds: readonly string[]): string[] =>
      tableIds.map((id) => {
        try {
          return tableNumberToName.get(decodeStorageTableId(id)) ?? id;
        } catch {
          return id; // not a decodable storage id — pass through rather than drop
        }
      });

    adapter.subscribe((payload) => {
      queue.push({ tables: payload.tables, ranges: payload.ranges, commitTs: payload.commitTs });
      void drain();
      if (commitSubs.size > 0) {
        const tables = namesForCommit(payload.tables);
        for (const cb of commitSubs) {
          try {
            cb({ tables, ranges: payload.ranges, commitTs: payload.commitTs });
          } catch (e) {
            // A driver's onCommit must never starve other drivers of the commit signal.
            console.error("[runtime] driver onCommit callback threw:", e);
          }
        }
      }
    });

    if ((options.drivers?.length ?? 0) > 0 && !options.tableNumbers) {
      // Without `tableNumbers`, `namesForCommit` above can't translate the encoded storage-table
      // ids a real commit carries back into full names, so `inv.tables` a driver's `onCommit`
      // callback sees never matches a `t.startsWith("scheduler/")`-style filter — reactive wake
      // silently degrades to timer-only. Warn once (per `create()` call) rather than fail: a
      // driver relying purely on its own periodic timer still works, just not with ~0 latency.
      console.warn(
        "[runtime] drivers registered but no `tableNumbers` provided — driver reactive wake (onCommit) will not match table-name filters; drivers will fall back to their own timers only.",
      );
    }

    const drivers = options.drivers ?? [];
    // `deferDrivers` skips this: the caller starts them later via the instance's
    // `startDrivers()` (e.g. a fleet node that boots as a non-writer and only wants drivers
    // running once/if it becomes the writer).
    let driversStarted = false;
    if (!options.deferDrivers) {
      for (const d of drivers) await d.start(driverCtx);
      driversStarted = true;
    }

    return new EmbeddedRuntime(
      options.store, executor, handler, adapter, modules, systemModules, adminModules, componentNames,
      contextProviders, policyRegistry, policyProviders, relationRegistry, drivers, timers, tableNumberToName,
      oracle, queryOracle, transactor, driverCtx, driversStarted, options.writeRouter, numShards, options.catalog,
    );
  }

  /**
   * Resolves a target path's REAL registered kind against the live `this.modules` map — same
   * resolver shape as `create()`'s local `functionKind` closure, but bound to the instance so it
   * stays correct across `setModules` hot-swaps. See `ComponentContext.functionKind`'s doc
   * comment (packages/executor/src/executor.ts).
   */
  private functionKind = (path: string): "query" | "mutation" | "action" | "httpAction" | undefined => this.modules[path]?.type;

  /** Hot-swap the function map (dev reload) without disturbing the store/transactor. */
  setModules(modules: Record<string, RegisteredFunction>): void {
    for (const key of Object.keys(this.modules)) delete this.modules[key];
    Object.assign(this.modules, modules);
  }

  /**
   * Rebuild the tableNumber→name map after an additive deploy so driver commit fan-out
   * (`namesForCommit` in `create()`, which closed over this same `Map` instance) keeps
   * translating newly-added tables' encoded storage ids to their full names correctly.
   * Additive deploys keep existing numbers, so this only ever adds entries in practice.
   */
  setTableNumbers(tableNumbers: Record<string, number>): void {
    rebuildTableNumberToName(this.tableNumberToName, tableNumbers);
  }

  /**
   * Live view of the registered app+component function paths. Reads the same mutable `modules`
   * map `setModules` hot-swaps in place, so counts stay correct across a dev reload or deploy
   * (the boot-time snapshot the server used to cache went stale after the first hot-swap).
   */
  functionPaths(): string[] {
    return Object.keys(this.modules);
  }

  /** Live view of the registered table names (mirrors `functionPaths`, reads the live map). */
  tableNames(): string[] {
    return [...this.tableNumberToName.values()];
  }

  /** Open an in-process connection an unmodified client can talk to. */
  connect(sessionId?: string): LoopbackConnection {
    return createLoopbackConnection(this.handler, sessionId ?? `session-${++this.sessionCounter}`);
  }

  /**
   * Synthesizes a `UdfResult` for a write forwarded to the writer node: `forward` only returns
   * the function's JSON result, not read ranges / an oplog, so those come back empty/zero here.
   * Shared by `run()` and `runAction()` — both route through the same `WriteRouter`.
   */
  private forwardedResult<T>(value: JSONValue): UdfResult<T> {
    return { value: jsonToConvex(value) as T, logs: [], committed: true, commitTs: 0n, readRanges: [], oplog: null };
  }

  /** Directly invoke a function (for HTTP routes / the CLI `run` command). A MUTATION routes
   *  per-shard inside the executor (`executor.run` forwards a shard this node doesn't own); an
   *  ACTION forwards wholesale here to the default-shard holder; queries always run locally. */
  async run<T = unknown>(
    path: string,
    args: JSONValue,
    opts?: { identity?: string | null; commitMeta?: Record<string, string> },
  ): Promise<UdfResult<T>> {
    if (isInternalPath(path)) throw new FunctionNotFoundError(`unknown function: ${path}`);
    const fn = this.modules[path];
    if (!fn) throw new FunctionNotFoundError(`unknown function: ${path}`);
    if (fn.type === "action" && this.writeRouter && !this.writeRouter.isLocalWriter(DEFAULT_SHARD)) {
      const res = await this.writeRouter.forward("action", path, args, opts?.identity ?? null, DEFAULT_SHARD);
      return this.forwardedResult<T>(res.value);
    }
    return this.executor.run<T>(fn, jsonToConvex(args), {
      path,
      namespace: namespaceForPath(path, this.componentNames),
      contextProviders: this.contextProviders,
      policyRegistry: this.policyRegistry,
      policyProviders: this.policyProviders,
      relationRegistry: this.relationRegistry,
      functionKind: this.functionKind,
      identity: opts?.identity ?? null,
      numShards: this.numShards,
      // Fleet B3, D3 (effectively-once forwarding): opaque commit metadata threaded straight through
      // to `Transactor.runInTransaction`'s `commitMeta` — meaningful only for a mutation that
      // actually commits (see `RunOptions.commitMeta`'s doc comment). `packages/cli`'s `/_fleet/run`
      // handler is the one caller that sets this, carrying a forwarded write's idempotency key.
      commitMeta: opts?.commitMeta,
    });
  }

  /** Directly invoke an action (for HTTP routes / the CLI `run` command). Public gate: blocks
   *  `_`-prefixed paths. Routes through `writeRouter` when set and this node isn't the writer. */
  async runAction<T = unknown>(path: string, args: JSONValue, opts?: { identity?: string | null }): Promise<UdfResult<T>> {
    if (isInternalPath(path)) throw new FunctionNotFoundError(`unknown function: ${path}`);
    const fn = this.modules[path];
    if (!fn) throw new FunctionNotFoundError(`unknown function: ${path}`);
    if (fn.type !== "action") throw new Error(`${path} is not an action`);
    if (this.writeRouter && !this.writeRouter.isLocalWriter(DEFAULT_SHARD)) {
      const res = await this.writeRouter.forward("action", path, args, opts?.identity ?? null, DEFAULT_SHARD);
      return this.forwardedResult<T>(res.value);
    }
    return this.executor.run<T>(fn, jsonToConvex(args), {
      path,
      namespace: namespaceForPath(path, this.componentNames),
      contextProviders: this.contextProviders,
      policyRegistry: this.policyRegistry,
      policyProviders: this.policyProviders,
      relationRegistry: this.relationRegistry,
      functionKind: this.functionKind,
      identity: opts?.identity ?? null,
      numShards: this.numShards,
    });
  }

  /** Directly invoke an httpAction (for the public HTTP router). Passes the raw `Request` through
   *  untouched and returns the handler's `Response`. Public gate: blocks `_`-prefixed paths. */
  async runHttpAction(path: string, request: Request, opts?: { identity?: string | null }): Promise<Response> {
    if (isInternalPath(path)) throw new FunctionNotFoundError(`unknown function: ${path}`);
    const fn = this.modules[path];
    if (!fn) throw new FunctionNotFoundError(`unknown function: ${path}`);
    if (fn.type !== "httpAction") throw new Error(`${path} is not an httpAction`);
    const result = await this.executor.run<Response>(fn, request as unknown as never, {
      path,
      namespace: namespaceForPath(path, this.componentNames),
      contextProviders: this.contextProviders,
      policyRegistry: this.policyRegistry,
      policyProviders: this.policyProviders,
      relationRegistry: this.relationRegistry,
      functionKind: this.functionKind,
      identity: opts?.identity ?? null,
      numShards: this.numShards,
    });
    return result.value;
  }

  /**
   * The privileged built-in doc mutations whose target is a USER table (and thus may be sharded).
   * These are the ONLY `runSystem` paths that need shard routing — every other `_system:*`/
   * `_storage:*`/`_test:*` built-in writes UNSHARDED component-internal tables, which are owned by
   * the default ring (INSERT from any ring; RMW on default), so they need no override.
   */
  private static readonly DOC_MUTATION_PATHS: ReadonlySet<string> = new Set([
    "_system:patchDocument",
    "_system:deleteDocument",
    "_system:insertDocument",
  ]);

  /** Run a privileged built-in (`_system:*`) function. Trusted callers only (the admin API).
   *  For a doc mutation on a user table, the target document's OWNING shard is resolved and passed
   *  through so the privileged write lands on the same ring a user's sharded mutation of that doc
   *  would — one-doc-one-ring. `opts.shardId` lets a trusted caller override the resolution. */
  async runSystem<T = unknown>(
    path: string,
    args: JSONValue,
    opts?: { shardId?: ShardId; commitMeta?: Record<string, string> },
  ): Promise<UdfResult<T>> {
    const fn = this.systemModules[path];
    if (!fn) throw new FunctionNotFoundError(`unknown system function: ${path}`);
    let shardId = opts?.shardId;
    if (shardId === undefined && this.numShards > 1 && EmbeddedRuntime.DOC_MUTATION_PATHS.has(path)) {
      shardId = await this.resolveDocMutationShard(path, args);
    }
    return this.executor.run<T>(fn, jsonToConvex(args), {
      path,
      privileged: true,
      numShards: this.numShards,
      shardId,
      // Fleet B3, D3: see `run()`'s doc comment above — the forwarded-`_system:*`-doc-mutation path
      // (an admin dashboard edit landing on a non-owner) threads the same idempotency key through.
      commitMeta: opts?.commitMeta,
    });
  }

  /**
   * Resolve the owning shard for a privileged admin doc mutation so the write commits on the SAME
   * ring a user's sharded mutation of that document would use (the one-doc-one-ring invariant).
   * Without this, a dashboard edit of a sharded doc runs on the default ring and forks the doc's
   * prev_ts chain against its home-shard writer — a permanent tailer halt + a silently-lost update.
   *
   * The shard-key field is IMMUTABLE after insert, so peeking the current doc's key value BEFORE the
   * transaction is race-free (its shard can't have changed by the time the txn opens). An unsharded
   * target (component tables, or app tables with no `.shardKey`) resolves to `"default"` — its RMW
   * ring per the same invariant. Called only for `DOC_MUTATION_PATHS` when `numShards > 1`.
   */
  private async resolveDocMutationShard(path: string, args: JSONValue): Promise<ShardId> {
    const a = args as Record<string, unknown>;
    if (path === "_system:insertDocument") {
      // INSERT: route by the shard-key value in the incoming fields (privileged uses the raw table name).
      const meta = this.catalog.getTable(a.table as string);
      if (!meta?.shardKey) return DEFAULT_SHARD;
      const fields = a.fields as Record<string, unknown> | undefined;
      return shardIdForKeyValue(fields?.[meta.shardKey], this.numShards);
    }
    // PATCH / DELETE: route by the EXISTING document's immutable shard-key value.
    const internalId = decodeDocumentId(a.id as string);
    const meta = this.catalog.getTableByNumber(internalId.tableNumber);
    if (!meta?.shardKey) return DEFAULT_SHARD;
    const latest = await this.store.get(internalId);
    if (!latest) return DEFAULT_SHARD; // missing → the system fn itself throws DocumentNotFound
    const doc = latest.value.value as Record<string, unknown>;
    return shardIdForKeyValue(doc[meta.shardKey], this.numShards);
  }

  /** Run a privileged admin built-in (`_admin:*`) once (e.g. for the HTTP fallback). Trusted callers only. */
  async runAdmin<T = unknown>(path: string, args: JSONValue): Promise<UdfResult<T>> {
    const fn = this.adminModules[path];
    if (!fn) throw new FunctionNotFoundError(`unknown admin function: ${path}`);
    return this.executor.run<T>(fn, jsonToConvex(args), { path, privileged: true, numShards: this.numShards });
  }

  /**
   * Stop the component drivers and clear their pending timers, resetting `driversStarted` so a later
   * `startDrivers()` can bring them back up. Shared by the driver-only `stopDriversOnly()` (B2b, D5)
   * and the full-shutdown `stopDrivers()` — the ONLY difference is whether the sync handler is also
   * disposed, so the two can never drift on how a driver is torn down.
   */
  private async stopDriversInternal(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const d of this.drivers) await d.stop?.();
    // Reset the flag (NOT one-way): a stop→start cycle must actually restart the drivers. The shipped
    // `driversStarted` flag was write-once (only ever flipped true), so a fleet node that relinquished
    // and later re-acquired the default shard would silently no-op the restart — the D5 regression.
    this.driversStarted = false;
  }

  /**
   * Stop all component drivers and clear all pending driver timers. Call on runtime shutdown.
   * ALSO disposes the sync handler's background flush sweep — this is the full-teardown path.
   */
  async stopDrivers(): Promise<void> {
    await this.stopDriversInternal();
    // Stop the sync handler's background flush sweep (per-session backpressure drain) on shutdown.
    this.handler.dispose();
  }

  /**
   * Driver-only stop (B2b, D5 — "drivers follow the default shard"): stop the scheduler/workflow/cron/
   * reaper drivers and clear their timers, WITHOUT disposing the sync handler. A fleet node that
   * relinquishes (or gracefully releases) the default shard keeps serving reads, subscriptions, and
   * mutations for every OTHER shard — only its drivers go quiet, because a different node now owns the
   * default ring the scheduler tables live on. Symmetric with `startDrivers()` and idempotent both
   * ways (the reset flag makes a later `startDrivers()` a real restart, and a second stop a no-op),
   * so callers never need to track whether drivers are currently running. Deliberately NEVER touches
   * `handler.dispose()` (the shipped `stopDrivers()` did — fatal on a default-relinquish, since the
   * node stays live).
   */
  async stopDriversOnly(): Promise<void> {
    await this.stopDriversInternal();
  }

  /**
   * Start component drivers deferred via `EmbeddedRuntimeOptions.deferDrivers`, OR restart them after
   * a `stopDriversOnly()` (B2b, D5). Idempotent — a second (or later) call is a no-op once drivers are
   * running, so callers don't need to track whether they've already called it (e.g. a fleet node
   * calling this on every default-shard acquisition attempt).
   */
  async startDrivers(): Promise<void> {
    if (this.driversStarted) return;
    this.driversStarted = true;
    for (const d of this.drivers) await d.start(this.driverCtx);
  }

  /**
   * Lets a non-writer fleet node advance its local timestamp oracle past timestamps it learns
   * from the writer's change stream, so its own next allocated timestamp (if/when it becomes
   * the writer) never collides with or precedes one it already observed.
   *
   * Fleet B3 (D1) routing: WITHOUT a `queryStore` (`queryOracle` undefined), this is the shipped
   * behavior — delegates straight to the WRITE oracle (`this.oracle`; a `ShardedTransactor` fans
   * it to every shard). WITH a `queryStore` configured, a hybrid node has a real query-path oracle
   * whose sole purpose IS tailer post-apply feeding — so this routes to `queryOracle` INSTEAD, and
   * the write oracle is left untouched by tailer observations (it advances only via this runtime's
   * own local commits, through `ShardWriter.commit`'s `oracle.publishCommitted`). Sharing one
   * oracle between the two would let a query snapshot ABOVE the replica's actual watermark and
   * read holes (D1's spec-review requirement) — this branch is what keeps them separate.
   *
   * This is the READ-PATH observer (tailer/follower freshness → query snapshot). Its write-path
   * counterpart, `observeWriteTimestamp` (below), always targets the WRITE oracle and exists
   * precisely because this method stopped feeding the write side once a hybrid has a query oracle.
   */
  observeTimestamp(ts: bigint): void {
    (this.queryOracle ?? this.oracle).observeTimestamp(ts);
  }

  /**
   * Advance the WRITE transactor's timestamp oracle(s) past `ts` — the write-path counterpart to
   * `observeTimestamp` above, and the pre-T1 semantics of what `observeTimestamp` used to do before
   * hybrid routing split the two. ALWAYS targets `this.oracle` (the write side), independent of
   * `queryStore`/`queryOracle` routing: a `ShardedTransactor` fans `ts` to every existing shard
   * oracle AND raises its `observedHighWater` floor (so a shard writer CREATED later seeds at-or-past
   * `ts`); the single-shard `MonotonicTimestampOracle` takes it directly.
   *
   * Purpose (distinct from `observeTimestamp`): re-floor the WRITE snapshot on a shard OWNERSHIP
   * CHANGE. On a hybrid node `observeTimestamp` feeds the QUERY oracle, so nothing feeds the write
   * oracle from foreign observations anymore. A shard this node held, RELEASED (its `ShardWriter`
   * stays in the transactor's Map — only the fleet epoch is dropped), and later RE-ACQUIRES would
   * keep that `ShardWriter`'s oracle frozen at this node's own last commit; the next mutation would
   * snapshot BELOW an interim owner's commits and an RMW handler would compute on stale state (the
   * durable chain stays intact via latest-`prev_ts`, but the update is semantically lost). The fleet
   * calls this on EVERY shard acquisition with the lease row's `frontier_ts` — which is >= every
   * prior commit on that shard by the fence invariant (the commit guard writes `frontier_ts =
   * GREATEST(frontier_ts, commitTs)` inside each commit txn) — so it is the exact correct floor.
   * Idempotent/monotone: a `ts` at or below the oracle's position is a no-op (harmless on a
   * fresh/never-released shard, and on every non-hybrid node where it is called uniformly too).
   */
  observeWriteTimestamp(ts: bigint): void {
    this.oracle.observeTimestamp(ts);
  }

  /**
   * Run `fn` under shard `shardId`'s commit mutex IFF it is free right now — the seam a fleet writer's
   * idle-frontier closer uses to publish a shard's frontier atomically with respect to that shard's
   * own commits (see `ShardedTransactor.tryRunExclusiveOnShard`). Returns `true` if `fn` ran, `false`
   * if a commit currently holds the mutex (skip; retry next beat). Total across sharded/single-shard
   * runtimes — the single-shard transactor ignores `shardId` and uses its one writer.
   */
  tryRunExclusiveOnShard(shardId: ShardId, fn: () => Promise<void>): Promise<boolean> {
    return this.transactor.tryRunExclusiveOnShard(shardId, fn);
  }
}

export function createEmbeddedRuntime(options: EmbeddedRuntimeOptions): Promise<EmbeddedRuntime> {
  return EmbeddedRuntime.create(options);
}
