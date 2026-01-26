import { CasConflict, type ObjectStore } from "../src/types";

interface Entry {
  body: Uint8Array;
  etag: string;
}

/** In-memory `ObjectStore` reference implementation. Self-tests the conformance suite and doubles
 *  as a reusable test-double for later slices. Etags are a per-store monotonic counter (not a
 *  content hash) — guaranteed to CHANGE on every successful write regardless of body content,
 *  which is exactly the property `casPut`'s one-winner semantics depend on. */
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Entry>();
  private seq = 0;

  private nextEtag(): string {
    this.seq += 1;
    return String(this.seq);
  }

  async putImmutable(key: string, body: Uint8Array): Promise<void> {
    // idempotent by key: a retry with the same key is a no-op, never a re-write
    if (this.objects.has(key)) return;
    this.objects.set(key, { body: body.slice(), etag: this.nextEtag() });
  }

  async casPut(key: string, body: Uint8Array, ifMatch: string | null): Promise<{ etag: string }> {
    const current = this.objects.get(key);
    if (ifMatch === null) {
      if (current) throw new CasConflict();
    } else {
      if (!current || current.etag !== ifMatch) throw new CasConflict();
    }
    const etag = this.nextEtag();
    this.objects.set(key, { body: body.slice(), etag });
    return { etag };
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return { body: entry.body.slice(), etag: entry.etag };
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async assertCasSupported(): Promise<void> {
    // in-memory Map operations are effectively atomic under JS's single-threaded event loop
  }
}
