/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Thin re-export. `keyToPointRange`/`docKeyToPointRange` originally lived here (Tier 3 Slice 1/2);
 * Tier 3 Slice 8, Task 8.1 extracted them verbatim into `@stackbase/id-codec` (see that package's
 * `point-range.ts` for the full doc — including why `id-codec`, not `index-key-codec`, is the
 * cycle-free canonical home) so `ee/packages/objectstore-substrate`'s replica reactive-tailer wiring
 * could reuse the exact same conversion without depending on `@stackbase/fleet`. This module now
 * just re-exports both functions so fleet's own public API (`node.ts`/`index.ts`) and existing
 * tests (`test/point-range.test.ts`) are byte-for-byte unaffected by the move.
 */
export { keyToPointRange, docKeyToPointRange } from "@stackbase/id-codec";
