/**
 * Pass 2 (Native Calendar System): pure unit tests for the Day/Week grid
 * positioning math (app/(app)/calendar/_lib/grid.ts).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/calendar/_lib/grid.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { localMinutesSinceMidnight, getGridBounds, computeBlockPosition, HOUR_HEIGHT_PX }: typeof import("./grid") = require("./grid.ts");

test("localMinutesSinceMidnight: UTC", () => {
  assert.equal(localMinutesSinceMidnight("2027-03-01T14:30:00.000Z", "UTC"), 14 * 60 + 30);
});

test("localMinutesSinceMidnight: America/Denver (MST, UTC-7) - not the same as the raw UTC clock time", () => {
  // 14:30 UTC is 07:30 in America/Denver (MST) on this date.
  assert.equal(localMinutesSinceMidnight("2027-03-01T14:30:00.000Z", "America/Denver"), 7 * 60 + 30);
});

test("getGridBounds: derives the visible range from real open business hours, not a hardcoded assumption", () => {
  const hours = [
    { id: "1", organization_id: "org", day_of_week: "monday" as const, is_open: true, open_time: "08:00", close_time: "17:00", created_at: "", updated_at: "" },
    { id: "2", organization_id: "org", day_of_week: "tuesday" as const, is_open: true, open_time: "09:00", close_time: "20:00", created_at: "", updated_at: "" },
  ];
  assert.deepEqual(getGridBounds(hours), { startHour: 8, endHour: 20 });
});

test("getGridBounds: closed days are ignored", () => {
  const hours = [
    { id: "1", organization_id: "org", day_of_week: "monday" as const, is_open: true, open_time: "09:00", close_time: "17:00", created_at: "", updated_at: "" },
    { id: "2", organization_id: "org", day_of_week: "sunday" as const, is_open: false, open_time: null, close_time: null, created_at: "", updated_at: "" },
  ];
  assert.deepEqual(getGridBounds(hours), { startHour: 9, endHour: 17 });
});

test("getGridBounds: no business hours configured falls back to a sane default, never a single-row grid", () => {
  const bounds = getGridBounds([]);
  assert.ok(bounds.endHour > bounds.startHour);
});

test("getGridBounds: extraMinutes widens the grid to include an out-of-hours appointment/blocked time", () => {
  const hours = [{ id: "1", organization_id: "org", day_of_week: "monday" as const, is_open: true, open_time: "09:00", close_time: "17:00", created_at: "", updated_at: "" }];
  const bounds = getGridBounds(hours, [18 * 60 + 30]); // 6:30pm appointment, after normal close.
  assert.equal(bounds.endHour, 19);
});

test("computeBlockPosition: a normal in-hours appointment maps directly to pixel top/height", () => {
  const bounds = { startHour: 8, endHour: 18 };
  // 9:00-10:00 within an 8am-6pm grid: top = 1 hour in = 60px, height = 1 hour = 60px.
  const position = computeBlockPosition(9 * 60, 10 * 60, bounds);
  assert.equal(position.topPx, HOUR_HEIGHT_PX);
  assert.equal(position.heightPx, HOUR_HEIGHT_PX);
});

test("computeBlockPosition: never produces a negative top even for an appointment starting before the grid", () => {
  const bounds = { startHour: 8, endHour: 18 };
  const position = computeBlockPosition(6 * 60, 7 * 60, bounds);
  assert.equal(position.topPx, 0);
});

test("computeBlockPosition: a very short appointment still gets a minimum visible height", () => {
  const bounds = { startHour: 8, endHour: 18 };
  const position = computeBlockPosition(9 * 60, 9 * 60 + 5, bounds);
  assert.ok(position.heightPx >= 18);
});
