# Parked CLI benchmarks

WebSocket end-to-end benchmarks (fan-out, reconnect-resume), relocated out of `test/` during the Phase-0
harness slice and renamed `*.bench.ts` so vitest skips them. They will become `@helipod/bench`
scenarios (reconnect axis / WS reactive variant) when activated.
