/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
export const FLEET_VERSION = "0.0.0";
export { LeaseManager, type LeaseState, type LeaseRow, type LeaseManagerOptions } from "./lease";
export { LeaseMonitor, type LeaseMonitorDeps } from "./lease-monitor";
export { FencedError } from "./fenced-error";
export { NotifyingFanoutAdapter, type CommitChannelClient } from "./commit-notifier";
export { WriteForwarder, type WriteForwarderOptions, type ReplicaWaiter } from "./forwarder";
export {
  prepareFleetNode,
  startFleetNode,
  runPromotion,
  acquireShardAsWriter,
  installCommitGuard,
  relinquish,
  FrontierMonitor,
  fleetApplicationName,
  REPLICA_DB_FILENAME,
  FLEET_WRITER_SESSION_TIMEOUTS,
  DEFAULT_NUM_SHARDS,
  keyToPointRange,
  type FleetHandles,
  type FleetPrep,
  type FleetRuntimeOptions,
  type FrontierStats,
  type StartFleetNodeDeps,
  type PromotionRunDeps,
  type RelinquishDeps,
} from "./node";
export { SwitchableDocStore } from "./switchable-store";
export { docKeyToPointRange } from "./ranges";
export {
  ReplicaTailer,
  DensityViolationError,
  type AppliedInvalidation,
  type ReplicaTailerOptions,
} from "./replica-tailer";
export { stablePrefixFromFrontier, type StablePrefixTs } from "./stable-prefix";
