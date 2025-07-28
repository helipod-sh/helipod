/**
 * The table registry assigns each table a stable numeric id (embedded in document ids).
 * System tables (`_`-prefixed) get numbers 1–9999; user tables start at 10001, leaving a
 * reserved gap. The DocStore-backed durable registry arrives in M2; this in-memory one is
 * the canonical interface + the Tier 0 / test implementation.
 */
export type TableVisibility = "user" | "system";
export type TableState = "active" | "creating" | "deleting";

export interface TableInfo {
  name: string;
  tableNumber: number;
  visibility: TableVisibility;
  state: TableState;
  /** The document field used as the shard key (seam #1), or null. */
  shardKey: string | null;
}

export interface AllocateOptions {
  visibility?: TableVisibility;
  shardKey?: string | null;
}

export interface TableRegistry {
  getByName(name: string): TableInfo | undefined;
  getByNumber(tableNumber: number): TableInfo | undefined;
  allocate(name: string, options?: AllocateOptions): TableInfo;
  list(): TableInfo[];
}

export interface PreassignOptions {
  visibility?: TableVisibility;
  shardKey?: string | null;
  state?: TableState;
}

export const SYSTEM_TABLE_NUMBER_MIN = 1;
export const SYSTEM_TABLE_NUMBER_MAX = 9999;
export const USER_TABLE_NUMBER_START = 10001;

export function isSystemTableName(name: string): boolean {
  return name.startsWith("_");
}

export function getFullTableName(name: string, componentPath: string): string {
  return componentPath ? `${componentPath}/${name}` : name;
}

export function parseFullTableName(fullName: string): { componentPath: string; name: string } {
  const i = fullName.lastIndexOf("/");
  return i < 0 ? { componentPath: "", name: fullName } : { componentPath: fullName.slice(0, i), name: fullName.slice(i + 1) };
}

export class MemoryTableRegistry implements TableRegistry {
  private readonly byName = new Map<string, TableInfo>();
  private readonly byNumber = new Map<number, TableInfo>();
  private nextUser = USER_TABLE_NUMBER_START;
  private nextSystem = SYSTEM_TABLE_NUMBER_MIN;

  getByName(name: string): TableInfo | undefined {
    return this.byName.get(name);
  }

  getByNumber(tableNumber: number): TableInfo | undefined {
    return this.byNumber.get(tableNumber);
  }

  /** Idempotent: allocating an existing name returns the existing entry. */
  allocate(name: string, options: AllocateOptions = {}): TableInfo {
    const existing = this.byName.get(name);
    if (existing) return existing;

    const visibility = options.visibility ?? (isSystemTableName(name) ? "system" : "user");
    let tableNumber: number;
    if (visibility === "system") {
      if (this.nextSystem > SYSTEM_TABLE_NUMBER_MAX) throw new Error("exhausted system table numbers");
      tableNumber = this.nextSystem++;
    } else {
      tableNumber = this.nextUser++;
    }

    const info: TableInfo = {
      name,
      tableNumber,
      visibility,
      state: "active",
      shardKey: options.shardKey ?? null,
    };
    this.byName.set(name, info);
    this.byNumber.set(tableNumber, info);
    return info;
  }

  list(): TableInfo[] {
    return [...this.byName.values()];
  }

  /**
   * Pre-register a table at a KNOWN (already-live) number, so a later `allocate(name)` for the
   * same name returns this number instead of minting a fresh one — used to seed a fresh registry
   * with a running deploy's table numbers before composing a new schema, so existing tables
   * (app AND component) never renumber; only genuinely-new tables get numbers above the seeded
   * max. Idempotent/no-op if `name` is already known (first registration wins, matching
   * `allocate`'s idempotency). Bumps the relevant `next*` counter so future `allocate` calls
   * never collide with a preassigned number.
   */
  preassign(name: string, tableNumber: number, options: PreassignOptions = {}): TableInfo {
    const existing = this.byName.get(name);
    if (existing) return existing;

    const visibility = options.visibility ?? (isSystemTableName(name) ? "system" : "user");
    const info: TableInfo = {
      name,
      tableNumber,
      visibility,
      state: options.state ?? "active",
      shardKey: options.shardKey ?? null,
    };
    this.byName.set(name, info);
    this.byNumber.set(tableNumber, info);
    if (visibility === "system") {
      this.nextSystem = Math.max(this.nextSystem, tableNumber + 1);
    } else {
      this.nextUser = Math.max(this.nextUser, tableNumber + 1);
    }
    return info;
  }
}
