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
  /** Immutable write (segments). Idempotent by key — a retry with the SAME key + bytes is a no-op.
   *  KEEP-FIRST on every adapter (fs/memory/s3): if the key already exists, the write is silently
   *  dropped and the EXISTING object wins — never an error, never an overwrite. Callers must still
   *  honor immutability in practice (never intentionally `putImmutable` a key with different bytes),
   *  but callers relying on the Tier-3 fence depend on this keep-first guarantee to hold even when
   *  they DON'T: a fenced/zombie writer reusing a segment seqno must never be able to clobber a live,
   *  manifest-referenced segment (s3 achieves this via a create-only conditional PUT,
   *  `IfNoneMatch: "*"`, treating the precondition failure as a no-op rather than an error). */
  putImmutable(key: string, body: Uint8Array): Promise<void>;
  /** Conditional write — the commit LINEARIZATION POINT. `ifMatch: null` ⇒ create-only (If-None-Match:*);
   *  otherwise a compare-and-swap on the current etag (If-Match). Returns the new etag on success; throws
   *  `CasConflict` if the etag moved / the object already exists.
   *
   *  Two properties later slices (the manifest fence) MUST respect:
   *  - **etag semantics are content-derived** on the real adapters (fs/s3 use a content hash / S3's ETag),
   *    so an A→B→A content sequence reuses an etag (classic ABA — a stale `ifMatch` could match again).
   *    A CAS-updated object (the manifest) therefore MUST carry a MONOTONE field (`epoch`/`tsCounter`) so
   *    its content never repeats. (The `MemoryObjectStore` reference uses a monotone counter etag and is
   *    thus MORE forgiving than the real adapters — run Slice-2+ CAS correctness tests against fs/s3, not
   *    only memory.)
   *  - **cross-process CAS is adapter-dependent:** `objectstore-s3` is server-side (safe across processes);
   *    `objectstore-fs` is a single-process in-memory-mutex CAS (dev/test only — two processes over one
   *    dir can both win). Multi-writer deployments require a server-side-CAS store (S3/R2/MinIO). */
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
