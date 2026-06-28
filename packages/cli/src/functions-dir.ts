import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "./load-config";

/** The default backend functions directory name. */
export const DEFAULT_FUNCTIONS_DIR = "stackbase";

export interface ResolvedFunctionsDir {
  /** Absolute path to the functions directory. */
  functionsDir: string;
  /** Absolute path to the project root (where stackbase.config.ts lives). */
  projectRoot: string;
}

/**
 * Resolve the functions directory. Precedence, highest first:
 *   1. an explicit `--dir` value
 *   2. `functionsDir` in stackbase.config.ts
 *   3. DEFAULT_FUNCTIONS_DIR
 *
 * There is deliberately NO implicit fallback to `convex/`: a Convex layout is
 * converted by `stackbase migrate`, never adopted silently. See
 * docs_old/superpowers/specs/2026-06-06-functions-dir-rename-design.md.
 *
 * With an explicit flag the project root is that path's parent, so a caller can point at a
 * functions directory anywhere. Without one the root is the cwd, which is what makes it safe
 * to read the config before the directory name is known: stackbase.config.ts always sits at
 * the root and never inside the functions directory.
 */
export async function resolveFunctionsDir(
  flagValue: string | undefined,
  cwd: string,
): Promise<ResolvedFunctionsDir> {
  if (flagValue !== undefined && flagValue !== "") {
    const functionsDir = isAbsolute(flagValue) ? flagValue : resolve(cwd, flagValue);
    return { functionsDir, projectRoot: dirname(functionsDir) };
  }
  const projectRoot = resolve(cwd);
  const config = await loadConfig(projectRoot);
  const name = config.functionsDir ?? DEFAULT_FUNCTIONS_DIR;
  return { functionsDir: isAbsolute(name) ? name : join(projectRoot, name), projectRoot };
}

/** The failure message when the resolved directory does not exist. The one Convex-aware string in the CLI. */
export function functionsDirNotFoundMessage(functionsDir: string): string {
  return (
    `no functions directory found at ${functionsDir}\n\n` +
    `If this is a Convex app, run \`stackbase migrate\` to convert it. It renames\n` +
    `convex/ to stackbase/ and rewrites your imports.\n\n` +
    `Otherwise create ${join(functionsDir, "schema.ts")}, or point at an existing folder:\n` +
    `  stackbase dev --dir <path>\n`
  );
}

/**
 * Checks that the resolved functions directory exists. When it doesn't, writes the friendly
 * `functionsDirNotFoundMessage` to stderr and returns false — callers should return exit code 1
 * in that case, rather than letting a missing directory escape as a raw fs error further down the
 * command. Every command that resolves a functions directory (serve, deploy, build, objectstore,
 * codegen, dev) should route its existence check through this one helper, not hand-roll the
 * `existsSync` + message-write pair at each call site.
 */
export function ensureFunctionsDirExists(functionsDir: string): boolean {
  if (existsSync(functionsDir)) return true;
  process.stderr.write(functionsDirNotFoundMessage(functionsDir));
  return false;
}
