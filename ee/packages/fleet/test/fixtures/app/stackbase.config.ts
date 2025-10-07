import { defineScheduler } from "@stackbase/scheduler";

// Composes `@stackbase/scheduler` so the multi-writer E2E can prove the driver-forward path: the
// scheduler's recurring driver runs on the DEFAULT-shard holder, and a scheduled `messages:send`
// whose channelId routes to a shard held by a DIFFERENT writer must forward cross-node to that shard
// owner (T2 forward + T5 drivers-follow-default). The existing (non-scheduling) scenarios never
// enqueue a job, so the driver stays quiet for them — composing it is inert unless used.
export default { components: [defineScheduler()] };
