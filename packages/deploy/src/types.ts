export interface SpawnOptions { cwd?: string; env?: Record<string, string>; stdio?: "inherit" | "capture"; }
export interface SpawnResult { code: number; stdout: string; stderr: string; }
export interface Spawner { run(cmd: string, args: string[], opts?: SpawnOptions): Promise<SpawnResult>; }

export interface FileTree { files: Array<{ path: string; code: string }>; }

export interface ResolvedTarget {
  targetName: string;                    // the --target value, e.g. "cloudflare"
  provider: string;                      // "serve" | "cloudflare" | "docker" | "railway" | "fly" | "aws"
  env: string;                           // resolved environment name, e.g. "production"
  settings: Record<string, unknown>;     // shared config merged with the env override
}

export interface DeployContext {
  cwd: string;                           // project root (dir containing convex/)
  convexDir: string;                     // path to the convex/ dir
  env: string;                           // = ResolvedTarget.env
  target: ResolvedTarget;
  interactive: boolean;                  // stdin.isTTY && !process.env.CI — false gates all prompts
  spawn: Spawner;
  log: (msg: string) => void;
  packageApp: () => Promise<FileTree>;   // transpile convex/ (provided by the CLI)
  codegen: () => Promise<void>;          // refresh convex/_generated (provided by the CLI)
}

export interface DeployResult { ok: boolean; url?: string; detail?: string; error?: string; }

export interface DeployTarget {
  readonly name: string;                 // "serve" | "cloudflare" | "docker" | "railway" | "fly" | "aws"
  preflight(ctx: DeployContext): Promise<void>;
  package(ctx: DeployContext): Promise<void>;
  push(ctx: DeployContext): Promise<DeployResult>;
}

export class DeployError extends Error {}
