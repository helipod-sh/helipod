/**
 * `@stackbase/storage` — the file-storage feature: the `_storage` system table, blob-backed
 * content addressing, and (in later tasks) the upload/download surface. This entrypoint currently
 * re-exports the `_storage` system-table definition, the foundation the rest of the feature builds
 * on.
 */
export { STORAGE_TABLE, STORAGE_TABLE_NUMBER, storageTableDefinition } from "./system-table";
export {
  storageContextProvider,
  storageEndpointPath,
  signUploadToken,
} from "./context";
export type {
  StorageProviderOpts,
  GenerateUploadUrlOpts,
  StorageWriter,
  StorageActionWriter,
} from "./context";
export { storageModules } from "./modules";
export type { StorageDoc } from "./modules";
export { createStorageToken, verifyStorageToken } from "./token";
export { storageRoutes } from "./http";
export type { StorageRouteDeps, StorageRoute } from "./http";
