/**
 * Resolves table/index *names* (what user code uses) to the numeric ids and field lists the
 * engine needs. In M5 this is built directly from `IndexSpec`s; later it's derived from the
 * generated schema. The kernel uses it for query planning and index maintenance.
 */
import type { IndexSpec } from "@stackbase/query-engine";

export interface TableMeta {
  name: string;
  tableNumber: number;
}

export interface IndexCatalog {
  getTable(name: string): TableMeta | undefined;
  getTableByNumber(tableNumber: number): TableMeta | undefined;
  getIndex(table: string, index: string): IndexSpec | undefined;
  indexesForTable(table: string): IndexSpec[];
}

export class SimpleIndexCatalog implements IndexCatalog {
  private readonly tables = new Map<string, TableMeta>();
  private readonly tablesByNumber = new Map<number, TableMeta>();
  private readonly indexes = new Map<string, IndexSpec>();
  private readonly indexesByTable = new Map<string, IndexSpec[]>();

  addTable(name: string, tableNumber: number): this {
    const meta: TableMeta = { name, tableNumber };
    this.tables.set(name, meta);
    this.tablesByNumber.set(tableNumber, meta);
    if (!this.indexesByTable.has(name)) this.indexesByTable.set(name, []);
    return this;
  }

  addIndex(spec: IndexSpec): this {
    if (!this.tables.has(spec.table)) this.addTable(spec.table, spec.tableNumber);
    this.indexes.set(`${spec.table}.${spec.index}`, spec);
    this.indexesByTable.get(spec.table)!.push(spec);
    return this;
  }

  getTable(name: string): TableMeta | undefined {
    return this.tables.get(name);
  }
  getTableByNumber(tableNumber: number): TableMeta | undefined {
    return this.tablesByNumber.get(tableNumber);
  }
  getIndex(table: string, index: string): IndexSpec | undefined {
    return this.indexes.get(`${table}.${index}`);
  }
  indexesForTable(table: string): IndexSpec[] {
    return this.indexesByTable.get(table) ?? [];
  }
}
