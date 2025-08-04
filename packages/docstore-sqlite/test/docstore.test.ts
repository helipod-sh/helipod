import { runDocStoreConformance } from "@stackbase/docstore/test-support/conformance";
import { NodeSqliteAdapter, SqliteDocStore } from "../src/index";

runDocStoreConformance(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter()); // in-memory
  await store.setupSchema();
  return store;
});
