import { createHash } from "node:crypto";
import type { FileTree } from "./types";

/** Lowercase-hex sha256 over the utf8 code string. Identical on client and server — never a re-transpile. */
export function sha256Hex(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export interface DeltaPush {
  changed: Array<{ path: string; code: string }>;
  unchanged: Array<{ path: string; sha256: string }>;
}

/** Partition local files against the server's current per-path hashes. A file is `unchanged` iff the
 *  server has the same path with an equal sha256; otherwise `changed` (new or modified). A path the
 *  server has but the local tree lacks appears in neither list (deletion by omission). */
export function partitionModules(local: FileTree, remoteHashes: Record<string, string>): DeltaPush {
  const changed: Array<{ path: string; code: string }> = [];
  const unchanged: Array<{ path: string; sha256: string }> = [];
  for (const f of local.files) {
    const sha = sha256Hex(f.code);
    if (remoteHashes[f.path] === sha) unchanged.push({ path: f.path, sha256: sha });
    else changed.push({ path: f.path, code: f.code });
  }
  return { changed, unchanged };
}
