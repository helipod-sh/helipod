import type { TableDefinitionJSON } from "@stackbase/values";
import { isJsonColumn } from "./ddl";

function fields(table: TableDefinitionJSON): Array<[string, { fieldType: import("@stackbase/values").ValidatorJSON; optional: boolean }]> {
  const doc = table.documentType;
  if (doc.type !== "object") throw new Error("docstore-d1: documentType must be an object");
  return Object.entries(doc.value);
}

/** App doc → a SQLite row: booleans→0/1, bigint→string, nested (array/object/…)→JSON, absent→null. */
export function docToRow(table: TableDefinitionJSON, doc: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = { _id: doc._id, _creationTime: doc._creationTime };
  for (const [field, def] of fields(table)) {
    const val = doc[field];
    if (val === undefined || val === null) { row[field] = null; continue; }
    row[field] = isJsonColumn(def.fieldType)
      ? JSON.stringify(val)
      : def.fieldType.type === "boolean"
        ? (val ? 1 : 0)
        : def.fieldType.type === "bigint"
          ? String(val)
          : val;
  }
  return row;
}

/** SQLite row → app doc: reverse of docToRow. A null column for an OPTIONAL field is omitted. */
export function rowToDoc(table: TableDefinitionJSON, row: Record<string, unknown>): Record<string, unknown> {
  const doc: Record<string, unknown> = { _id: row._id, _creationTime: row._creationTime };
  for (const [field, def] of fields(table)) {
    const cell = row[field];
    if (cell === null || cell === undefined) continue; // absent/optional stays absent
    doc[field] = isJsonColumn(def.fieldType)
      ? JSON.parse(cell as string)
      : def.fieldType.type === "boolean"
        ? Boolean(cell)
        : def.fieldType.type === "bigint"
          ? BigInt(cell as string)
          : cell;
  }
  return doc;
}
