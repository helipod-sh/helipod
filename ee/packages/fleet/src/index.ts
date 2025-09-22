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
  fleetApplicationName,
  REPLICA_DB_FILENAME,
  FLEET_WRITER_SESSION_TIMEOUTS,
  keyToPointRange,
  type FleetHandles,
  type FleetPrep,
  type FleetRuntimeOptions,
  type StartFleetNodeDeps,
  type PromotionRunDeps,
} from "./node";
export { SwitchableDocStore } from "./switchable-store";
export { docKeyToPointRange } from "./ranges";
export { ReplicaTailer, type AppliedInvalidation, type ReplicaTailerOptions } from "./replica-tailer";
