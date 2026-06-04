import type { SchemaDefinitionJSON, TableDefinitionJSON } from "@stackbase/values";
import type { D1Client } from "./d1-client";
import { UniqueConstraintError } from "./d1-client";
import { schemaDdl } from "./ddl";
import { docToRow, rowToDoc, encodeColumnValue } from "./codec";

export interface QueryRange { index: string; eq?: Record<string, unknown>; limit?: number; }

const q = (id: string) => `"${id}"`;

/** Map a SQLite `UNIQUE constraint failed: <table>.<col>` error to a typed UniqueConstraintError. */
function mapError(e: unknown, table: string): never {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /UNIQUE constraint failed:\s*[^.]+\.(\w+)/.exec(msg);
  if (m) throw new UniqueConstraintError(table, m[1]!);
  throw e;
}

/** A relational, column-per-field store over a D1Client (create-only DDL). Standalone — not wired
 *  into the engine (that's M2b). */
export class D1DocStore {
  constructor(private readonly client: D1Client, private readonly schema: SchemaDefinitionJSON) {}

  private table(name: string): TableDefinitionJSON {
    const t = this.schema.tables[name];
    if (!t) throw new Error(`docstore-d1: unknown table "${name}" (not in schema)`);
    return t;
  }

  async applyDdl(): Promise<void> {
    for (const stmt of schemaDdl(this.schema)) await this.client.exec(stmt);
  }

  async insert(table: string, doc: Record<string, unknown>, bookmark?: string): Promise<{ bookmark?: string }> {
    const session = this.client.withSession(bookmark);
    const row = docToRow(this.table(table), doc);
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    try {
      await session.client.prepare(sql).bind(...cols.map((c) => row[c])).run();
    } catch (e) {
      mapError(e, table);
    }
    return { bookmark: session.latestBookmark() };
  }

  async get(table: string, id: string): Promise<Record<string, unknown> | null> {
    const { results } = await this.client.prepare(`SELECT * FROM ${q(table)} WHERE ${q("_id")} = ?`).bind(id).all();
    return results[0] ? rowToDoc(this.table(table), results[0] as Record<string, unknown>) : null;
  }

  async patch(table: string, id: string, partial: Record<string, unknown>, bookmark?: string): Promise<{ bookmark?: string }> {
    const current = await this.get(table, id);
    if (!current) throw new Error(`docstore-d1: patch of missing ${table}/${id}`);
    return this.replace(table, id, { ...current, ...partial, _id: id }, bookmark);
  }

  async replace(table: string, id: string, doc: Record<string, unknown>, bookmark?: string): Promise<{ bookmark?: string }> {
    const session = this.client.withSession(bookmark);
    const row = docToRow(this.table(table), { ...doc, _id: id });
    const cols = Object.keys(row).filter((c) => c !== "_id");
    const sql = `UPDATE ${q(table)} SET ${cols.map((c) => `${q(c)} = ?`).join(", ")} WHERE ${q("_id")} = ?`;
    try {
      await session.client.prepare(sql).bind(...cols.map((c) => row[c]), id).run();
    } catch (e) {
      mapError(e, table);
    }
    return { bookmark: session.latestBookmark() };
  }

  async delete(table: string, id: string, bookmark?: string): Promise<{ bookmark?: string }> {
    const session = this.client.withSession(bookmark);
    await session.client.prepare(`DELETE FROM ${q(table)} WHERE ${q("_id")} = ?`).bind(id).run();
    return { bookmark: session.latestBookmark() };
  }

  async queryByIndex(table: string, range: QueryRange): Promise<Record<string, unknown>[]> {
    const t = this.table(table);
    const doct = t.documentType;
    const fieldDefs = doct.type === "object" ? doct.value : {};
    const eq = range.eq ?? {};
    const keys = Object.keys(eq);
    const where = keys.length ? `WHERE ${keys.map((k) => `${q(k)} = ?`).join(" AND ")}` : "";
    const limit = range.limit ? ` LIMIT ${Number(range.limit)}` : "";
    const bound = keys.map((k) => {
      const def = (fieldDefs as Record<string, { fieldType: import("@stackbase/values").ValidatorJSON; optional: boolean }>)[k];
      return def ? encodeColumnValue(def.fieldType, eq[k]) : eq[k]; // system columns (_id/_creationTime) pass raw
    });
    const { results } = await this.client
      .prepare(`SELECT * FROM ${q(table)} ${where}${limit}`)
      .bind(...bound)
      .all();
    return (results as Record<string, unknown>[]).map((r) => rowToDoc(t, r));
  }
}
