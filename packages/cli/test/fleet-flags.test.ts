/**
 * Unit tests for the `helipod serve --fleet` flag parsing + fail-fast validation (Task 6).
 * No spawned processes, no containers — this exercises the pure parser/validator only. The real
 * 2-process fleet E2E is Task 7.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveServeOptions,
  validateFleetOptions,
  FLEET_ERR_NO_DB,
  FLEET_ERR_NO_ADVERTISE,
} from "../src/serve";

const ENV_KEYS = ["HELIPOD_FLEET", "HELIPOD_ADVERTISE_URL", "HELIPOD_DATABASE_URL"] as const;

describe("resolveServeOptions — fleet flags", () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
      delete saved[k];
    }
  });
  function stash(k: (typeof ENV_KEYS)[number], v: string | undefined): void {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  it("defaults fleet off with no advertise url", () => {
    for (const k of ENV_KEYS) stash(k, undefined);
    const opts = resolveServeOptions([]);
    expect(opts.fleet).toBe(false);
    expect(opts.advertiseUrl).toBeUndefined();
  });

  it("--fleet sets the flag", () => {
    for (const k of ENV_KEYS) stash(k, undefined);
    const opts = resolveServeOptions(["--fleet"]);
    expect(opts.fleet).toBe(true);
  });

  it("HELIPOD_FLEET=1 env fallback enables fleet", () => {
    for (const k of ENV_KEYS) stash(k, undefined);
    stash("HELIPOD_FLEET", "1");
    expect(resolveServeOptions([]).fleet).toBe(true);
  });

  it("HELIPOD_FLEET=0 keeps fleet off", () => {
    for (const k of ENV_KEYS) stash(k, undefined);
    stash("HELIPOD_FLEET", "0");
    expect(resolveServeOptions([]).fleet).toBe(false);
  });

  it("--advertise-url flag wins over env", () => {
    for (const k of ENV_KEYS) stash(k, undefined);
    stash("HELIPOD_ADVERTISE_URL", "http://env:3000");
    const opts = resolveServeOptions(["--advertise-url", "http://flag:3000"]);
    expect(opts.advertiseUrl).toBe("http://flag:3000");
  });

  it("HELIPOD_ADVERTISE_URL env fallback", () => {
    for (const k of ENV_KEYS) stash(k, undefined);
    stash("HELIPOD_ADVERTISE_URL", "http://env:3000");
    expect(resolveServeOptions([]).advertiseUrl).toBe("http://env:3000");
  });
});

describe("validateFleetOptions — fail-fast", () => {
  it("rejects fleet without a Postgres database url", () => {
    const r = validateFleetOptions({ fleet: true, databaseUrl: undefined, advertiseUrl: "http://a:3000" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(FLEET_ERR_NO_DB);
  });

  it("rejects fleet with a non-Postgres database url", () => {
    const r = validateFleetOptions({ fleet: true, databaseUrl: "./data/db.sqlite", advertiseUrl: "http://a:3000" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(FLEET_ERR_NO_DB);
  });

  it("rejects fleet without an advertise url", () => {
    const r = validateFleetOptions({ fleet: true, databaseUrl: "postgres://x/db", advertiseUrl: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(FLEET_ERR_NO_ADVERTISE);
  });

  it("rejects fleet with a blank advertise url", () => {
    const r = validateFleetOptions({ fleet: true, databaseUrl: "postgres://x/db", advertiseUrl: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(FLEET_ERR_NO_ADVERTISE);
  });

  it("accepts a valid fleet config and trims the advertise url", () => {
    const r = validateFleetOptions({ fleet: true, databaseUrl: "postgres://x/db", advertiseUrl: " http://a:3000 " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.databaseUrl).toBe("postgres://x/db");
      expect(r.advertiseUrl).toBe("http://a:3000");
    }
  });
});
