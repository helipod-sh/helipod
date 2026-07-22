/**
 * Host-side bridge for the interactive terminal dashboard. This module is only
 * ever loaded via dynamic `import()` from `devCommand` (Bun + TTY, opt-out with
 * `--no-ui` / `HELIPOD_TUI=0`), and it in turn dynamic-imports `@helipod/tui` —
 * so `@helipod/cli` keeps zero static dependency on the TUI stack, mirroring the
 * `@helipod/fleet` seam. Every failure surfaces as a throw the caller treats as
 * "no TUI — stay on plain styled output".
 */
import { spawn } from "node:child_process";

export type AnyTuiEvent =
  | { kind: "reload"; ok: true; durationMs: number; functions: number; at: number }
  | { kind: "reload"; ok: false; message: string; at: number }
  | { kind: "log"; level: "info" | "warn" | "error"; source: string; message: string; at: number };

export interface AttachOptions {
  url: string;
  dashboardUrl: string | null;
  adminKeyPreview: string;
  functionsDir: string;
  storage: string;
  /** helipod's own version — never the host app's `npm_package_version`. */
  version: string;
  counts: () => { functions: number; tables: number; components: number };
  /** The live admin API — the same surface the web dashboard consumes. */
  admin: {
    listTables: () => Promise<Array<{ name: string; documentCount: number; indexes: string[]; shardKey?: string }>>;
    getTableData: (t: string, o?: { cursor?: string | null; pageSize?: number; filter?: unknown }) => Promise<unknown>;
    listFunctions: () => Array<{ path: string; kind: string; argsType?: unknown }>;
    runFunction: (path: string, args: Record<string, unknown>) => Promise<{ value: unknown; committed: boolean }>;
    queryLogs: (f?: { limit?: number }) => ReadonlyArray<unknown>;
    /** Subscribe to the engine's write fan-out (tables touched per commit). */
    onCommit: (cb: (tables: string[], commitTs: number) => void) => () => void;
    getSchema: () => { schemaJson: unknown };
  };
}

export async function attachTui(opts: AttachOptions): Promise<(e: AnyTuiEvent) => void> {
  // The specifier is computed so bundlers (helipod build's static-import entrypoint)
  // don't force @helipod/tui into every compiled binary.
  const specifier = "@helipod/tui";
  const tui = (await import(specifier)) as typeof import("@helipod/tui");

  const listeners = new Set<(e: AnyTuiEvent) => void>();
  const openUrl = (url: string) => {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
      spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    } catch {
      /* non-fatal */
    }
  };

  let handle: { stop: () => Promise<void> } | null = null;
  handle = await tui.runDashboard({
    deployment: {
      url: opts.url,
      dashboardUrl: opts.dashboardUrl,
      adminKeyPreview: opts.adminKeyPreview,
      functionsDir: opts.functionsDir,
      storage: opts.storage,
      version: opts.version,
    },
    counts: opts.counts,
    data: {
      listTables: () => opts.admin.listTables(),
      getTableData: (t, o) => opts.admin.getTableData(t, o) as Promise<never>,
      listFunctions: () => opts.admin.listFunctions(),
      runFunction: (p, a) => opts.admin.runFunction(p, a),
      queryLogs: (f) => opts.admin.queryLogs(f) as never,
      onCommit: (cb) => opts.admin.onCommit(cb),
      schema: () => opts.admin.getSchema().schemaJson as never,
    },
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    requestQuit: () => {
      void handle?.stop().finally(() => process.exit(0));
    },
    openUrl,
  });

  return (e) => {
    for (const cb of listeners) cb(e);
  };
}
