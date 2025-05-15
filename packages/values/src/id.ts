/**
 * A document id. At runtime an `Id` is just a string (the encoded developer id);
 * the brand is a compile-time tag carrying the table name so `Id<"messages">` and
 * `Id<"users">` are not interchangeable.
 */
declare const idBrand: unique symbol;

export type GenericId<TableName extends string = string> = string & {
  readonly [idBrand]: TableName;
};

export type Id<TableName extends string = string> = GenericId<TableName>;
