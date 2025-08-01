import { describe, it, expect } from "vitest";
import { PostgresDocStore } from "../src/postgres-docstore";
import { PgliteClient } from "./pglite-client";

describe("setupSchema", () => {
  it("creates the three physical tables idempotently", async () => {
    const client = new PgliteClient();
    const store = new PostgresDocStore(client);
    await store.setupSchema();
    await store.setupSchema(); // idempotent — second call must not throw

    const rows = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toContain("documents");
    expect(names).toContain("indexes");
    expect(names).toContain("persistence_globals");
    await store.close();
  });
});
