/**
 * The additive-schema gate for `stackbase deploy`. A deploy may add tables and add OPTIONAL fields
 * (tableNumbers must stay stable); anything destructive — a dropped/renamed table, a changed
 * tableNumber, a removed field, an incompatible field-type change, or a new REQUIRED field on an
 * existing table — is rejected so the running deployment is never left with a schema its data
 * violates. No data migrations (deferred): destructive means "reject", not "migrate".
 */
export interface ObjectFieldJSON {
  fieldType: { type: string };
  optional: boolean;
}
export interface DeploySchema {
  schemaJson: { tables: Record<string, { documentType: { type: string; value?: Record<string, ObjectFieldJSON> } }> };
  tableNumbers: Record<string, number>;
}
export type SchemaDiff = { ok: true } | { ok: false; reason: string };

function fieldsOf(s: DeploySchema, table: string): Record<string, ObjectFieldJSON> {
  return s.schemaJson.tables[table]?.documentType?.value ?? {};
}

// A field-type change is compatible only when the tag is unchanged, or the new validator widens
// (a union, or `any`). Anything else (string→number) is rejected. Over-rejection is safe — it fails
// the deploy, never corrupts data.
function compatibleType(cur: { type: string }, next: { type: string }): boolean {
  if (cur.type === next.type) return true;
  return next.type === "union" || next.type === "any" || cur.type === "any";
}

export function diffSchema(current: DeploySchema, next: DeploySchema): SchemaDiff {
  for (const name of Object.keys(current.tableNumbers)) {
    if (!(name in next.tableNumbers)) return { ok: false, reason: `table "${name}" was removed (destructive — rename/drop not supported)` };
    if (current.tableNumbers[name] !== next.tableNumbers[name])
      return { ok: false, reason: `table "${name}" tableNumber changed ${current.tableNumbers[name]}→${next.tableNumbers[name]} (destructive)` };

    const cur = fieldsOf(current, name);
    const nxt = fieldsOf(next, name);
    for (const [field, curV] of Object.entries(cur)) {
      const nxtV = nxt[field];
      if (nxtV === undefined) return { ok: false, reason: `field "${name}.${field}" was removed (destructive)` };
      if (!compatibleType(curV.fieldType, nxtV.fieldType))
        return { ok: false, reason: `field "${name}.${field}" changed type ${curV.fieldType.type}→${nxtV.fieldType.type} (destructive)` };
    }
    for (const [field, nxtV] of Object.entries(nxt)) {
      if (cur[field] === undefined && !nxtV.optional)
        return { ok: false, reason: `field "${name}.${field}" is a new required field on an existing table (destructive — existing rows lack it; make it optional)` };
    }
  }
  return { ok: true };
}
