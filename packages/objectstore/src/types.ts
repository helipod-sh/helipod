/** Thrown when a conditional PUT's If-Match etag no longer matches (someone else wrote first).
 *  Detect structurally by `.name`/`.code`, robust across dist/src duplication — never rely on
 *  `instanceof` alone across package boundaries. */
export class CasConflict extends Error {
  readonly code = "CAS_CONFLICT";
  constructor(message = "object-store CAS conflict (If-Match etag moved)") {
    super(message);
    this.name = "CasConflict";
  }
}

/** True for a CasConflict from any realm (structural check). */
export function isCasConflict(e: unknown): boolean {
  return (e as { code?: string } | null | undefined)?.code === "CAS_CONFLICT";
}

export interface ObjectStore {
  /** Immutable write (segments). Idempotent by key — a retry with the same key is a no-op. */
  putImmutable(key: string, body: Uint8Array): Promise<void>;
  /** Conditional write — the commit LINEARIZATION POINT. `ifMatch: null` ⇒ create-only (If-None-Match:*).
   *  Returns the new etag on success; throws `CasConflict` if the etag moved / object already exists. */
  casPut(key: string, body: Uint8Array, ifMatch: string | null): Promise<{ etag: string }>;
  /** Read with the current etag (for a subsequent CAS). Null if absent. */
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>;
  /** List keys under a prefix (frontier enumeration, segment discovery, GC). */
  list(prefix: string): Promise<string[]>;
  /** Delete (segment/snapshot GC). May be eventually consistent on real stores. */
  delete(key: string): Promise<void>;
  /** Probe the store's conditional-write support; throw if CAS is unsupported (boot fail-fast). */
  assertCasSupported(): Promise<void>;
}
