import { runBlobStoreConformance } from "../test-support/conformance";
import { MemoryBlobStore } from "../test-support/memory-blobstore";

runBlobStoreConformance("memory", () => new MemoryBlobStore());
