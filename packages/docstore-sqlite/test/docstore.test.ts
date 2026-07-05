import { runDocStoreConformance } from "@helipod/docstore/test-support/conformance";
import { NodeSqliteAdapter, SqliteDocStore } from "../src/index";

runDocStoreConformance("sqlite", async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter()); // in-memory
  await store.setupSchema();
  return store;
});
