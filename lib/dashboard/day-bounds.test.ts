/**
 * organizationDayBounds - the organization's own calendar day as UTC
 * instants, so Today's "today" never rolls over at the server's (UTC)
 * midnight. Covers a normal day, the two Denver DST transition days of 2026,
 * the exact boundaries, and the invalid-zone fallback.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/dashboard/day-bounds.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { organizationDayBounds }: typeof import("./sql") = require(path.join(process.cwd(), "lib/dashboard/sql.ts"));

const DENVER = "America/Denver";
const HOUR = 3_600_000;
const iso = (bounds: { dayStart: Date; dayEnd: Date }) => [bounds.dayStart.toISOString(), bounds.dayEnd.toISOString()];

test("a normal Denver day (MDT, UTC-6) runs local midnight to local midnight - 24 hours", () => {
  const bounds = organizationDayBounds(new Date("2026-09-30T16:00:00Z"), DENVER);
  assert.deepEqual(iso(bounds), ["2026-09-30T06:00:00.000Z", "2026-10-01T06:00:00.000Z"]);
  assert.equal(bounds.dayEnd.getTime() - bounds.dayStart.getTime(), 24 * HOUR);
});

test("6 PM Denver (00:00 UTC next day) is still the same Denver day - Today no longer rolls over at the server's midnight", () => {
  const sixPm = organizationDayBounds(new Date("2026-10-01T00:00:00Z"), DENVER);
  const lateEvening = organizationDayBounds(new Date("2026-10-01T05:30:00Z"), DENVER);
  assert.deepEqual(iso(sixPm), ["2026-09-30T06:00:00.000Z", "2026-10-01T06:00:00.000Z"]);
  assert.deepEqual(iso(lateEvening), iso(sixPm), "11:30 PM Denver is the same day as 6 PM");
});

test("the boundaries are exact: local midnight opens the next day, one millisecond before still belongs to the old one", () => {
  const atMidnight = organizationDayBounds(new Date("2026-10-01T06:00:00Z"), DENVER);
  const justBefore = organizationDayBounds(new Date("2026-10-01T05:59:59.999Z"), DENVER);
  assert.deepEqual(iso(atMidnight), ["2026-10-01T06:00:00.000Z", "2026-10-02T06:00:00.000Z"]);
  assert.deepEqual(iso(justBefore), ["2026-09-30T06:00:00.000Z", "2026-10-01T06:00:00.000Z"]);
});

test("2026-03-08 (spring forward): the Denver day starts at MST midnight and ends at MDT midnight - 23 hours", () => {
  for (const instant of ["2026-03-08T07:00:00Z", "2026-03-08T12:00:00Z", "2026-03-09T05:59:59Z"]) {
    const bounds = organizationDayBounds(new Date(instant), DENVER);
    assert.deepEqual(iso(bounds), ["2026-03-08T07:00:00.000Z", "2026-03-09T06:00:00.000Z"], instant);
    assert.equal(bounds.dayEnd.getTime() - bounds.dayStart.getTime(), 23 * HOUR);
  }
});

test("2026-11-01 (fall back): the Denver day starts at MDT midnight and ends at MST midnight - 25 hours", () => {
  for (const instant of ["2026-11-01T06:00:00Z", "2026-11-01T08:30:00Z", "2026-11-02T06:59:59Z"]) {
    const bounds = organizationDayBounds(new Date(instant), DENVER);
    assert.deepEqual(iso(bounds), ["2026-11-01T06:00:00.000Z", "2026-11-02T07:00:00.000Z"], instant);
    assert.equal(bounds.dayEnd.getTime() - bounds.dayStart.getTime(), 25 * HOUR);
  }
});

test("the days either side of each transition are ordinary 24-hour days that meet it exactly", () => {
  assert.deepEqual(iso(organizationDayBounds(new Date("2026-03-07T18:00:00Z"), DENVER)), ["2026-03-07T07:00:00.000Z", "2026-03-08T07:00:00.000Z"]);
  assert.deepEqual(iso(organizationDayBounds(new Date("2026-03-09T18:00:00Z"), DENVER)), ["2026-03-09T06:00:00.000Z", "2026-03-10T06:00:00.000Z"]);
  assert.deepEqual(iso(organizationDayBounds(new Date("2026-10-31T18:00:00Z"), DENVER)), ["2026-10-31T06:00:00.000Z", "2026-11-01T06:00:00.000Z"]);
  assert.deepEqual(iso(organizationDayBounds(new Date("2026-11-02T18:00:00Z"), DENVER)), ["2026-11-02T07:00:00.000Z", "2026-11-03T07:00:00.000Z"]);
});

test("other zones and the fallback: UTC is midnight-to-midnight UTC, east-of-UTC zones work, an unknown zone falls back to UTC instead of throwing", () => {
  assert.deepEqual(iso(organizationDayBounds(new Date("2026-09-30T16:00:00Z"), "UTC")), ["2026-09-30T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
  assert.deepEqual(iso(organizationDayBounds(new Date("2026-09-30T23:30:00Z"), "Asia/Tokyo")), ["2026-09-30T15:00:00.000Z", "2026-10-01T15:00:00.000Z"]);
  assert.deepEqual(iso(organizationDayBounds(new Date("2026-09-30T16:00:00Z"), "Not/AZone")), ["2026-09-30T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
});
