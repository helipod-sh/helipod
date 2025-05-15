/**
 * Runtime validators with a compile-time `Infer` bridge — the Convex-compatible `v`
 * builder. A validator both (a) checks a `Value` at runtime and (b) serializes to a
 * `ValidatorJSON` the codegen and dashboard consume.
 */
import type { JSONValue, Value } from "./value";
import { isPlainObject, valuesEqual } from "./value";
import { convexToJson } from "./json";
import type { GenericId } from "./id";

export type OptionalProperty = "optional" | "required";

export interface ValidationFailure {
  /** Dotted path to the offending node, e.g. `messages.body` or `tags[0]`. */
  path: string;
  message: string;
}

export interface ObjectFieldJSON {
  fieldType: ValidatorJSON;
  optional: boolean;
}

export type ValidatorJSON =
  | { type: "null" }
  | { type: "boolean" }
  | { type: "number" }
  | { type: "bigint" }
  | { type: "string" }
  | { type: "bytes" }
  | { type: "any" }
  | { type: "literal"; value: JSONValue }
  | { type: "id"; tableName: string }
  | { type: "array"; value: ValidatorJSON }
  | { type: "record"; keys: ValidatorJSON; values: ValidatorJSON }
  | { type: "union"; value: ValidatorJSON[] }
  | { type: "object"; value: Record<string, ObjectFieldJSON> };

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}
function indexPath(path: string, i: number): string {
  return `${path || "<root>"}[${i}]`;
}

export abstract class Validator<T = Value, IsOptional extends OptionalProperty = "required"> {
  /** Phantom carrier for {@link Infer}; never present at runtime. */
  declare readonly _output: T;
  abstract readonly kind: string;
  readonly isOptional: IsOptional;

  constructor(isOptional: IsOptional = "required" as IsOptional) {
    this.isOptional = isOptional;
  }

  abstract check(value: Value, path: string, out: ValidationFailure[]): void;
  abstract toJSON(): ValidatorJSON;
}

export type AnyValidator = Validator<any, OptionalProperty>;
export type PropertyValidators = Record<string, AnyValidator>;

export type Infer<V extends AnyValidator> = V extends Validator<infer T, OptionalProperty> ? T : never;

type OptionalKeys<F extends PropertyValidators> = {
  [K in keyof F]: F[K] extends Validator<any, "optional"> ? K : never;
}[keyof F];
type RequiredKeys<F extends PropertyValidators> = Exclude<keyof F, OptionalKeys<F>>;

export type ObjectType<F extends PropertyValidators> = {
  [K in RequiredKeys<F>]: Infer<F[K]>;
} & {
  [K in OptionalKeys<F>]?: Infer<F[K]>;
};

/* -------------------------------------------------------------------------- */
/* Concrete validators                                                        */
/* -------------------------------------------------------------------------- */

class NullValidator extends Validator<null> {
  readonly kind = "null";
  check(value: Value, path: string, out: ValidationFailure[]): void {
    if (value !== null) out.push({ path: path || "<root>", message: "expected null" });
  }
  toJSON(): ValidatorJSON {
    return { type: "null" };
  }
}

class BooleanValidator extends Validator<boolean> {
  readonly kind = "boolean";
  check(value: Value, path: string, out: ValidationFailure[]): void {
    if (typeof value !== "boolean") out.push({ path: path || "<root>", message: "expected boolean" });
  }
  toJSON(): ValidatorJSON {
    return { type: "boolean" };
  }
}

class Float64Validator extends Validator<number> {
  readonly kind = "number";
  check(value: Value, path: string, out: ValidationFailure[]): void {
    if (typeof value !== "number") out.push({ path: path || "<root>", message: "expected number (float64)" });
  }
  toJSON(): ValidatorJSON {
    return { type: "number" };
  }
}

class Int64Validator extends Validator<bigint> {
  readonly kind = "bigint";
  check(value: Value, path: string, out: ValidationFailure[]): void {
    if (typeof value !== "bigint") out.push({ path: path || "<root>", message: "expected bigint (int64)" });
  }
  toJSON(): ValidatorJSON {
    return { type: "bigint" };
  }
}

class StringValidator extends Validator<string> {
  readonly kind = "string";
  check(value: Value, path: string, out: ValidationFailure[]): void {
    if (typeof value !== "string") out.push({ path: path || "<root>", message: "expected string" });
  }
  toJSON(): ValidatorJSON {
    return { type: "string" };
  }
}

class BytesValidator extends Validator<ArrayBuffer> {
  readonly kind = "bytes";
  check(value: Value, path: string, out: ValidationFailure[]): void {
    if (!(value instanceof ArrayBuffer)) out.push({ path: path || "<root>", message: "expected bytes" });
  }
  toJSON(): ValidatorJSON {
    return { type: "bytes" };
  }
}

class AnyValidatorImpl extends Validator<any> {
  readonly kind = "any";
  check(): void {
    /* anything is valid */
  }
  toJSON(): ValidatorJSON {
    return { type: "any" };
  }
}

class IdValidator<TableName extends string> extends Validator<GenericId<TableName>> {
  readonly kind = "id";
  constructor(readonly tableName: TableName) {
    super("required");
  }
  check(value: Value, path: string, out: ValidationFailure[]): void {
    if (typeof value !== "string") out.push({ path: path || "<root>", message: `expected Id<"${this.tableName}">` });
  }
  toJSON(): ValidatorJSON {
    return { type: "id", tableName: this.tableName };
  }
}

