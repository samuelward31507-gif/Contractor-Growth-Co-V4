/**
 * Unit tests for lib/costs/sms-cost-events.ts's pure price/timestamp logic
 * (parseTwilioPrice, resolveOccurredAt) and its cost-calculation/idempotency
 * behavior against a hand-built mocked Supabase client - no real database,
 * no real Twilio call. Mirrors lib/costs/ai-cost-events.test.ts's exact
 * technique and file organization.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/costs/sms-cost-events.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { parseTwilioPrice, resolveOccurredAt, recordSmsCostEventForMessage }: typeof import("./sms-cost-events") = require("./sms-cost-events.ts");

// ---------------------------------------------------------------------------
// parseTwilioPrice
// ---------------------------------------------------------------------------

test("1. a normal negative Twilio price is correctly interpreted as a positive cost (Twilio's documented debit convention)", () => {
  const result = parseTwilioPrice("-0.00750", "usd");
  assert.deepEqual(result, { outcome: "known", cost: 0.0075 });
});

test("2. a real zero price ('0') is a valid known $0, never treated as missing", () => {
  const result = parseTwilioPrice("0", "usd");
  assert.deepEqual(result, { outcome: "known", cost: 0 });
});

test("3. a real zero price ('0.00') is also a valid known $0", () => {
  const result = parseTwilioPrice("0.00", "usd");
  assert.deepEqual(result, { outcome: "known", cost: 0 });
});

test("4. a null price means Twilio hasn't finalized it yet - unresolved, never $0", () => {
  const result = parseTwilioPrice(null, "usd");
  assert.deepEqual(result, { outcome: "unresolved", reason: "price_not_yet_available" });
});

test("5. an empty-string price is treated the same as null - unresolved", () => {
  const result = parseTwilioPrice("   ", "usd");
  assert.deepEqual(result, { outcome: "unresolved", reason: "price_not_yet_available" });
});

test("6. a missing currency (priceUnit) is unresolved, even with a real price present", () => {
  const result = parseTwilioPrice("-0.0075", null);
  assert.deepEqual(result, { outcome: "unresolved", reason: "missing_currency" });
});

test("7. a malformed, non-numeric price is rejected, never coerced or crashed on", () => {
  const result = parseTwilioPrice("not-a-number", "usd");
  assert.deepEqual(result, { outcome: "rejected", reason: "malformed_price" });
});

test("8. an anomalous positive non-zero price is rejected, never silently accepted as normal", () => {
  const result = parseTwilioPrice("0.0075", "usd");
  assert.deepEqual(result, { outcome: "rejected", reason: "anomalous_positive_price" });
});

// ---------------------------------------------------------------------------
// resolveOccurredAt
// ---------------------------------------------------------------------------

test("9. dateSent is used for occurred_at when present", () => {
  const dateSent = new Date("2026-06-01T12:00:00Z");
  const dateCreated = new Date("2026-06-01T11:00:00Z");
  assert.equal(resolveOccurredAt(dateSent, dateCreated), dateSent.toISOString());
});

test("10. dateCreated is used as a fallback only when dateSent is absent", () => {
  const dateCreated = new Date("2026-06-01T11:00:00Z");
  assert.equal(resolveOccurredAt(null, dateCreated), dateCreated.toISOString());
});

test("11. both absent returns null - never fabricates a timestamp from now()", () => {
  assert.equal(resolveOccurredAt(null, null), null);
});

// ---------------------------------------------------------------------------
// recordSmsCostEventForMessage - mocked Twilio fetch + mocked Supabase upsert
// ---------------------------------------------------------------------------

function makeMockSupabase(upsertResult: { error: { message: string } | null } = { error: null }): SupabaseClient {
  return {
    from: () => ({ upsert: () => Promise.resolve(upsertResult) }),
  } as unknown as SupabaseClient;
}

const BASE_INPUT = {
  organizationId: "org-1",
  sourceMessageId: "message-1",
  providerMessageId: "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  direction: "outbound" as const,
};

test("12. a successful fetch with a valid price persists a known cost event", async () => {
  const supabase = makeMockSupabase();
  const result = await recordSmsCostEventForMessage(supabase, {
    ...BASE_INPUT,
    fetchFn: async () => ({
      ok: true,
      message: { price: "-0.0075", priceUnit: "usd", numSegments: "1", numMedia: "0", status: "delivered", dateSent: new Date("2026-06-01T00:00:00Z"), dateCreated: new Date("2026-06-01T00:00:00Z"), direction: "outbound-api" },
    }),
  });
  assert.deepEqual(result, { outcome: "known", cost: 0.0075, currency: "usd" });
});

test("13. a permanently failed Twilio fetch never creates a cost event", async () => {
  const supabase = makeMockSupabase();
  const result = await recordSmsCostEventForMessage(supabase, {
    ...BASE_INPUT,
    fetchFn: async () => ({ ok: false, error: "Twilio message fetch failed (code 20404)" }),
  });
  assert.equal(result.outcome, "fetch_failed");
});

test("14. a price still unavailable (null) at fetch time never creates a cost event", async () => {
  const supabase = makeMockSupabase();
  const result = await recordSmsCostEventForMessage(supabase, {
    ...BASE_INPUT,
    fetchFn: async () => ({
      ok: true,
      message: { price: null, priceUnit: null, numSegments: null, numMedia: null, status: "sent", dateSent: null, dateCreated: new Date(), direction: "outbound-api" },
    }),
  });
  assert.equal(result.outcome, "unresolved");
});

test("15. numSegments/numMedia are persisted as parsed integers when the upsert succeeds", async () => {
  let capturedRow: Record<string, unknown> | undefined;
  const supabase = {
    from: () => ({
      upsert: (row: Record<string, unknown>) => {
        capturedRow = row;
        return Promise.resolve({ error: null });
      },
    }),
  } as unknown as SupabaseClient;

  await recordSmsCostEventForMessage(supabase, {
    ...BASE_INPUT,
    fetchFn: async () => ({
      ok: true,
      message: { price: "-0.02", priceUnit: "usd", numSegments: "2", numMedia: "1", status: "delivered", dateSent: new Date("2026-06-01T00:00:00Z"), dateCreated: null, direction: "outbound-api" },
    }),
  });

  assert.equal(capturedRow?.num_segments, 2);
  assert.equal(capturedRow?.num_media, 1);
  assert.equal(capturedRow?.provider_status, "delivered");
  assert.equal(capturedRow?.direction, "outbound");
  assert.equal(capturedRow?.provider, "twilio");
  assert.equal(capturedRow?.service, "sms");
});

test("16. inbound direction is persisted as given, independent of Twilio's own more granular direction string", async () => {
  let capturedRow: Record<string, unknown> | undefined;
  const supabase = {
    from: () => ({
      upsert: (row: Record<string, unknown>) => {
        capturedRow = row;
        return Promise.resolve({ error: null });
      },
    }),
  } as unknown as SupabaseClient;

  await recordSmsCostEventForMessage(supabase, {
    ...BASE_INPUT,
    direction: "inbound",
    fetchFn: async () => ({
      ok: true,
      message: { price: "-0.0075", priceUnit: "usd", numSegments: "1", numMedia: "0", status: "received", dateSent: new Date("2026-06-01T00:00:00Z"), dateCreated: null, direction: "inbound" },
    }),
  });

  assert.equal(capturedRow?.direction, "inbound");
  assert.deepEqual(capturedRow?.metadata, { twilio_direction: "inbound" });
});

test("17. a write error from the upsert surfaces as an 'error' outcome, never silently swallowed as 'known'", async () => {
  const supabase = makeMockSupabase({ error: { message: "connection reset" } });
  const result = await recordSmsCostEventForMessage(supabase, {
    ...BASE_INPUT,
    fetchFn: async () => ({
      ok: true,
      message: { price: "-0.0075", priceUnit: "usd", numSegments: "1", numMedia: "0", status: "delivered", dateSent: new Date(), dateCreated: null, direction: "outbound-api" },
    }),
  });
  assert.equal(result.outcome, "error");
});

test("18. a failed/undelivered message still gets a real fetch attempt and trusts whatever price Twilio reports - status is never used to guess $0", async () => {
  const supabase = makeMockSupabase();
  const result = await recordSmsCostEventForMessage(supabase, {
    ...BASE_INPUT,
    fetchFn: async () => ({
      ok: true,
      message: { price: "-0.0075", priceUnit: "usd", numSegments: "1", numMedia: "0", status: "undelivered", dateSent: new Date("2026-06-01T00:00:00Z"), dateCreated: null, direction: "outbound-api" },
    }),
  });
  assert.deepEqual(result, { outcome: "known", cost: 0.0075, currency: "usd" });
});
