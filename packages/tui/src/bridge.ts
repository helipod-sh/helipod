/**
 * The contract between a helipod host process (`helipod dev` today; the standalone
 * `helipod dashboard` command in a later phase) and the terminal dashboard.
 *
 * The TUI never reaches into engine internals: the host hands it a snapshot plus an
 * event stream, exactly the way the web dashboard consumes the admin surface. Events
 * are buffered by the TUI into a bounded ring — hosts may emit freely.
 */
export interface TuiDeployment {
  url: string;
  dashboardUrl: string | null;
  /** Already truncated by the host — the TUI never holds the full admin secret. */
  adminKeyPreview: string;
  functionsDir: string;
  storage: string; // "sqlite" | "postgres" | descriptive
  version: string;
}

export interface TuiCounts {
  functions: number;
  tables: number;
  components: number;
}

export type TuiEvent =
  | { kind: "reload"; ok: true; durationMs: number; functions: number; at: number }
  | { kind: "reload"; ok: false; message: string; at: number }
  | { kind: "log"; level: "info" | "warn" | "error"; source: string; message: string; at: number };

/** A table as the data browser sees it. */
export interface TuiTable {
  name: string;
  documentCount: number;
  indexes: string[];
  shardKey?: string;
}

export interface TuiPage {
  documents: Array<Record<string, unknown>>;
  cursor: string | null;
  isDone: boolean;
  scanCapped?: boolean;
}

export interface TuiFunction {
  path: string;
  kind: string;
  /** The function's own `args` validator, as JSON — what codegen types from. */
  argsType?: unknown;
}

export interface TuiLogEntry {
  id: number;
  path: string;
  kind: string;
  ts: number;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
}

/** Optional data surface — present when the host has an admin API (i.e. `helipod dev`). */
export interface TuiData {
  listTables: () => Promise<TuiTable[]>;
  getTableData: (table: string, opts?: { cursor?: string | null; pageSize?: number }) => Promise<TuiPage>;
  listFunctions: () => TuiFunction[];
  runFunction: (path: string, args: Record<string, unknown>) => Promise<{ value: unknown; committed: boolean }>;
  queryLogs: (filter?: { limit?: number }) => TuiLogEntry[];
  schema: () => { tables: Record<string, { fields?: unknown; indexes?: Array<{ indexDescriptor: string }> }> };
}

export interface TuiBridge {
  deployment: TuiDeployment;
  counts: () => TuiCounts;
  /** Subscribe to host events; returns an unsubscribe. */
  onEvent: (cb: (e: TuiEvent) => void) => () => void;
  /** Host-side quit hook (the TUI calls this on `q`, then the host shuts down). */
  requestQuit: () => void;
  /** Open a URL in the local browser, if the host knows how. */
  openUrl?: (url: string) => void;
  /** Admin data access; absent hosts render the data screens as unavailable. */
  data?: TuiData;
}
