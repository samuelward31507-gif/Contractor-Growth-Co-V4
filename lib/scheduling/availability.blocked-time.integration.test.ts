/**
 * Pass 2 (Native Calendar System): integration tests proving native
 * blocked time affects the authoritative availability engine
 * (lib/scheduling/availability.ts's getAvailableSlots) - the same function
 * the AI/SMS booking flow, the manual booking flow, and the calendar's own
 * availability display all already call. This is the single enforcement
 * point Phase 7/10/8 require ("the AI booking engine must not offer slots
 * that overlap blocked time"). REQUIRES the blocked_time migration to be
 * applied first (see supabase/migrations/20260925010000_blocked_time.sql).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/scheduling/availability.blocked-time.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

const envPath = path.join(REPO_ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getAvailableSlots }: typeof import("./availability") = require(path.join(REPO_ROOT, "lib/scheduling/availability.ts"));

const service = createServiceRoleClient();

let organizationId: string;

// 2027-05-17 is a Monday.
const MONDAY_RANGE = { start: new Date("2027-05-17T00:00:00.000Z"), end: new Date("2027-05-18T00:00:00.000Z") };

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Availability Blocked Time Test Org", payment_status: "active", timezone: "UTC" }).select("id").single();
  organizationId = org!.id;
  await service.from("business_hours").insert(
    ["monday", "tuesday", "wednesday", "thursday", "friday"].map((day) => ({ organization_id: organizationId, day_of_week: day, is_open: true, open_time: "09:00", close_time: "17:00" })),
  );
  await service.from("business_hours").insert(["saturday", "sunday"].map((day) => ({ organization_id: organizationId, day_of_week: day, is_open: false })));
  await service.from("booking_settings").insert({ organization_id: organizationId, booking_enabled: true, minimum_notice_minutes: 0, default_duration_minutes: 60, buffer_minutes: 0 });
});

after(async () => {
  await service.from("blocked_time").delete().eq("organization_id", organizationId);
  await service.from("business_hours").delete().eq("organization_id", organizationId);
  await service.from("booking_settings").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("without any blocked time, the full business-hours day is offered", async () => {
  const result = await getAvailableSlots(service, { organizationId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end });
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.slots.length, 8, "9am-5pm at 60-minute slots is 8 slots with no blocks");
  }
});

test("a native blocked period removes exactly the overlapping slot(s), never anything else", async () => {
  const { data: block } = await service.from("blocked_time").insert({ organization_id: organizationId, start_at: "2027-05-17T12:00:00.000Z", end_at: "2027-05-17T13:00:00.000Z", reason: "Lunch" }).select("id").single();
  try {
    const result = await getAvailableSlots(service, { organizationId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end });
    assert.equal(result.status, "available");
    if (result.status === "available") {
      assert.equal(result.slots.length, 7, "exactly one 60-minute slot removed by the 12-1pm block");
      assert.ok(!result.slots.some((slot) => slot.start_at === "2027-05-17T12:00:00.000Z"), "the blocked slot itself must never be offered");
    }
  } finally {
    await service.from("blocked_time").delete().eq("id", block!.id);
  }
});

test("blocked time and a real Trackpr appointment on the same day each independently remove their own slot", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15555750001" }).select("id").single();
  const { data: appointment } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contact!.id, title: "AC Repair", start_at: "2027-05-17T09:00:00.000Z", end_at: "2027-05-17T10:00:00.000Z", status: "scheduled" })
    .select("id")
    .single();
  const { data: block } = await service.from("blocked_time").insert({ organization_id: organizationId, start_at: "2027-05-17T14:00:00.000Z", end_at: "2027-05-17T15:00:00.000Z", reason: "Travel" }).select("id").single();

  try {
    const result = await getAvailableSlots(service, { organizationId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end });
    assert.equal(result.status, "available");
    if (result.status === "available") {
      assert.equal(result.slots.length, 6, "8 slots minus 1 real appointment minus 1 blocked period");
      assert.ok(!result.slots.some((slot) => slot.start_at === "2027-05-17T09:00:00.000Z"));
      assert.ok(!result.slots.some((slot) => slot.start_at === "2027-05-17T14:00:00.000Z"));
    }
  } finally {
    await service.from("appointments").delete().eq("id", appointment!.id);
    await service.from("blocked_time").delete().eq("id", block!.id);
    await service.from("contacts").delete().eq("id", contact!.id);
  }
});

test("buffer_minutes widens the conflict check around blocked time exactly like it does around a real appointment", async () => {
  await service.from("booking_settings").update({ buffer_minutes: 30 }).eq("organization_id", organizationId);
  const { data: block } = await service.from("blocked_time").insert({ organization_id: organizationId, start_at: "2027-05-17T13:00:00.000Z", end_at: "2027-05-17T14:00:00.000Z", reason: "Meeting" }).select("id").single();

  try {
    const result = await getAvailableSlots(service, { organizationId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end });
    assert.equal(result.status, "available");
    if (result.status === "available") {
      // 12-1pm and 2-3pm slots both fall within the 30-minute buffer around the 1-2pm block.
      assert.ok(!result.slots.some((slot) => slot.start_at === "2027-05-17T12:00:00.000Z"));
      assert.ok(!result.slots.some((slot) => slot.start_at === "2027-05-17T14:00:00.000Z"));
    }
  } finally {
    await service.from("blocked_time").delete().eq("id", block!.id);
    await service.from("booking_settings").update({ buffer_minutes: 0 }).eq("organization_id", organizationId);
  }
});

test("a cross-organization blocked period never affects this organization's availability", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Availability Blocked Time Test Org (Other)", payment_status: "active" }).select("id").single();
  const { data: block } = await service.from("blocked_time").insert({ organization_id: otherOrg!.id, start_at: "2027-05-17T09:00:00.000Z", end_at: "2027-05-17T17:00:00.000Z", reason: "Entire day" }).select("id").single();

  try {
    const result = await getAvailableSlots(service, { organizationId, dateRangeStart: MONDAY_RANGE.start, dateRangeEnd: MONDAY_RANGE.end });
    assert.equal(result.status, "available");
    if (result.status === "available") {
      assert.equal(result.slots.length, 8, "another organization's all-day block must never affect this organization's real availability");
    }
  } finally {
    await service.from("blocked_time").delete().eq("id", block!.id);
    await service.from("organizations").delete().eq("id", otherOrg!.id);
  }
});
