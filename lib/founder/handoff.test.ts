/**
 * Deal-to-client handoff (lib/founder/handoff.ts): what a deal needs before
 * it can be handed off, scope validation, the state shown on a deal, and the
 * out-of-date check that mirrors the database's confirm refusal.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/founder/handoff.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffMissing, handoffOutOfDate, handoffState, parseScope, type ClientHandoff } from "./handoff";
import type { FounderDeal } from "./model";
import { DEAL_DEFAULTS } from "./test-fixtures";

const won = (o: Partial<FounderDeal> = {}): FounderDeal => ({
  ...DEAL_DEFAULTS,
  id: "d1",
  name: "Acme Roofing",
  stage: "won",
  wonSetupFee: 2500,
  wonMonthlyFee: 1497,
  wonOn: "2026-10-01",
  contactName: "Dana Reyes",
  contactEmail: "dana@example.com",
  ...o,
});
const handoff = (o: Partial<ClientHandoff> = {}): ClientHandoff => ({
  id: "h1",
  dealId: "d1",
  status: "prepared",
  clientName: "Acme Roofing",
  contactName: "Dana Reyes",
  contactEmail: "dana@example.com",
  contactPhone: null,
  setupFee: 2500,
  monthlyFee: 1497,
  currency: "USD",
  scope: "Lead response automation and monthly reporting",
  preparedBy: "u1",
  preparedAt: "2026-10-09T18:00:00Z",
  confirmedBy: null,
  confirmedAt: null,
  cancelledBy: null,
  cancelledAt: null,
  cancelReason: null,
  agencyClientId: null,
  ...o,
});

test("missing information: won with split terms, a decision-maker, and an email or phone", () => {
  assert.deepEqual(handoffMissing(won()), []);
  assert.deepEqual(handoffMissing(won({ contactEmail: null, contactPhone: "555-0100" })), [], "a phone is enough");
  assert.deepEqual(handoffMissing(won({ stage: "negotiation", wonSetupFee: null, wonMonthlyFee: null })), ["the deal must be won", "agreed setup and monthly fees"]);
  assert.deepEqual(handoffMissing(won({ contactName: "  ", contactEmail: " ", contactPhone: null })), ["a decision-maker name", "a contact email or phone"]);
});

test("scope: 10 to 5,000 characters, trimmed", () => {
  assert.equal(parseScope("  too short ").ok, false);
  assert.equal(parseScope("x".repeat(5001)).ok, false);
  assert.deepEqual(parseScope("  Lead response automation  "), { ok: true, value: "Lead response automation" });
});

test("state: not won, missing info, ready, prepared, confirmed - cancelled ones kept as history", () => {
  assert.deepEqual(handoffState(won({ stage: "negotiation" }), []), { kind: "not_won" });
  assert.deepEqual(handoffState(won({ contactName: null }), []), { kind: "missing_info", missing: ["a decision-maker name"], cancelled: [] });
  const cancelled = handoff({ id: "h0", status: "cancelled", cancelledAt: "2026-10-08T00:00:00Z", cancelReason: "x", preparedAt: "2026-10-07T00:00:00Z" });
  assert.deepEqual(handoffState(won(), [cancelled]), { kind: "ready", cancelled: [cancelled] }, "a cancelled handoff doesn't block a new one");
  const prepared = handoff();
  assert.deepEqual(handoffState(won(), [cancelled, prepared]), { kind: "prepared", handoff: prepared, cancelled: [cancelled] });
  const confirmed = handoff({ status: "confirmed", confirmedAt: "2026-10-09T19:00:00Z", agencyClientId: "c1" });
  assert.deepEqual(handoffState(won(), [confirmed]), { kind: "confirmed", handoff: confirmed, cancelled: [], dealReopened: false });
  assert.equal((handoffState(won({ stage: "negotiation" }), [confirmed]) as { dealReopened: boolean }).dealReopened, true, "a reopened deal keeps its confirmed client, flagged");
  assert.equal(handoffState(won({ stage: "negotiation" }), [prepared]).kind, "prepared", "a prepared handoff on a reopened deal stays visible (so it can be cancelled)");
  assert.deepEqual(handoffState(won(), [handoff({ dealId: "other" })]), { kind: "ready", cancelled: [] }, "only this deal's handoffs count");
});

test("out of date: any carried field or the won stage changed since preparing", () => {
  const h = handoff();
  assert.equal(handoffOutOfDate(h, won()), false);
  assert.equal(handoffOutOfDate(h, won({ contactName: " Dana Reyes " })), false, "whitespace isn't a change");
  for (const change of [{ stage: "negotiation" as const }, { name: "Acme Roofing LLC" }, { contactEmail: "new@example.com" }, { contactPhone: "555" }, { wonSetupFee: 2000 }, { wonMonthlyFee: 1500 }, { currency: "CAD" }]) {
    assert.equal(handoffOutOfDate(h, won(change)), true, JSON.stringify(change));
  }
});
