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

export interface TuiBridge {
  deployment: TuiDeployment;
  counts: () => TuiCounts;
  /** Subscribe to host events; returns an unsubscribe. */
  onEvent: (cb: (e: TuiEvent) => void) => () => void;
  /** Host-side quit hook (the TUI calls this on `q`, then the host shuts down). */
  requestQuit: () => void;
  /** Open a URL in the local browser, if the host knows how. */
  openUrl?: (url: string) => void;
}
