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

// v1 rejects ANY field-type change — including apparent "widenings" like string→union or any→string.
// The simplified field shape here doesn't carry union members, so we can't safely verify a widening
// is actually sound (e.g. any→string would invalidate existing non-string rows; string→union isn't
// safe unless the old type is provably a member of the new union, which we can't check). Strict
// equality is over-rejection-safe: it only fails a deploy, never corrupts data.
function compatibleType(cur: { type: string }, next: { type: string }): boolean {
  return cur.type === next.type;
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
      if (curV.optional && !nxtV.optional)
        return { ok: false, reason: `field "${name}.${field}" became required (destructive — existing rows may omit it)` };
    }
    for (const [field, nxtV] of Object.entries(nxt)) {
      if (cur[field] === undefined && !nxtV.optional)
        return { ok: false, reason: `field "${name}.${field}" is a new required field on an existing table (destructive — existing rows lack it; make it optional)` };
    }
  }
  return { ok: true };
}
