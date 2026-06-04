import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ResolvedCli {
  command: string;
  baseArgs: string[];
}

/** How to invoke the stackbase CLI: an explicit override (split on whitespace), else the app's local
 *  `node_modules/.bin/stackbase`, else `npx stackbase`. */
export function resolveCli(cwd: string, override?: string): ResolvedCli {
  if (override && override.trim()) {
    const [command, ...baseArgs] = override.trim().split(/\s+/);
    return { command: command!, baseArgs };
  }
  const localBin = join(cwd, "node_modules", ".bin", "stackbase");
  if (existsSync(localBin)) return { command: localBin, baseArgs: [] };
  return { command: "npx", baseArgs: ["stackbase"] };
}

/** Assemble the `dev` argv: `[...baseArgs, "dev", "--port", <port>, "--dir", <convexDir>, ...extra]`. */
export function buildDevArgs(baseArgs: string[], port: number, convexDir: string, extra: string[]): string[] {
  return [...baseArgs, "dev", "--port", String(port), "--dir", convexDir, ...extra];
}
