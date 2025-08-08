/**
 * `@stackbase/values` — the Convex-compatible value system: the `Value` model, the
 * canonical total order, JSON transport encoding, the `v` validator builder, schema
 * builders, and `ConvexError`. This is the base package every other Stackbase package
 * imports its value types from (design §3.1).
 */
export type { Value, JSONValue, Cmp } from "./value";
export { compareValues, valuesEqual, isPlainObject } from "./value";

export type { GenericId, Id } from "./id";

export { convexToJson, jsonToConvex } from "./json";

export {
  Validator,
  v,
  validate,
  isValid,
} from "./validator";
export type {
  OptionalProperty,
  ValidationFailure,
  ValidatorJSON,
  ObjectFieldJSON,
  AnyValidator,
  PropertyValidators,
  Infer,
  ObjectType,
} from "./validator";

export {
  defineTable,
  defineSchema,
  TableDefinition,
  SchemaDefinition,
} from "./schema";
export type {
  RelationJSON,
  IndexDefinitionJSON,
  SearchIndexDefinitionJSON,
  VectorIndexDefinitionJSON,
  TableDefinitionJSON,
  SchemaDefinitionJSON,
} from "./schema";

export {
  storageDocumentFields,
  SYSTEM_TABLE_FIELDS,
  SYSTEM_TABLE_DEFINITIONS,
} from "./system-tables";

export { ConvexError } from "./convex-error";
