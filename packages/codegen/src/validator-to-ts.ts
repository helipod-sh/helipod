/**
 * Emit a TypeScript type from a `ValidatorJSON`. This is the heart of codegen: a schema's
 * validators (`v.object({...})`) become the document types app code is checked against. The
 * mapping mirrors the value model — `v.id("users")` → `Id<"users">`, `v.int64()` → `bigint`,
 * `v.optional(...)` → an optional object field, etc.
 */
import { jsonToConvex, type JSONValue, type ValidatorJSON } from "@stackbase/values";

export interface TypeEmitContext {
  /** Indentation prefix for nested object types (cosmetic). */
  indent?: string;
}

function emitLiteral(json: JSONValue): string {
  const v = jsonToConvex(json);
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "number":
      return String(v);
    case "bigint":
      return `${v}n`;
    case "boolean":
      return String(v);
    default:
      return "never";
  }
}

export function validatorToTsType(json: ValidatorJSON): string {
  switch (json.type) {
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "bigint":
      return "bigint";
    case "string":
      return "string";
    case "bytes":
      return "ArrayBuffer";
    case "any":
      return "any";
    case "id":
      return `Id<${JSON.stringify(json.tableName)}>`;
    case "literal":
      return emitLiteral(json.value);
    case "array":
      return `Array<${validatorToTsType(json.value)}>`;
    case "record":
      // Record keys are strings/ids at runtime; the value type is what matters for app code.
      return `Record<string, ${validatorToTsType(json.values)}>`;
    case "union":
      return json.value.length === 0 ? "never" : `(${json.value.map(validatorToTsType).join(" | ")})`;
    case "object": {
      const fields = Object.entries(json.value).map(
        ([key, field]) => `${key}${field.optional ? "?" : ""}: ${validatorToTsType(field.fieldType)}`,
      );
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
    }
  }
}

/** Convert a live validator (anything with `toJSON()`) to its JSON form. */
export function validatorToJson(validator: { toJSON(): ValidatorJSON }): ValidatorJSON {
  return validator.toJSON();
}
