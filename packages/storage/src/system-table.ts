/**
 * The `_storage` built-in system table — the document metadata backing the file-storage feature.
 *
 * `_storage` is an **app-namespace** system table (it lives in the app root, not a `component/*`
 * namespace), so `Id<"_storage">` is a first-class typed reference in user schemas. Its document
 * shape is defined ONCE in `@stackbase/values` (`storageDocumentFields`) and consumed by both this
 * module (the live `TableDefinition` the engine registers) and codegen (the emitted `DataModel`),
 * so the two can never drift.
 *
 * The table NUMBER is reserved and stable in `@stackbase/id-codec` (`STORAGE_TABLE_NUMBER`): a
 * persisted `Id<"_storage">` encodes it, so it must decode to the same table forever.
 */
import { defineTable, storageDocumentFields } from "@stackbase/values";
import { STORAGE_TABLE_NUMBER } from "@stackbase/id-codec";

/** The reserved name of the file-storage document table. */
export const STORAGE_TABLE = "_storage";

/** The reserved, stable system-table number for `_storage` (see `@stackbase/id-codec`). */
export { STORAGE_TABLE_NUMBER };

/**
 * The live `_storage` `TableDefinition`, built from the canonical field validators in
 * `@stackbase/values`. `_id`/`_creationTime` are auto-added by the engine/codegen, as for every
 * table, so they are not in the field set.
 */
export const storageTableDefinition = defineTable(storageDocumentFields);
