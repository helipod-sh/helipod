export type LogKind = "query" | "mutation" | "action";

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

/** Bounded ring buffer; ids strictly increase across the sink's lifetime. */
export class InMemoryLogSink implements LogSink {
  private readonly entries: ExecutionLogEntry[] = [];
  private nextId = 1;
  constructor(private readonly capacity: number = 1000) {}

  push(entry: Omit<ExecutionLogEntry, "id">): void {
    this.entries.push({ ...entry, id: this.nextId++ });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  query(filter: LogFilter = {}): ExecutionLogEntry[] {
    let out = this.entries;
    if (filter.since !== undefined) out = out.filter((e) => e.id > filter.since!);
    if (filter.kind !== undefined) out = out.filter((e) => e.kind === filter.kind);
    if (filter.status !== undefined) out = out.filter((e) => e.status === filter.status);
    out = [...out].reverse(); // newest-first
    return filter.limit !== undefined ? out.slice(0, filter.limit) : out;
  }

  size(): number {
    return this.entries.length;
  }
  clear(): void {
    this.entries.length = 0;
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
