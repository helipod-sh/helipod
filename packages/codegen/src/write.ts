/**
 * Write generated files to a `_generated/` directory (idempotent overwrite).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GeneratedFile } from "./generate";

export interface WriteResult {
  written: string[];
}

export function writeGenerated(files: readonly GeneratedFile[], outDir: string): WriteResult {
  const written: string[] = [];
  for (const file of files) {
    const fullPath = join(outDir, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, "utf8");
    written.push(fullPath);
  }
  return { written };
}
