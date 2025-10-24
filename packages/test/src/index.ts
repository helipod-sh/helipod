export { flattenModules } from "./flatten";
export type { FlattenedModules } from "./flatten";
export { createTestStackbase } from "./harness";
export type { TestStackbase } from "./harness";
export type { CreateTestOptions } from "./compose";
export type { TestSubscription } from "./reactivity";
// Reactive fan-out benchmark harness — store-agnostic, so the real-Postgres variant in
// ee/packages/fleet can import it and pass a PostgresDocStore. See docs/dev/research/reactivity/.
export { runFanoutBench } from "./bench-fanout";
export type { FanoutBenchOpts, FanoutBenchResult } from "./bench-fanout";
