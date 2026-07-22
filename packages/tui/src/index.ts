/**
 * @helipod/tui — the helipod terminal dashboard (OpenTUI + vendored termcn components).
 *
 * Loaded by the CLI via dynamic `import()` ONLY after a runtime probe: importing this
 * module never touches FFI, but `runDashboard()` calls `createCliRenderer()`, which
 * loads OpenTUI's native Zig core. Under Bun that always works; under Node it needs
 * >= 26.4 with --experimental-ffi, so hosts must treat failures as "fall back to
 * plain output", never as fatal.
 */
import type { TuiBridge } from "./bridge";

export type { TuiBridge, TuiDeployment, TuiCounts, TuiEvent } from "./bridge";

export interface DashboardHandle {
  /** Tear down the renderer and restore the terminal. */
  stop: () => Promise<void>;
}

export async function runDashboard(bridge: TuiBridge): Promise<DashboardHandle> {
  const [{ createCliRenderer }, { createRoot }, { mount }] = await Promise.all([
    import("@opentui/core"),
    import("@opentui/react"),
    import("./app"),
  ]);

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  mount(root, bridge);

  return {
    stop: async () => {
      (root as { unmount?: () => void }).unmount?.();
      renderer.destroy();
    },
  };
}
