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
