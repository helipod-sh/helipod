import type { SchemaDefinitionJSON, TableDefinitionJSON, ValidatorJSON } from "@stackbase/values";

const JSON_TYPES = new Set(["array", "record", "object", "union", "any"]);

/** SQLite column type for a field validator (see the plan's Global Constraints mapping). */
export function columnTypeFor(v: ValidatorJSON): string {
  switch (v.type) {
    case "number": return "REAL";
    case "boolean": return "INTEGER";
    case "bytes": return "BLOB";
    case "literal":
      return typeof v.value === "number" ? "REAL" : typeof v.value === "boolean" ? "INTEGER" : "TEXT";
    // string, id, bigint, null → TEXT; array/record/object/union/any → JSON TEXT
    default: return "TEXT";
  }
}

export function isJsonColumn(v: ValidatorJSON): boolean {
  return JSON_TYPES.has(v.type);
}

/** Create-only DDL for one table: CREATE TABLE + CREATE [UNIQUE] INDEX (all `IF NOT EXISTS`). */
export function tableDdl(name: string, table: TableDefinitionJSON): string[] {
  const doc = table.documentType;
  if (doc.type !== "object") throw new Error(`docstore-d1: table "${name}" documentType must be an object`);
  const cols: string[] = [`"_id" TEXT PRIMARY KEY`, `"_creationTime" REAL NOT NULL`];
  for (const [field, def] of Object.entries(doc.value)) {
    cols.push(`"${field}" ${columnTypeFor(def.fieldType)}${def.optional ? "" : " NOT NULL"}`);
  }
  const stmts = [`CREATE TABLE IF NOT EXISTS "${name}" (${cols.join(", ")})`];
  for (const idx of table.indexes) {
    const cols2 = idx.fields.map((f) => `"${f}"`).join(", ");
    const prefix = idx.unique ? "uq" : "idx";
    stmts.push(
      `CREATE ${idx.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${prefix}_${name}_${idx.indexDescriptor}" ON "${name}" (${cols2})`,
    );
  }
  return stmts;
}

export function schemaDdl(schema: SchemaDefinitionJSON): string[] {
  return Object.entries(schema.tables).flatMap(([n, t]) => tableDdl(n, t));
}
