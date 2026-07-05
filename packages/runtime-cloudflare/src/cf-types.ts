/**
 * The MINIMAL structural surface of the Cloudflare Workers runtime this host drives — declared
 * inline as narrow interfaces rather than importing `@cloudflare/workers-types`, the same
 * injection-not-import discipline `docstore-do-sqlite`'s `SqlStorageLike` uses. A real workerd
 * `DurableObjectState` / `WebSocket` / `SqlStorage` satisfies these by WIDTH, so a Worker bundle wires
 * them in with zero casts and this package needs no `@cloudflare/workers-types` runtime dependency.
 *
 * These are the ONLY Cloudflare shapes the host references. The neutrality gate
 * (`test/neutrality.test.ts`) proves no Cloudflare type leaks BELOW this package into the engine
 * (`runtime-embedded`/`transactor`/`sync`).
 */
import type { SqlStorageLike, TransactionSyncFn } from "@helipod/docstore-do-sqlite";

/** `ctx.storage` — the DO's durable SQLite handle + its alarm. `sql`/`transactionSync` feed the
 *  `DoSqliteAdapter`; `setAlarm` is the wake seam's single alarm (`WakeHost.armWake`). */
export interface DurableObjectStorageLike {
  sql: SqlStorageLike;
  transactionSync: TransactionSyncFn;
  /** Arm the DO's single alarm at absolute epoch-ms `scheduledTime`, replacing any prior. */
  setAlarm(scheduledTime: number): void | Promise<void>;
  /** The currently-armed alarm instant, or `null`. */
  getAlarm(): Promise<number | null>;
  /** Cancel the armed alarm. */
  deleteAlarm(): void | Promise<void>;
}

/** A hibernatable Durable Object WebSocket (`WebSocketPair[1]` after `acceptWebSocket`). Its
 *  `serializeAttachment`/`deserializeAttachment` persist up to 16 KB that SURVIVES hibernation — the
 *  hook the session-rehydrate path (§3) hangs on. */
export interface DoWebSocketLike {
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  /** Persist a small JSON-serializable value with the socket (≤16 KB), surviving DO hibernation. */
  serializeAttachment(value: unknown): void;
  /** Read back the value last given to `serializeAttachment` (or `null`). */
  deserializeAttachment(): unknown;
  readonly readyState?: number;
  /** Bytes buffered but not yet sent — feeds the handler's backpressure controller when present. */
  readonly bufferedAmount?: number;
}

/** The DO's own state handle (`ctx`/`state`), passed to the DO class constructor. */
export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  /** Accept a server WebSocket into the hibernation manager. `tags` let `getWebSockets(tag)` filter. */
  acceptWebSocket(ws: DoWebSocketLike, tags?: string[]): void;
  /** Every hibernatable socket this DO currently holds (across hibernation) — the subscription
   *  index is the union of each socket's attachment, so this IS the index. */
  getWebSockets(tag?: string): DoWebSocketLike[];
  /** A runtime-level ping/pong that answers WITHOUT waking a hibernated DO — the keepalive that
   *  replaces the handler's process-shaped `socket.ping` heartbeat (decision 6 / §8.1). */
  setWebSocketAutoResponse?(pair: unknown): void;
  /** Run `fn` with all other DO events blocked — used for the constructor's boot so no request
   *  interleaves a half-built runtime. */
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  /** Extend the DO's lifetime past the current event for `promise`. Present in workerd. */
  waitUntil?(promise: Promise<unknown>): void;
  readonly id?: { toString(): string };
}

/** The `[client, server]` pair a WS upgrade mints. In workerd this is the global `WebSocketPair`
 *  constructor; declared structurally so the host references it without a hard type dep. */
export interface WebSocketPairLike {
  0: DoWebSocketLike & { accept?(): void };
  1: DoWebSocketLike;
}
