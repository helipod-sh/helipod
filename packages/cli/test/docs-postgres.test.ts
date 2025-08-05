/**
 * Guard: the self-hosting doc must document the Postgres storage option (slice 6c) — the real
 * `--database-url`/`STACKBASE_DATABASE_URL` flag pair, a `postgres://` connection-string example,
 * and the single-writer constraint — not just the SQLite-only baseline it started with.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("self-hosting docs document Postgres", () => {
  const doc = readFileSync(
    join(import.meta.dirname, "../../../docs/enduser/self-hosting.md"),
    "utf8",
  );

  it("covers the connection-string option and compose service", () => {
    expect(doc).toContain("STACKBASE_DATABASE_URL");
    expect(doc).toMatch(/--database-url/);
    expect(doc).toMatch(/postgres:\/\//);
    expect(doc).toMatch(/single writer|single-writer/i); // the single-node constraint must be stated
  });
});
