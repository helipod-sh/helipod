import type { GuestDatabaseReader, GuestDatabaseWriter } from "@helipod/executor";

export interface RelSubject { type: string; id: string; relation?: string }
export interface RelObject { type: string; id: string }

/** The subject's (type, id, subjectRelation) triple; a missing `relation` means a direct subject. */
function subj(s: RelSubject): [string, string, string] { return [s.type, s.id, s.relation ?? ""]; }

/** Query a specific object#relation@subject tuple (exact point-read via byObject). */
function tupleRows(db: GuestDatabaseReader, obj: RelObject, relation: string, st: string, si: string, sr: string) {
  return db.query("relations", "byObject")
    .eq("objectType", obj.type).eq("objectId", obj.id).eq("relation", relation)
    .eq("subjectType", st).eq("subjectId", si).eq("subjectRelation", sr).collect();
}

export async function addRelationTuple(db: GuestDatabaseWriter, subject: RelSubject, relation: string, object: RelObject): Promise<void> {
  const [st, si, sr] = subj(subject);
  if ((await tupleRows(db, object, relation, st, si, sr)).length > 0) return; // idempotent
  await db.insert("relations", { objectType: object.type, objectId: object.id, relation, subjectType: st, subjectId: si, subjectRelation: sr });
}

export async function removeRelationTuple(db: GuestDatabaseWriter, subject: RelSubject, relation: string, object: RelObject): Promise<void> {
  const [st, si, sr] = subj(subject);
  for (const row of await tupleRows(db, object, relation, st, si, sr)) await db.delete(row._id as string);
}

/** The usersets a direct subject belongs to: every tuple where it is a direct subject → (objectType, objectId, relation). */
async function memberships(db: GuestDatabaseReader, st: string, si: string): Promise<Array<[string, string, string]>> {
  const rows = await db.query("relations", "bySubject").eq("subjectType", st).eq("subjectId", si).eq("subjectRelation", "").collect();
  return rows.map((r) => [r.objectType as string, r.objectId as string, r.relation as string]);
}

/** Does `subject` have `relation` to `object`? Direct, or (for a direct subject) via one of its usersets. */
export async function hasRelation(db: GuestDatabaseReader, subject: RelSubject, relation: string, object: RelObject): Promise<boolean> {
  const [st, si, sr] = subj(subject);
  if ((await tupleRows(db, object, relation, st, si, sr)).length > 0) return true;
  if (sr !== "") return false; // a userset subject is checked directly only
  for (const [gt, gid, mRel] of await memberships(db, st, si))
    if ((await tupleRows(db, object, relation, gt, gid, mRel)).length > 0) return true;
  return false;
}

/** Object ids of type `objectType` that `userId` has `relation` to — direct or via a group they belong to. */
export async function objectsWith(db: GuestDatabaseReader, userId: string, relation: string, objectType: string): Promise<string[]> {
  const out = new Set<string>();
  const direct = await db.query("relations", "bySubject").eq("subjectType", "user").eq("subjectId", userId).eq("subjectRelation", "").eq("relation", relation).collect();
  for (const r of direct) if (r.objectType === objectType) out.add(r.objectId as string);
  for (const [gt, gid, mRel] of await memberships(db, "user", userId)) {
    const grp = await db.query("relations", "bySubject").eq("subjectType", gt).eq("subjectId", gid).eq("subjectRelation", mRel).eq("relation", relation).collect();
    for (const r of grp) if (r.objectType === objectType) out.add(r.objectId as string);
  }
  return [...out];
}
