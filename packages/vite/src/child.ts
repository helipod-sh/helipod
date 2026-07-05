import { connect } from "node:net";

export interface SpawnedChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(ev: "exit", cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}
export type SpawnFn = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnedChild;
export type ProbeFn = (port: number) => Promise<boolean>;

export interface StartBackendOptions {
  command: string;
  args: string[];
  cwd: string;
  port: number;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
  onLog?: (line: string) => void;
}
export interface Backend { stop: () => void; }

/** True once something accepts a TCP connection on the port (the backend is up). */
export function probePort(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Spawn the backend child, pipe its output line-wise to `onLog`, and resolve once it's ready.
 *  Rejects if the child exits before ready or readiness times out. `stop` kills the child once. */
export async function startBackend(opts: StartBackendOptions, deps: { spawn: SpawnFn; probe: ProbeFn }): Promise<Backend> {
  const child = deps.spawn(opts.command, opts.args, { cwd: opts.cwd, env: process.env });
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; try { child.kill("SIGTERM"); } catch { /* already gone */ } };

  const pipe = (stream: NodeJS.ReadableStream | null) => {
    stream?.on("data", (d: Buffer | string) => {
      for (const line of d.toString().split("\n")) if (line.trim()) opts.onLog?.(line);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  let exited = false;
  let exitCode: number | null = null;
  child.on("exit", (code) => { exited = true; exitCode = code; });

  const timeout = opts.readinessTimeoutMs ?? 30_000;
  const interval = opts.pollIntervalMs ?? 200;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (exited) { stop(); throw new Error(`helipod dev exited before becoming ready (code ${exitCode})`); }
    if (await deps.probe(opts.port)) return { stop };
    await new Promise((r) => setTimeout(r, interval));
  }
  stop();
  throw new Error(`helipod dev did not become ready on port ${opts.port} within ${timeout}ms`);
}

export interface CleanupProc { once(ev: string, cb: (...a: unknown[]) => void): void; }

/** Ensure the child is killed on Vite/process teardown. Kills on `exit` (backstop) and re-exits on
 *  SIGINT/SIGTERM after killing (so the child never orphans). Injectable proc/exit for tests. */
export function installSignalCleanup(
  stop: () => void,
  proc: CleanupProc = process,
  exit: (code: number) => void = (c) => process.exit(c),
): void {
  proc.once("exit", () => stop());
  proc.once("SIGINT", () => { stop(); exit(130); });
  proc.once("SIGTERM", () => { stop(); exit(143); });
}
