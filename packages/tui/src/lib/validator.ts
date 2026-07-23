/**
 * Renders a `ValidatorJSON` (helipod's schema/argument type representation) as the
 * source-like string a developer wrote — `v.string()`, `v.id("users")`,
 * `v.array(v.object({…}))`. Used by the Schema screen and the function runner so
 * both speak the same language as the user's `schema.ts`.
 */
export type ValidatorJSON =
  | { type: "null" | "boolean" | "number" | "bigint" | "string" | "bytes" | "any" }
  | { type: "literal"; value: unknown }
  | { type: "id"; tableName: string }
  | { type: "array"; value: ValidatorJSON }
  | { type: "record"; keys: ValidatorJSON; values: ValidatorJSON }
  | { type: "union"; value: ValidatorJSON[] }
  | { type: "object"; value: Record<string, { fieldType: ValidatorJSON; optional: boolean }> };

export function formatValidator(v: ValidatorJSON | undefined, depth = 0): string {
  if (!v) return "v.any()";
  switch (v.type) {
    case "id":
      return `v.id("${v.tableName}")`;
    case "literal":
      return `v.literal(${JSON.stringify(v.value)})`;
    case "array":
      return `v.array(${formatValidator(v.value, depth + 1)})`;
    case "record":
      return `v.record(${formatValidator(v.keys, depth + 1)}, ${formatValidator(v.values, depth + 1)})`;
    case "union":
      return `v.union(${v.value.map((x) => formatValidator(x, depth + 1)).join(", ")})`;
    case "object":
      return depth > 0 ? "v.object({…})" : "v.object({…})";
    default:
      return `v.${v.type}()`;
  }
}

/** Top-level fields of an object validator, in declaration order. */
export function objectFields(
  v: ValidatorJSON | undefined,
): Array<{ name: string; type: string; optional: boolean; raw: ValidatorJSON }> {
  if (!v || v.type !== "object") return [];
  return Object.entries(v.value).map(([name, f]) => ({
    name,
    type: formatValidator(f.fieldType),
    optional: f.optional,
    raw: f.fieldType,
  }));
}

/** Parses terminal input into the JSON value a validator expects. */
export function coerce(input: string, v: ValidatorJSON | undefined): unknown {
  const s = input.trim();
  if (s === "") return undefined;
  switch (v?.type) {
    case "number":
      return Number(s);
    case "boolean":
      return s === "true" || s === "1";
    case "string":
    case "id":
      return s;
    default:
      try {
        return JSON.parse(s);
      } catch {
        return s;
      }
  }
}
