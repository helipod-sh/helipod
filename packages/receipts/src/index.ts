/**
 * `@helipod/receipts` — the recurring driver seam for the Receipted Outbox's server-side TTL
 * reaper (verdict §(c) Retention). The `client_mutations`/`client_floors` storage contract itself
 * (the DDL + `getClientVerdict`/`getClientFloor`/`recordClientVerdict`/`pruneClientMutations`/
 * `sweepExpiredClientMutations`) lives directly on `DocStore` (`@helipod/docstore` + its
 * `docstore-sqlite`/`docstore-postgres` implementations) — this package is just the periodic sweep
 * driver on top, mirroring `@helipod/storage`'s `storageReaper`.
 */
export { receiptsReaper } from "./reaper";
export type { ReceiptsReaperDriver } from "./reaper";
