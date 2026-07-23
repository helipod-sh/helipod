export type LogKind = "query" | "mutation" | "action" | "httpAction";

export interface ExecutionLogEntry {
  id: number;
  path: string;
  kind: LogKind;
  ts: number;        // wall-clock ms when the run started
  durationMs: number;
  status: "ok" | "error";
  error?: string;
}

export interface LogFilter {
  since?: number;    // only entries with id > since
  kind?: LogKind;
  status?: "ok" | "error";
  limit?: number;    // cap the result (after newest-first ordering)
}

export interface LogSink {
  push(entry: Omit<ExecutionLogEntry, "id">): void;
  query(filter?: LogFilter): ExecutionLogEntry[];
  size(): number;
  clear(): void;
}

/**
 * Bounded ring buffer over a fixed-size array with a head pointer, so `push`
 * stays O(1) once full. `push` is on the executor's hot path (every function
 * call logs), and the previous `Array.prototype.shift()` reindexed all ~1000
 * elements on every call past capacity — O(n) per commit. A slot-overwrite is
 * O(1). Ids strictly increase across the sink's lifetime.
 */
export class InMemoryLogSink implements LogSink {
  private readonly slots: (ExecutionLogEntry | undefined)[];
  private head = 0; // index of the next write
  private count = 0; // filled slots, ≤ capacity
  private nextId = 1;

  constructor(private readonly capacity: number = 1000) {
    this.slots = new Array<ExecutionLogEntry | undefined>(Math.max(1, capacity));
  }

  push(entry: Omit<ExecutionLogEntry, "id">): void {
    this.slots[this.head] = { ...entry, id: this.nextId++ };
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  query(filter: LogFilter = {}): ExecutionLogEntry[] {
    const out: ExecutionLogEntry[] = [];
    const limit = filter.limit;
    // Walk newest→oldest directly (the head-1 slot is the most recent), so the
    // result is newest-first without a separate reverse, and `limit` short-
    // circuits before we've touched the whole buffer.
    for (let i = 0; i < this.count; i++) {
      if (limit !== undefined && out.length >= limit) break;
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      const e = this.slots[idx];
      if (!e) continue;
      if (filter.since !== undefined && e.id <= filter.since) continue;
      if (filter.kind !== undefined && e.kind !== filter.kind) continue;
      if (filter.status !== undefined && e.status !== filter.status) continue;
      out.push(e);
    }
    return out;
  }

  size(): number {
    return this.count;
  }
  clear(): void {
    this.slots.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}

export class NoopLogSink implements LogSink {
  push(_entry: Omit<ExecutionLogEntry, "id">): void {}
  query(): ExecutionLogEntry[] {
    return [];
  }
  size(): number {
    return 0;
  }
  clear(): void {}
}
