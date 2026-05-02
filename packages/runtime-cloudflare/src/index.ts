/**
 * `@stackbase/runtime-cloudflare` — the single-shard Cloudflare Durable Object host (Slice 3). A LEAF
 * host package: all Cloudflare shapes live here (as narrow structural interfaces) and in the deploy
 * rig; nothing below it (`runtime-embedded`/`transactor`/`sync`) ever references a Cloudflare type.
 *
 * The unified DO (`StackbaseDurableObject`) owns the OCC writer + DO-SQLite + WebSockets + the
 * subscription index + the wake alarm in ONE object, so a mutation's reactive fan-out is an in-process
 * call and the engine's shipped G1/G4 ordering guarantees survive by construction (decision 1).
 */
export { StackbaseDurableObject, type DurableObjectAppConfig } from "./durable-object";
export {
  createWorkerHandler,
  DEFAULT_SHARD_NAME,
  type WorkerHandler,
  type DurableObjectNamespaceLike,
  type DurableObjectStubLike,
  type DurableObjectIdLike,
  type DurableObjectGetOptions,
} from "./worker";
export {
  DEPLOYMENT_LOCATION_HINT_ENV,
  LOCATION_HINTS,
  KNOWN_LOCATION_HINTS,
  isValidLocationHint,
  type LocationHint,
} from "./location";
export { DurableObjectRuntimeHost, type DurableObjectServeOptions, type DurableObjectServerHandle } from "./host";
export { bootDurableObjectRuntime, type DurableObjectBootInput, type DurableObjectBoot } from "./boot";
export { DoAlarmWakeHost } from "./wake";
export { doSyncSocket } from "./do-socket";
export {
  MAX_SUBSCRIPTIONS_PER_SOCKET,
  newAttachment,
  readAttachment,
  wouldExceedCap,
  TooManySubscriptionsError,
  type StackbaseSocketAttachment,
  type PersistedSub,
} from "./attachment";
export { generateWorkerEntrySource, type WorkerEntryInputs } from "./worker-entry";
export type {
  DurableObjectStateLike,
  DurableObjectStorageLike,
  DoWebSocketLike,
  WebSocketPairLike,
} from "./cf-types";
