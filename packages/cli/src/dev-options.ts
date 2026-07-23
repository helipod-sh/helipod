/**
 * Resolve `helipod dev` options from CLI flags + defaults.
 */
import { DEFAULT_FUNCTIONS_DIR } from "./functions-dir";

export type RuntimeKind = "bun" | "node" | "auto";

export interface DevOptions {
  port?: number;
  ip?: string;
  functionsDir?: string;
  dataPath?: string;
  runtime?: RuntimeKind;
  /** Optional static web UI directory to serve alongside the API/WebSocket. */
  webDir?: string;
  /** Postgres connection string (flag wins over `HELIPOD_DATABASE_URL`); unset → SQLite. */
  databaseUrl?: string;
  /** File-storage backend flag overrides (`--storage-bucket`/`--storage-endpoint`; win over env). */
  storageBucket?: string;
  storageEndpoint?: string;
  /** `--no-ui`: opt out of the interactive terminal dashboard in `dev`. */
  noUi?: boolean;
}

export interface ResolvedDevOptions {
  port: number;
  ip: string;
  functionsDir: string;
  dataPath: string;
  runtime: RuntimeKind;
  webDir: string | undefined;
  databaseUrl: string | undefined;
  storageBucket: string | undefined;
  storageEndpoint: string | undefined;
}

export function resolveDevOptions(options: DevOptions = {}): ResolvedDevOptions {
  return {
    port: options.port ?? 3000,
    ip: options.ip ?? "127.0.0.1",
    functionsDir: options.functionsDir ?? DEFAULT_FUNCTIONS_DIR,
    dataPath: options.dataPath ?? ".helipod/data.db",
    runtime: options.runtime ?? "auto",
    webDir: options.webDir,
    databaseUrl: options.databaseUrl ?? process.env.HELIPOD_DATABASE_URL,
    storageBucket: options.storageBucket,
    storageEndpoint: options.storageEndpoint,
  };
}

/** Detect the active JS runtime (Bun is primary; Node is supported). */
export function detectRuntime(): "bun" | "node" {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node";
}
