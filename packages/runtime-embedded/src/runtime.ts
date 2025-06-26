/**
 * `EmbeddedRuntime` — the Tier 0 engine in one process. It wires DocStore + transactor +
 * query engine + executor + sync handler together, drives the transactor→sync fan-out seam,
 * and hands out in-process loopback connections an unmodified client can talk to. This is the
 * core a single binary (`bun build --compile`) ships.
 *
 * Storage is injected (a `DocStore`), so the runtime is storage- and runtime-agnostic — the
 * CLI picks `BunSqliteAdapter` or `NodeSqliteAdapter`.
 */
import { namespaceForPath } from "@stackbase/component";
import { FunctionNotFoundError } from "@stackbase/errors";
import { writtenTablesFromRanges, serializeKeyRange } from "@stackbase/index-key-codec";
import { jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import type { DocStore } from "@stackbase/docstore";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { InlineUdfExecutor, mutation, type GuestDatabaseWriter, type ContextProvider, type IndexCatalog, type LogSink, type RegisteredFunction, type UdfResult, type PolicyContextProvider, type TablePolicy, type RelationRegistry } from "@stackbase/executor";
import { SyncProtocolHandler, type SyncUdfExecutor } from "@stackbase/sync";
import {
  EmbeddedWriteFanout,
  InMemoryWriteFanoutAdapter,
  type EmbeddedWriteFanoutAdapter,
} from "./write-fanout";
import { createLoopbackConnection, type LoopbackConnection } from "./loopback";

export interface EmbeddedRuntimeOptions {
  store: DocStore;
  catalog: IndexCatalog;
  modules: Record<string, RegisteredFunction>;
  /** Privileged built-in functions (`_system:*`). Kept off the public run/sync surface. */
  systemModules?: Record<string, RegisteredFunction>;
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
    private readonly componentNames: ReadonlySet<string>,
    private readonly contextProviders: ReadonlyArray<ContextProvider>,
    private readonly policyRegistry: ReadonlyMap<string, TablePolicy>,
    private readonly policyProviders: ReadonlyArray<PolicyContextProvider>,
    private readonly relationRegistry: RelationRegistry | undefined,
  ) {}

  static async create(options: EmbeddedRuntimeOptions): Promise<EmbeddedRuntime> {
    await options.store.setupSchema();

    const adapter = options.fanoutAdapter ?? new InMemoryWriteFanoutAdapter();
    const fanout = new EmbeddedWriteFanout(adapter, options.originId ?? "embedded");

    // Recover the timestamp high-water mark from persisted data, so snapshot reads after a
    // restart see existing documents (a fresh oracle at 0 would read `ts <= 0` and find nothing).
    const startTs = await options.store.maxTimestamp();
    const transactor = new SingleWriterTransactor(options.store, new MonotonicTimestampOracle(startTs), { fanout });
    const queryRuntime = new QueryRuntime(options.store);
    const executor = new InlineUdfExecutor({ transactor, queryRuntime, catalog: options.catalog, logSink: options.logSink, now: options.now });

    // Run component boot steps once, before serving: a namespaced, non-user mutation per step.
    for (const step of options.bootSteps ?? []) {
      const bootFn = mutation(async (ctx) => {
        await step.run({ db: ctx.db as unknown as GuestDatabaseWriter, now: ctx.now() });
        return null;
      });
      await executor.run(bootFn, {}, { path: `_boot:${step.name}`, namespace: step.name, identity: null });
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
    const resolve = (path: string): RegisteredFunction => {
      if (path.startsWith("_")) throw new FunctionNotFoundError(`unknown function: ${path}`);
      const fn = modules[path];
      if (!fn) throw new FunctionNotFoundError(`unknown function: ${path}`);
      return fn;
    };

    const syncExecutor: SyncUdfExecutor = {
      async runQuery(path, args, identity) {
        const r = await executor.run(resolve(path), jsonToConvex(args), { path, namespace: namespaceForPath(path, componentNames), contextProviders, policyRegistry, policyProviders, relationRegistry, identity: identity ?? null });
        return {
          value: r.value as Value,
          tables: writtenTablesFromRanges(r.readRanges),
          readRanges: r.readRanges.map(serializeKeyRange),
        };
      },
      async runMutation(path, args, identity) {
        const r = await executor.run(resolve(path), jsonToConvex(args), { path, namespace: namespaceForPath(path, componentNames), contextProviders, policyRegistry, policyProviders, relationRegistry, identity: identity ?? null });
        return {
          value: r.value as Value,
          tables: r.oplog?.writtenTables ?? [],
          writeRanges: r.oplog?.writtenRanges ?? [],
          commitTs: Number(r.oplog?.commitTs ?? 0),
        };
      },
    };

    // Reactivity is driven by the write fan-out (not inline in the mutation handler), so a
    // commit from ANY path — WebSocket mutation OR `runtime.run()` / HTTP `/api/run` —
    // invalidates live subscriptions. The async drain serializes notifies and runs them after
    // the current call stack (so a MutationResponse is sent before its Transition).
    const handler = new SyncProtocolHandler(syncExecutor, { autoNotifyOnMutation: false });
    const queue: Array<{ tables: string[]; ranges: import("@stackbase/index-key-codec").SerializedKeyRange[]; commitTs: number }> = [];
    let draining = false;
    const drain = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        while (queue.length > 0) {
          const inv = queue.shift()!;
          await handler.notifyWrites(inv);
        }
      } finally {
        draining = false;
      }
    };
    adapter.subscribe((payload) => {
      queue.push({ tables: payload.tables, ranges: payload.ranges, commitTs: payload.commitTs });
      void drain();
    });

    return new EmbeddedRuntime(options.store, executor, handler, adapter, modules, systemModules, componentNames, contextProviders, policyRegistry, policyProviders, relationRegistry);
  }

  /** Hot-swap the function map (dev reload) without disturbing the store/transactor. */
  setModules(modules: Record<string, RegisteredFunction>): void {
    for (const key of Object.keys(this.modules)) delete this.modules[key];
    Object.assign(this.modules, modules);
  }

  /** Open an in-process connection an unmodified client can talk to. */
  connect(sessionId?: string): LoopbackConnection {
    return createLoopbackConnection(this.handler, sessionId ?? `session-${++this.sessionCounter}`);
  }

  /** Directly invoke a function (for HTTP routes / the CLI `run` command). */
  async run<T = unknown>(path: string, args: JSONValue, opts?: { identity?: string | null }): Promise<UdfResult<T>> {
    if (path.startsWith("_")) throw new FunctionNotFoundError(`unknown function: ${path}`);
    const fn = this.modules[path];
    if (!fn) throw new FunctionNotFoundError(`unknown function: ${path}`);
    return this.executor.run<T>(fn, jsonToConvex(args), {
      path,
      namespace: namespaceForPath(path, this.componentNames),
      contextProviders: this.contextProviders,
      policyRegistry: this.policyRegistry,
      policyProviders: this.policyProviders,
      relationRegistry: this.relationRegistry,
      identity: opts?.identity ?? null,
    });
  }

  /** Run a privileged built-in (`_system:*`) function. Trusted callers only (the admin API). */
  async runSystem<T = unknown>(path: string, args: JSONValue): Promise<UdfResult<T>> {
    const fn = this.systemModules[path];
    if (!fn) throw new FunctionNotFoundError(`unknown system function: ${path}`);
    return this.executor.run<T>(fn, jsonToConvex(args), { path, privileged: true });
  }
}

export function createEmbeddedRuntime(options: EmbeddedRuntimeOptions): Promise<EmbeddedRuntime> {
  return EmbeddedRuntime.create(options);
}
