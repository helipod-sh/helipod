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
import { createKernelRouter, InlineSyscallChannel, type KernelContext, type SyscallRouter } from "./kernel";
import { profileFor } from "./profile";
import { createSeededRandom } from "./seeded-random";
import { GuestDatabaseReader, GuestDatabaseWriter } from "./guest";
import type { IndexCatalog } from "./catalog";
import type { RegisteredFunction } from "./functions";
import type { LogKind, LogSink } from "./log-sink";

export interface ExecutorDeps {
  transactor: Transactor;
  queryRuntime: QueryRuntime;
  catalog: IndexCatalog;
  logSink?: LogSink;
  now?: () => number;
}

export interface ComponentContext {
  readonly db: GuestDatabaseReader;
  readonly identity: string | null;
  /** Wall-clock ms captured once at execution start (fixed per OCC attempt). */
  readonly now: number;
}

export interface ContextProvider {
  readonly name: string;
  /** The component's namespace; the facade's db reads here. */
  readonly namespace: string;
  readonly build: (cctx: ComponentContext) => Record<string, unknown>;
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
    if (fn.type === "action" || fn.type === "httpAction") {
      throw new Error(`the inline executor does not yet run ${fn.type} functions (M5 scope)`);
    }
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
        const kctx: KernelContext = {
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
        };
        const channel = new InlineSyscallChannel(this.router, kctx);
        const db = fn.type === "query" ? new GuestDatabaseReader(channel) : new GuestDatabaseWriter(channel);
        const guestCtx: Record<string, unknown> = { db, random: () => kctx.random.next(), now: () => kctx.now };
        for (const p of options.contextProviders ?? []) {
          if (p.name in guestCtx) throw new Error(`context provider "${p.name}" collides with a reserved ctx key`);
          // Two independent locks on writes: the facade gets a read-only GuestDatabaseReader (no write
          // methods), AND a query profile so the kernel's dbWrite gate is closed regardless of the caller's
          // type. A facade is the one sanctioned cross-namespace READ path — it must never write.
          const pctx: KernelContext = { ...kctx, namespace: p.namespace, privileged: false, profile: profileFor("query") };
          const preader = new GuestDatabaseReader(new InlineSyscallChannel(this.router, pctx));
          guestCtx[p.name] = Object.freeze(p.build({ db: preader, identity: kctx.identity, now: kctx.now }));
        }
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
}
