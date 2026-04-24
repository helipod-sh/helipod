/**
 * A faithful in-process stand-in for the Durable Object runtime surface the host drives — enough to
 * exercise `StackbaseDurableObject` under plain Node/vitest WITHOUT workerd. It pairs the SHIPPED
 * `MemorySqlStorage` (docstore-do-sqlite's DO-SQLite stand-in, real `node:sqlite`) with fakes for the
 * alarm, hibernation socket registry, and `blockConcurrencyWhile`.
 *
 * FIDELITY: API-shape. It reproduces the CONTRACTS the host depends on (synchronous SQL, a single
 * durable alarm, an attachment that survives "hibernation", `getWebSockets()` as the subscription
 * index) so a green host test proves the ORCHESTRATION is correct. It does NOT reproduce workerd's
 * real hibernation eviction, `WebSocketPair`, or `setWebSocketAutoResponse` — those are the province
 * of the deferred `vitest-pool-workers` run and the real-Cloudflare E2E.
 */
import { MemorySqlStorage } from "../../docstore-do-sqlite/test/memory-sql-storage";
import type { DurableObjectStateLike, DoWebSocketLike, DurableObjectStorageLike } from "../src/cf-types";

/** A fake hibernatable WebSocket: records sent frames and round-trips a serialized attachment (a
 *  structured JSON clone, exactly as a real DO attachment survives hibernation). */
export class FakeDoWebSocket implements DoWebSocketLike {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private attachment: unknown = null;
  bufferedAmount = 0;
  readyState = 1;

  send(message: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(typeof message === "string" ? message : new TextDecoder().decode(message as ArrayBuffer));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  serializeAttachment(value: unknown): void {
    // Deep clone through JSON — a real DO persists a structured clone across hibernation.
    this.attachment = value === undefined ? null : JSON.parse(JSON.stringify(value));
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  /** Parsed server→client frames of a given `type`, newest last. */
  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((m) => m.type === type);
  }
}

/** Fake DO storage: shipped `MemorySqlStorage` + a single durable alarm slot. Shared across DO
 *  "incarnations" (pass the same instance to two DOs to simulate hibernation-then-revival). */
export class FakeDoStorage implements DurableObjectStorageLike {
  readonly memSql: MemorySqlStorage;
  private alarm: number | null = null;

  constructor(memSql?: MemorySqlStorage) {
    this.memSql = memSql ?? new MemorySqlStorage();
  }
  get sql() {
    return this.memSql;
  }
  transactionSync = ((closure: () => unknown) => this.memSql.transactionSync(closure)) as DurableObjectStorageLike["transactionSync"];
  setAlarm(scheduledTime: number): void {
    this.alarm = scheduledTime;
  }
  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }
  deleteAlarm(): void {
    this.alarm = null;
  }
  /** The currently-armed alarm instant (test inspection). */
  peekAlarm(): number | null {
    return this.alarm;
  }
}

/** Fake DO state: the storage + a hibernation socket registry + `blockConcurrencyWhile`. */
export class FakeDoState implements DurableObjectStateLike {
  readonly storage: FakeDoStorage;
  private sockets: DoWebSocketLike[] = [];
  autoResponseArmed = false;

  constructor(storage?: FakeDoStorage) {
    this.storage = storage ?? new FakeDoStorage();
  }
  acceptWebSocket(ws: DoWebSocketLike): void {
    if (!this.sockets.includes(ws)) this.sockets.push(ws);
  }
  getWebSockets(): DoWebSocketLike[] {
    return this.sockets.filter((s) => (s as FakeDoWebSocket).closed === null);
  }
  setWebSocketAutoResponse(): void {
    this.autoResponseArmed = true;
  }
  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  /** Test helper: enroll a socket as if a prior incarnation had accepted it (survives "hibernation"). */
  seedSocket(ws: DoWebSocketLike): void {
    this.sockets.push(ws);
  }
}

/** Poll until `cond()` or timeout — for the async reactive fan-out drain. */
export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
