/**
 * Unit coverage for the `stackbase migrate export`/`import` CLI clients' argument handling and verb
 * dispatch — the happy path + collision guard + 401 are proven end-to-end in `migrate-data-e2e`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { migrateCommand } from "../src/migrate";
import { migrateExportCommand, migrateImportCommand } from "../src/migrate/data";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.STACKBASE_ADMIN_KEY;
});

function silenceStderr(): void {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

describe("migrate export/import — argument handling", () => {
  it("export requires --url", async () => {
    silenceStderr();
    expect(await migrateExportCommand(["--out", "d.json", "--admin-key", "k"])).toBe(1);
  });

  it("export requires --out", async () => {
    silenceStderr();
    expect(await migrateExportCommand(["--url", "http://x", "--admin-key", "k"])).toBe(1);
  });

  it("import requires an admin key (env or --admin-key)", async () => {
    silenceStderr();
    expect(await migrateImportCommand(["--url", "http://x", "--in", "d.json"])).toBe(1);
  });

  it("import fails cleanly when the dump file is missing", async () => {
    silenceStderr();
    expect(await migrateImportCommand(["--url", "http://x", "--in", "/no/such/dump.json", "--admin-key", "k"])).toBe(1);
  });

  it("`migrate export`/`import` verbs dispatch to the data clients (missing args -> 1)", async () => {
    silenceStderr();
    expect(await migrateCommand(["export"])).toBe(1); // no --url
    expect(await migrateCommand(["import"])).toBe(1); // no --url
  });
});
