import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runObjectStoreConformance } from "@stackbase/objectstore/test-support/conformance";
import { FsObjectStore } from "../src/fs-objectstore";

const dir = mkdtempSync(join(tmpdir(), "sb-fs-objectstore-"));
runObjectStoreConformance(
  "fs",
  () => new FsObjectStore({ dir }),
  () => rmSync(dir, { recursive: true, force: true }),
);
