/**
 * Built-in **app-namespace** system tables — reserved `_`-prefixed tables that live in the
 * app root (unlike component tables, which are namespaced `component/*`). These are the single
 * source of truth for the built-in document shapes: codegen merges them into the generated
 * `DataModel` (so `Id<"_storage">`/`Doc<"_storage">`/`v.id("_storage")` type-check in user
 * schemas) and the feature packages that own them (`@stackbase/storage`) build their live
 * `TableDefinition` from the SAME field validators — no duplicated shape.
 *
 * `_storage` (the file-storage feature's document table, spec §4.3): a `pending` row is created
 * up front and promoted to `ready` once its bytes land; `size`/`contentType`/`sha256`/`expiresAt`
 * are therefore nullable (present-and-null while pending), not optional.
 */
import { v } from "./validator";
import type { PropertyValidators, ValidatorJSON } from "./validator";

/** The `_storage` document field validators (excludes the auto-added `_id`/`_creationTime`). */
export const storageDocumentFields = {
  status: v.union(v.literal("pending"), v.literal("ready")),
  key: v.string(),
  size: v.union(v.number(), v.null()),
  contentType: v.union(v.string(), v.null()),
  sha256: v.union(v.string(), v.null()),
  visibility: v.union(v.literal("private"), v.literal("public")),
  expiresAt: v.union(v.number(), v.null()),
} satisfies PropertyValidators;

/**
 * The live field validators for every built-in app-namespace system table, keyed by table
 * name. Feature packages import the fields they own (e.g. `@stackbase/storage` reads
 * `storageDocumentFields`) so the shape never diverges from what codegen emits.
 */
export const SYSTEM_TABLE_FIELDS = {
  _storage: storageDocumentFields,
} satisfies Record<string, PropertyValidators>;

/**
 * The document validator JSON for each built-in system table, keyed by name. This is what
 * codegen consumes to emit the system-table entries in `DataModel`. Derived from
 * {@link SYSTEM_TABLE_FIELDS} so there is exactly one source of truth.
 */
export const SYSTEM_TABLE_DEFINITIONS: Record<string, ValidatorJSON> = Object.fromEntries(
  Object.entries(SYSTEM_TABLE_FIELDS).map(([name, fields]) => [name, v.object(fields).toJSON()]),
);