type Literal = string | number | bigint | boolean;
class LiteralValidator<L extends Literal> extends Validator<L> {
  readonly kind = "literal";
  constructor(readonly value: L) {
    super("required");
  }
  check(value: Value, path: string, out: ValidationFailure[]): void {
    if (!valuesEqual(value, this.value as Value)) {
      out.push({ path: path || "<root>", message: `expected literal ${String(this.value)}` });
    }
  }
  toJSON(): ValidatorJSON {
    return { type: "literal", value: convexToJson(this.value as Value) };
  }
}

class ArrayValidator<E extends AnyValidator> extends Validator<Array<Infer<E>>> {
  readonly kind = "array";
  constructor(readonly element: E) {
    super("required");
  }
  check(value: Value, path: string, out: ValidationFailure[]): void {
    if (!Array.isArray(value)) {
      out.push({ path: path || "<root>", message: "expected array" });
      return;
    }
    for (let i = 0; i < value.length; i++) this.element.check(value[i]!, indexPath(path, i), out);
  }
  toJSON(): ValidatorJSON {
    return { type: "array", value: this.element.toJSON() };
  }
}

class RecordValidator<K extends AnyValidator, V extends AnyValidator> extends Validator<
  Record<string, Infer<V>>
> {
  readonly kind = "record";
  constructor(
    readonly keys: K,
    readonly values: V,
  ) {
    super("required");
  }
  check(value: Value, path: string, out: ValidationFailure[]): void {
    if (!isPlainObject(value)) {
      out.push({ path: path || "<root>", message: "expected record object" });
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      this.keys.check(k, joinPath(path, k), out);
      this.values.check(v, joinPath(path, k), out);
    }
  }
  toJSON(): ValidatorJSON {
    return { type: "record", keys: this.keys.toJSON(), values: this.values.toJSON() };
  }
}

class UnionValidator<M extends AnyValidator[]> extends Validator<Infer<M[number]>> {
  readonly kind = "union";
  readonly members: M;
  constructor(...members: M) {
    super("required");
    this.members = members;
  }
  check(value: Value, path: string, out: ValidationFailure[]): void {
    for (const member of this.members) {
      const trial: ValidationFailure[] = [];
      member.check(value, path, trial);
      if (trial.length === 0) return;
    }
    out.push({ path: path || "<root>", message: "did not match any member of union" });
  }
  toJSON(): ValidatorJSON {
    return { type: "union", value: this.members.map((m) => m.toJSON()) };
  }
}

class OptionalValidator<T> extends Validator<T | undefined, "optional"> {
  readonly kind = "optional";
  constructor(readonly inner: Validator<T, OptionalProperty>) {
    super("optional");
  }
  check(value: Value, path: string, out: ValidationFailure[]): void {
    this.inner.check(value, path, out);
  }
  toJSON(): ValidatorJSON {
    return this.inner.toJSON();
  }
}

class ObjectValidator<F extends PropertyValidators> extends Validator<ObjectType<F>> {
  readonly kind = "object";
  constructor(readonly fields: F) {
    super("required");
  }
  check(value: Value, path: string, out: ValidationFailure[]): void {
    if (!isPlainObject(value)) {
      out.push({ path: path || "<root>", message: "expected object" });
      return;
    }
    for (const key of Object.keys(this.fields)) {
      const fieldValidator = this.fields[key]!;
      const optional = fieldValidator.isOptional === "optional";
      const present = Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
      if (!present) {
        if (!optional) out.push({ path: joinPath(path, key), message: "missing required field" });
        continue;
      }
      fieldValidator.check(value[key]!, joinPath(path, key), out);
    }
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(this.fields, key)) {
        out.push({ path: joinPath(path, key), message: "unexpected extra field" });
      }
    }
  }
  toJSON(): ValidatorJSON {
    const value: Record<string, ObjectFieldJSON> = {};
    for (const [key, fieldValidator] of Object.entries(this.fields)) {
      value[key] = {
        fieldType: fieldValidator.toJSON(),
        optional: fieldValidator.isOptional === "optional",
      };
    }
    return { type: "object", value };
  }
}

/* -------------------------------------------------------------------------- */
/* The `v` builder + validate API                                             */
/* -------------------------------------------------------------------------- */

export const v = {
  id: <TableName extends string>(tableName: TableName) => new IdValidator(tableName),
  null: () => new NullValidator(),
  boolean: () => new BooleanValidator(),
  number: () => new Float64Validator(),
  float64: () => new Float64Validator(),
  int64: () => new Int64Validator(),
  bigint: () => new Int64Validator(),
  string: () => new StringValidator(),
  bytes: () => new BytesValidator(),
  any: () => new AnyValidatorImpl(),
  literal: <L extends Literal>(value: L) => new LiteralValidator(value),
  array: <E extends AnyValidator>(element: E) => new ArrayValidator(element),
  object: <F extends PropertyValidators>(fields: F) => new ObjectValidator(fields),
  record: <K extends AnyValidator, V extends AnyValidator>(keys: K, values: V) =>
    new RecordValidator(keys, values),
  union: <M extends AnyValidator[]>(...members: M) => new UnionValidator(...members),
  optional: <V extends AnyValidator>(inner: V) =>
    new OptionalValidator<Infer<V>>(inner as Validator<Infer<V>, OptionalProperty>),
};

/** Validate a value against a validator; returns all failures (empty = valid). */
export function validate(validator: AnyValidator, value: Value): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  validator.check(value, "", out);
  return out;
}

export function isValid(validator: AnyValidator, value: Value): boolean {
  return validate(validator, value).length === 0;
}
