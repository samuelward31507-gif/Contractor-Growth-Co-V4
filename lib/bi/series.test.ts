/**
 * Unit tests for buildDayBuckets - pure, no I/O. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test "lib/bi/series.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildDayBuckets, countByDay }: typeof import("./series") = require("./series.ts");

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

// ---------------------------------------------------------------------------
// Phase 2A: organization-timezone buckets (Analytics)
// ---------------------------------------------------------------------------

const DENVER = "America/Denver";

test("Denver: buckets are Denver calendar days between local midnights", () => {
  // Denver's Sep 28-30 = [2026-09-28T06:00Z, 2026-10-01T06:00Z).
  assert.deepEqual(buildDayBuckets("2026-09-28T06:00:00.000Z", "2026-10-01T06:00:00.000Z", DENVER), ["2026-09-28", "2026-09-29", "2026-09-30"]);
});

test("Denver: a UTC timestamp after UTC midnight lands on the previous Denver calendar day", () => {
  const range = { from: "2026-09-29T06:00:00.000Z", to: "2026-10-01T06:00:00.000Z" };
  // 01:00Z Oct 1 = 19:00 MDT Sep 30; 05:59Z Oct 1 = 23:59 MDT Sep 30; 06:30Z Sep 30 = 00:30 MDT Sep 30.
  const series = countByDay(["2026-10-01T01:00:00Z", "2026-10-01T05:59:00Z", "2026-09-30T06:30:00Z", "2026-09-29T12:00:00Z"], range, DENVER);
  assert.deepEqual(series, [{ date: "2026-09-29", count: 1 }, { date: "2026-09-30", count: 3 }]);
});

test("Denver DST: spring-forward and fall-back weeks still produce exactly one bucket per calendar day", () => {
  // Mar 4-10 2026 contains the 23-hour Mar 8; Oct 28 - Nov 3 contains the 25-hour Nov 1.
  assert.deepEqual(buildDayBuckets("2026-03-04T07:00:00.000Z", "2026-03-11T06:00:00.000Z", DENVER), ["2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
  assert.deepEqual(buildDayBuckets("2026-10-28T06:00:00.000Z", "2026-11-04T07:00:00.000Z", DENVER), ["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
  // 23:30 MST on Nov 1 (06:30Z Nov 2) still belongs to Nov 1.
  const series = countByDay(["2026-11-02T06:30:00Z"], { from: "2026-11-01T06:00:00.000Z", to: "2026-11-02T07:00:00.000Z" }, DENVER);
  assert.deepEqual(series, [{ date: "2026-11-01", count: 1 }]);
});

test("no timezone: buckets and counts keep the server-local behavior", () => {
  const from = new Date(2026, 0, 1).toISOString();
  const to = new Date(2026, 0, 4).toISOString();
  assert.deepEqual(buildDayBuckets(from, to), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  const series = countByDay([new Date(2026, 0, 2, 23, 30).toISOString()], { from, to });
  assert.deepEqual(series.map((point) => point.count), [0, 1, 0]);
});
