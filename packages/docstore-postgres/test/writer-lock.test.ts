import { describe, it, expect } from "vitest";
import { PostgresDocStore } from "../src/postgres-docstore";
import { NodePgClient } from "../src/node-pg-client";

const REAL_PG = process.env.HELIPOD_TEST_DATABASE_URL;
const d = REAL_PG ? describe : describe.skip;

d("single-writer advisory lock (real Postgres)", () => {
  it("a second engine on the same database fails fast", async () => {
    const a = new PostgresDocStore(new NodePgClient({ connectionString: REAL_PG! }));
    await a.setupSchema(); // takes the lock
    const b = new PostgresDocStore(new NodePgClient({ connectionString: REAL_PG! }));
    await expect(b.setupSchema()).rejects.toThrow(/already connected|advisory lock/i);
    await a.close(); // releases the session lock
    // after release, a fresh engine can acquire
    const c = new PostgresDocStore(new NodePgClient({ connectionString: REAL_PG! }));
    await c.setupSchema();
    await c.close();
  });
});
