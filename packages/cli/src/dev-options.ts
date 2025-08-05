/**
 * Resolve `stackbase dev` options from CLI flags + defaults.
 */
export type RuntimeKind = "bun" | "node" | "auto";

export interface DevOptions {
  port?: number;
  ip?: string;
  convexDir?: string;
  dataPath?: string;
  runtime?: RuntimeKind;
  /** Optional static web UI directory to serve alongside the API/WebSocket. */
  webDir?: string;
  /** Postgres connection string (flag wins over `STACKBASE_DATABASE_URL`); unset → SQLite. */
  databaseUrl?: string;
}

export interface ResolvedDevOptions {
  port: number;
  ip: string;
  convexDir: string;
  dataPath: string;
  runtime: RuntimeKind;
  webDir: string | undefined;
  databaseUrl: string | undefined;
}

export function resolveDevOptions(options: DevOptions = {}): ResolvedDevOptions {
  return {
    port: options.port ?? 3000,
    ip: options.ip ?? "127.0.0.1",
    convexDir: options.convexDir ?? "convex",
    dataPath: options.dataPath ?? ".stackbase/data.db",
    runtime: options.runtime ?? "auto",
    webDir: options.webDir,
    databaseUrl: options.databaseUrl ?? process.env.STACKBASE_DATABASE_URL,
  };
}

/** Detect the active JS runtime (Bun is primary; Node is supported). */
export function detectRuntime(): "bun" | "node" {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node";
}
