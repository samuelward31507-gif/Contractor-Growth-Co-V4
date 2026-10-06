/**
 * Trackpr 2.0, Phase 4C (P2 #5): unit tests for processNoShowDetection's
 * `scanFailed` signal, against a hand-built mocked Supabase client - no real
 * database. A real Postgrest error cannot be forced on demand against a
 * live database, so this is the only way to exercise the failure path
 * directly - mirrors this codebase's own established mocked-client pattern
 * (lib/dashboard/queries.partial-data.test.ts).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/no-show-detection.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { processNoShowDetection }: typeof import("./no-show-detection") = require("./no-show-detection.ts");

type MockResult = { data: unknown; error: { message: string } | null };

function makeMockSupabase(scanResult: MockResult, filters: string[] = []): SupabaseClient {
  const builder = {
    select: () => builder,
    in: () => builder,
    lt: (c: string, v: string) => (filters.push(`lt ${c} ${v}`), builder),
    gte: (c: string, v: string) => (filters.push(`gte ${c} ${v}`), builder),
    order: () => builder,
    limit: () => Promise.resolve(scanResult),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

test("a genuinely empty, successful scan never sets scanFailed - 'nothing due right now' and 'the scan failed' remain two different things", async () => {
  const supabase = makeMockSupabase({ data: [], error: null });
  const result = await processNoShowDetection(supabase);
  assert.equal(result.scanFailed, false);
  assert.equal(result.candidates, 0);
  assert.deepEqual(result.outcomes, []);
});

test("a real Postgrest error on the candidate scan sets scanFailed, and never fabricates a candidate count or outcome", async () => {
  const supabase = makeMockSupabase({ data: null, error: { message: "connection reset by peer" } });
  const result = await processNoShowDetection(supabase);
  assert.equal(result.scanFailed, true);
  assert.equal(result.candidates, 0, "no fabricated non-zero count on failure - the honest signal is scanFailed, not a guessed candidate total");
  assert.deepEqual(result.outcomes, []);
});

test("P0-B B0: the candidate scan is bounded on BOTH sides - ended more than the grace period ago AND within the last 24 hours", async () => {
  const { NO_SHOW_GRACE_PERIOD_MS, NO_SHOW_MAX_AGE_MS }: typeof import("./no-show-detection") = require("./no-show-detection.ts");
  const now = new Date("2027-03-10T15:00:00.000Z");
  const filters: string[] = [];
  await processNoShowDetection(makeMockSupabase({ data: [], error: null }, filters), now);
  assert.deepEqual(filters, [
    `lt end_at ${new Date(now.getTime() - NO_SHOW_GRACE_PERIOD_MS).toISOString()}`,
    `gte end_at ${new Date(now.getTime() - NO_SHOW_MAX_AGE_MS).toISOString()}`,
  ]);
});
