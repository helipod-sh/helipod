import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { CasConflict, type ObjectStore } from "@stackbase/objectstore";
import { KeyedMutex } from "./keyed-mutex";

export interface FsObjectStoreOpts {
  /** Root directory. Keys map to paths under it (parent dirs are created on demand). */
  dir: string;
}

function contentEtag(body: Uint8Array): string {
  // Opaque content-derived etag — mirrors S3's opaque-but-content-derived etag shape closely
  // enough for CAS purposes (identical bodies -> identical etag, any byte change -> new etag).
  return createHash("md5").update(body).digest("hex");
}

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Filesystem `ObjectStore` — CAS on local disk via a per-key in-process async mutex.
 *
 *  Single-process only: correctness of `casPut`'s read-etag→compare→write sequence depends on
 *  the mutex, which only serializes callers within this process. Fine for local dev and the
 *  conformance suite; a real multi-writer deployment needs a store with server-side CAS (S3
 *  If-Match, etc). */
export class FsObjectStore implements ObjectStore {
  private readonly dir: string;
  private readonly mutex = new KeyedMutex();

  constructor(opts: FsObjectStoreOpts) {
    this.dir = resolve(opts.dir);
  }

  private path(key: string): string {
    const p = resolve(this.dir, key);
    if (p !== this.dir && !p.startsWith(this.dir + sep)) {
      throw new Error(`invalid object key: ${key}`);
    }
    return p;
  }

  private async readIfExists(p: string): Promise<Buffer | null> {
    try {
      return await readFile(p);
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
  }

  /** Write atomically: temp file (unique name, same dir) + rename. mkdir -p the parent first. */
  private async atomicWrite(p: string, body: Uint8Array): Promise<void> {
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, body);
    await rename(tmp, p);
  }

  async putImmutable(key: string, body: Uint8Array): Promise<void> {
    const p = this.path(key);
    // Idempotent by key: a retry with the same key is a no-op, never a re-write.
    const existing = await this.readIfExists(p);
    if (existing !== null) return;
    await this.atomicWrite(p, body);
  }

  async casPut(key: string, body: Uint8Array, ifMatch: string | null): Promise<{ etag: string }> {
    const p = this.path(key);
    // Hold the per-key mutex for the WHOLE op: read current etag, compare, write. This is what
    // makes the one-winner race conformance case correct — without it, two concurrent callers
    // could both read the same current state, both pass the comparison, and both write.
    return this.mutex.run(key, async () => {
      const current = await this.readIfExists(p);
      if (ifMatch === null) {
        if (current !== null) throw new CasConflict();
      } else {
        if (current === null || contentEtag(current) !== ifMatch) throw new CasConflict();
      }
      await this.atomicWrite(p, body);
      return { etag: contentEtag(body) };
    });
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    const body = await this.readIfExists(this.path(key));
    if (body === null) return null;
    return { body, etag: contentEtag(body) };
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    const walk = async (dirPath: string, base: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dirPath, { withFileTypes: true });
      } catch (e) {
        if (isEnoent(e)) return;
        throw e;
      }
      for (const entry of entries) {
        // Keys always use "/" regardless of OS path separator.
        const key = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(resolve(dirPath, entry.name), key);
        } else if (entry.isFile() && !entry.name.includes(".tmp-")) {
          keys.push(key);
        }
      }
    };
    await walk(this.dir, "");
    return keys.filter((k) => k.startsWith(prefix));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }

  async assertCasSupported(): Promise<void> {
    // Resolves: this adapter supports CAS via the per-key mutex.
  }
}
