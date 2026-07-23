import { test, expect } from "bun:test";
import { coalesce } from "../src/lib/coalesce";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("fires immediately on the first call, once at window end for a burst", async () => {
  let calls = 0;
  const c = coalesce(() => calls++, 100);
  // a burst of 40 "commits" back to back
  for (let i = 0; i < 40; i++) c.call();
  expect(calls).toBe(1);             // leading edge only, so far
  await wait(140);
  expect(calls).toBe(2);             // one trailing flush for the suppressed 39
  // quiet period → no further calls
  await wait(140);
  expect(calls).toBe(2);
  c.cancel();
});

test("a lone call fires once and does not double-fire", async () => {
  let calls = 0;
  const c = coalesce(() => calls++, 100);
  c.call();
  expect(calls).toBe(1);
  await wait(140);
  expect(calls).toBe(1);             // nothing suppressed → no trailing flush
  c.cancel();
});

test("cancel prevents a pending trailing flush", async () => {
  let calls = 0;
  const c = coalesce(() => calls++, 100);
  c.call(); c.call();                // one leading + one suppressed pending
  c.cancel();
  await wait(140);
  expect(calls).toBe(1);
});
