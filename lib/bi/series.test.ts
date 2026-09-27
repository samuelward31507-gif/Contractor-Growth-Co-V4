/**
 * Unit tests for buildDayBuckets - pure, no I/O. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test "lib/bi/series.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildDayBuckets }: typeof import("./series") = require("./series.ts");

test("a single calendar day [from, to) produces exactly one bucket", () => {
  const buckets = buildDayBuckets(new Date(2026, 0, 15).toISOString(), new Date(2026, 0, 16).toISOString());
  assert.deepEqual(buckets, ["2026-01-15"]);
});

test("a 7-day range produces exactly 7 consecutive day keys, `to` itself excluded (half-open)", () => {
  const buckets = buildDayBuckets(new Date(2026, 0, 1).toISOString(), new Date(2026, 0, 8).toISOString());
  assert.deepEqual(buckets, ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06", "2026-01-07"]);
});

test("a range crossing a month boundary buckets correctly across the boundary", () => {
  const buckets = buildDayBuckets(new Date(2026, 0, 30).toISOString(), new Date(2026, 1, 2).toISOString());
  assert.deepEqual(buckets, ["2026-01-30", "2026-01-31", "2026-02-01"]);
});

test("from === to produces zero buckets, never a crash or an infinite loop", () => {
  const buckets = buildDayBuckets(new Date(2026, 0, 15).toISOString(), new Date(2026, 0, 15).toISOString());
  assert.deepEqual(buckets, []);
});

test("from after to produces zero buckets, never a negative-length array or an infinite loop", () => {
  const buckets = buildDayBuckets(new Date(2026, 0, 20).toISOString(), new Date(2026, 0, 10).toISOString());
  assert.deepEqual(buckets, []);
});

test("a pathologically large range is capped rather than producing an unbounded array", () => {
  const buckets = buildDayBuckets(new Date(2000, 0, 1).toISOString(), new Date(2026, 0, 1).toISOString());
  assert.ok(buckets.length <= 366, `expected buckets to be capped at 366, got ${buckets.length}`);
});
