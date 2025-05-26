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

export interface RunOptions {
  /** Seed for the deterministic RNG (defaults to 0 so re-runs are reproducible). */
  seed?: number;
  /** Function path, recorded in the execution log. */
  path?: string;
  /** Component namespace prefix (e.g. "auth"); bare table names are resolved under this prefix. Defaults to "" (app root). */
  namespace?: string;
  /** When true, bypasses the namespace boundary — raw table names are used as-is and ownership checks are skipped. For admin/_system use only. */
  privileged?: boolean;
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
        };
        const channel = new InlineSyscallChannel(this.router, kctx);
        const db = fn.type === "query" ? new GuestDatabaseReader(channel) : new GuestDatabaseWriter(channel);
        const guestCtx = { db, random: () => kctx.random.next() };
        const value = await fn.handler(guestCtx, args);
        return { value: value as T, logs: kctx.logs, readRanges: txn.reads.toArray() };
      });
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
