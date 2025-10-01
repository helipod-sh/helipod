/**
 * Shards B2a (D7) — the codegen-time `shardBy` cross-check.
 *
 * Scoped down per the design spec (codegen reads validators, not handler bodies — static
 * write-association is beyond it): when a mutation declares `shardBy` as an arg NAME (the common
 * case — a resolver FUNCTION is opaque to codegen and always falls through to the kernel guards
 * at runtime, the always-on truth at every tier), this validates:
 *
 *   1. the named arg actually exists in the mutation's own `args` validator, and is REQUIRED
 *      (a shard key must resolve on every call — `v.optional(...)` would let a call route
 *      nowhere deterministic);
 *   2. when exactly ONE table in the schema shards by a field of the SAME name, the arg's
 *      validator type matches that field's type (so a write always routes to the shard its own
 *      document belongs on). Zero or more-than-one matching table is ambiguous — codegen can't
 *      know which table the mutation means, so the type check is skipped (kernel guards still
 *      catch a real mismatch at write time, per-document, regardless).
 *
 * Runs once per `push()` (dev boot + every hot reload, `serve` boot, `stackbase codegen`) — see
 * `packages/cli/src/project.ts`'s `loadProject`, the one place a `RegisteredFunction`'s runtime
 * `shardBy`/`argsJson` and the schema's `shardKey` metadata are both in scope together.
 */
import type { SchemaDefinitionJSON, ValidatorJSON } from "@stackbase/values";
import { validatorToTsType } from "./validator-to-ts";

/** One mutation's `shardBy` declaration, reduced to what the cross-check needs — extracted from a
 *  `RegisteredFunction` by the caller (only for `shardBy` values that are a plain string; a
 *  resolver function has no static arg name to check). */
export interface ShardByDeclaration {
  /** `"path:name"`, for error messages (e.g. `"messages:send"`). */
  functionPath: string;
  /** The arg name `shardBy` names. */
  argName: string;
  /** The mutation's own `args` validator JSON — undefined when it declared no `args` at all. */
  argsJson: ValidatorJSON | undefined;
}

function fieldNamesOf(json: ValidatorJSON): string[] {
  return json.type === "object" ? Object.keys(json.value) : [];
}

/** Validate every `shardBy` string declaration against the schema; returns one instructive
 *  message per violation (empty = all clean). Pure — no I/O, easy to unit test in isolation. */
export function validateShardByDeclarations(
  schema: SchemaDefinitionJSON,
  declarations: readonly ShardByDeclaration[],
): string[] {
  const errors: string[] = [];
  for (const { functionPath, argName, argsJson } of declarations) {
    if (!argsJson || argsJson.type !== "object") {
      errors.push(
        `${functionPath}: declares shardBy: ${JSON.stringify(argName)}, but has no args validator — ` +
          `add args: { ${argName}: v.<type>(), ... } so codegen (and the runtime) can confirm ` +
          `"${argName}" is a required argument every call must supply.`,
      );
      continue;
    }
    const field = argsJson.value[argName];
    if (!field) {
      const known = fieldNamesOf(argsJson).map((k) => JSON.stringify(k)).join(", ");
      errors.push(
        `${functionPath}: declares shardBy: ${JSON.stringify(argName)}, but "${argName}" is not one of its ` +
          `declared args (${known || "none"}) — add it to args, or point shardBy at a declared argument.`,
      );
      continue;
    }
    if (field.optional) {
      errors.push(
        `${functionPath}: shardBy argument "${argName}" is declared with v.optional(...) — a shard key must ` +
          `be required (every call must resolve to exactly one shard). Remove the optional wrapper from "${argName}".`,
      );
      continue;
    }
    // Type-match: only when EXACTLY one table shards by a field of this same name — 0 or >1 is
    // ambiguous, and codegen can't guess which table `shardBy` means (D7 scope-down); the kernel's
    // per-document ownership guard still catches a real mismatch at write time regardless.
    const shardedByThisName = Object.entries(schema.tables).filter(([, t]) => t.shardKey === argName);
    if (shardedByThisName.length !== 1) continue;
    const [tableName, table] = shardedByThisName[0]!;
    if (table.documentType.type !== "object") continue; // defensive — a table's document type is always an object
    const tableField = table.documentType.value[argName];
    if (!tableField) continue; // defensive — .shardKey(field) always names a declared field
    if (JSON.stringify(field.fieldType) !== JSON.stringify(tableField.fieldType)) {
      errors.push(
        `${functionPath}: shardBy argument "${argName}" has type ${validatorToTsType(field.fieldType)}, but ` +
          `table "${tableName}" shards by "${argName}" of type ${validatorToTsType(tableField.fieldType)} — ` +
          `the two must match so every write routes to the shard its own document belongs on.`,
      );
    }
  }
  return errors;
}

/** Join `validateShardByDeclarations`'s errors into one thrown `Error` (all violations at once,
 *  not just the first) — the shape `push()` throws on. No-op when there are none. */
export function assertShardByDeclarations(
  schema: SchemaDefinitionJSON,
  declarations: readonly ShardByDeclaration[],
): void {
  const errors = validateShardByDeclarations(schema, declarations);
  if (errors.length > 0) {
    throw new Error(`stackbase: invalid shardBy declaration(s):\n  - ${errors.join("\n  - ")}`);
  }
}
