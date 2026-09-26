/**
 * Trackpr 2.0, Phase 4B (P1 #3): a focused unit test proving getAvailableSlots
 * fails closed - never silently proceeds as "no calendar connected" - when
 * the calendar connection lookup itself returns a real Postgrest error.
 * Against a hand-built mocked Supabase client (no real database), mirroring
 * this codebase's own established mocked-client pattern
 * (lib/dashboard/queries.partial-data.test.ts). The genuine connected/
 * disconnected success paths through getAvailableSlots are already covered
 * by the real-database integration tests in this directory and are
 * unaffected by this phase's change - this file exists specifically to
 * prove the one new branch, since a real database read cannot be made to
 * fail on demand.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/scheduling/availability.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { getAvailableSlots }: typeof import("./availability") = require("./availability.ts");

type MockResult = { data: unknown; error: { message: string } | null };

function makeMockSupabase(tableResults: Record<string, MockResult>): SupabaseClient {
  function makeBuilder(result: MockResult) {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      lt: () => builder,
      gt: () => builder,
      in: () => builder,
      maybeSingle: () => Promise.resolve(result),
      then: (resolve: (value: MockResult) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  }
  return {
    from: (table: string) => makeBuilder(tableResults[table] ?? { data: [], error: null }),
  } as unknown as SupabaseClient;
}

test("P1 #3: a real database error on the calendar connection lookup fails closed with calendar_unavailable, never silently proceeding as if no calendar were connected", async () => {
  const supabase = makeMockSupabase({
    booking_settings: { data: { booking_enabled: true, minimum_notice_minutes: 0, default_duration_minutes: 60, buffer_minutes: 0 }, error: null },
    business_hours: { data: [{ day_of_week: "monday", is_open: true, open_time: "09:00", close_time: "17:00" }], error: null },
    organizations: { data: { timezone: "America/Denver" }, error: null },
    calendar_connections: { data: null, error: { message: "connection reset by peer" } },
  });

  const result = await getAvailableSlots(supabase, {
    organizationId: "org-1",
    dateRangeStart: new Date("2027-03-01T00:00:00.000Z"),
    dateRangeEnd: new Date("2027-03-02T00:00:00.000Z"),
  });

  assert.equal(result.status, "calendar_unavailable", "a database failure on the connection lookup must fail closed, never silently behave as 'no calendar connected'");
  if (result.status === "calendar_unavailable") {
    // The raw error must never leak into the customer/contractor-facing reason.
    assert.equal(result.reason.includes("connection reset"), false);
  }
});
