import { describe, it, expect } from "vitest";
import { PgliteClient } from "./pglite-client";

async function drain<T>(it: AsyncIterable<T>, n?: number): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) {
    out.push(x);
    if (n !== undefined && out.length >= n) break;
  }
  return out;
}

describe("PgliteClient.queryStream", () => {
  it("streams the same rows as query(), honoring params", async () => {
    const c = new PgliteClient();
    await c.query(`CREATE TABLE t (id BYTEA, n BIGINT)`);
    for (let i = 1; i <= 20; i++) await c.query(`INSERT INTO t VALUES (decode(lpad(to_hex($1::int),4,'0'),'hex'), $1)`, [i]);
    const buffered = await c.query(`SELECT n FROM t WHERE n >= $1 ORDER BY n`, [5]);
    const streamed = await drain(c.queryStream!(`SELECT n FROM t WHERE n >= $1 ORDER BY n`, [5]));
    expect(streamed.map((r) => Number(r.n))).toEqual(buffered.map((r) => Number(r.n)));
    // early break must leave the client usable (cursor closed, txn ended)
    const partial = await drain(c.queryStream!(`SELECT n FROM t ORDER BY n`, []), 3);
    expect(partial.map((r) => Number(r.n))).toEqual([1, 2, 3]);
    const after = await c.query(`SELECT COUNT(*)::int AS c FROM t`);
    expect(after[0]!.c).toBe(20); // client still works after an early-broken stream
    await c.close();
  });
});
