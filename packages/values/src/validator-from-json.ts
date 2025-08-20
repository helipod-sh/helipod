// packages/values/src/validator-from-json.ts
import { v, type AnyValidator, type PropertyValidators, type ValidatorJSON } from "./validator";
import { jsonToConvex } from "./json";

type Literal = string | number | bigint | boolean;

/**
 * Reconstruct a live `Validator` from the `ValidatorJSON` the engine stores (schema arrives
 * as JSON, not live validators). Reuses the concrete `v.*` validators — so validation semantics
 * are identical to the `v` builder and the test harness, never a second implementation.
 */
export function validatorFromJson(json: ValidatorJSON): AnyValidator {
  switch (json.type) {
    case "null": return v.null();
    case "boolean": return v.boolean();
    case "number": return v.number();
    case "bigint": return v.int64();
    case "string": return v.string();
    case "bytes": return v.bytes();
    case "any": return v.any();
    case "id": return v.id(json.tableName);
    case "literal": return v.literal(jsonToConvex(json.value) as Literal);
    case "array": return v.array(validatorFromJson(json.value));
    case "record": return v.record(validatorFromJson(json.keys), validatorFromJson(json.values));
    case "union": return v.union(...json.value.map(validatorFromJson));
    case "object": {
      const fields: PropertyValidators = {};
      for (const [key, field] of Object.entries(json.value)) {
        const inner = validatorFromJson(field.fieldType);
        fields[key] = field.optional ? v.optional(inner) : inner;
      }
      return v.object(fields);
    }
  }
}
