/**
 * Trackpr 2.0, Phase 4B (P1 #3): unit tests for getCalendarConnectionResult,
 * against a hand-built mocked Supabase client - no real database. Mirrors
 * this codebase's own established mocked-client pattern
 * (lib/dashboard/queries.partial-data.test.ts). A live-database
 * counterpart (lib/calendar/connection.integration.test.ts) already covers
 * getCalendarConnection's real connected/disconnected behavior against real
 * fixtures - this file exists specifically because a real database read
 * cannot be made to fail on demand, and "the read failed" is exactly the
 * third state this phase needs proven.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/calendar/connection.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { getCalendarConnectionResult, getCalendarConnection }: typeof import("./connection") = require("./connection.ts");

type MockResult = { data: unknown; error: { message: string; code?: string } | null };

function makeMockSupabase(result: MockResult): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve(result),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

test("valid connected state: a real row resolves to a populated connection, failed is false", async () => {
  const supabase = makeMockSupabase({
    data: {
      id: "conn-1",
      account_email: "owner@example.com",
      calendar_id: "primary",
      calendar_name: "Primary",
      status: "connected",
      last_synced_at: "2026-09-01T00:00:00.000Z",
      last_error: null,
    },
    error: null,
  });

  const result = await getCalendarConnectionResult(supabase, "org-1");
  assert.equal(result.failed, false);
  assert.ok(result.connection);
  assert.equal(result.connection!.status, "connected");
  assert.equal(result.connection!.calendarId, "primary");

  // getCalendarConnection must keep delegating to the exact same read, unchanged for its existing callers.
  assert.deepEqual(await getCalendarConnection(supabase, "org-1"), result.connection);
});

test("valid disconnected state: no row is a genuine, successful null - never treated as a failure", async () => {
  const supabase = makeMockSupabase({ data: null, error: null });

  const result = await getCalendarConnectionResult(supabase, "org-1");
  assert.equal(result.failed, false);
  assert.equal(result.connection, null, "no row is an ordinary, common state - not a failure");

  assert.equal(await getCalendarConnection(supabase, "org-1"), null);
});

test("database error state: a real Postgrest error sets failed - must never be indistinguishable from 'no calendar connected'", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "connection reset by peer", code: "57P01" } });

  const result = await getCalendarConnectionResult(supabase, "org-1");
  assert.equal(result.failed, true);
  assert.equal(result.connection, null, "still resolves to null for the caller's convenience, but `failed` distinguishes this from a genuine disconnect");

  // The raw error must never leak into the returned shape.
  assert.equal(JSON.stringify(result).includes("57P01"), false);
  assert.equal(JSON.stringify(result).includes("connection reset"), false);

  // getCalendarConnection's own existing, unchanged contract: a failure still resolves to null, exactly as before this phase - its lower-stakes callers are unaffected.
  assert.equal(await getCalendarConnection(supabase, "org-1"), null);
});
