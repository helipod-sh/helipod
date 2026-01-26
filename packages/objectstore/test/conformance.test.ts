import { runObjectStoreConformance } from "../test-support/conformance";
import { MemoryObjectStore } from "../test-support/memory-objectstore";

runObjectStoreConformance("memory", () => new MemoryObjectStore());
