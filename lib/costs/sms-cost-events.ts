import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchTwilioMessage, type FetchTwilioMessageResult } from "@/lib/automation/sms-fetch";

/**
 * Trackpr Phase 5D-4 - the SMS cost-event creation engine. Writes exactly
 * one append-only sms_cost_events row per successfully-priced messages row,
 * using the exact upsert-with-ignoreDuplicates idempotency pattern already
 * proven for ai_cost_events/revenue_events - never a SELECT-then-INSERT.
 *
 * Unlike AI cost, there is no rate_cards lookup here at all: Twilio's own
 * fetched `price` IS the authoritative historical cost directly. This
 * file's entire job is fetch -> validate -> freeze -> persist, nothing more.
 *
 * Automatic delayed-price reconciliation is explicitly out of scope for this
 * phase (see the Phase 5D-4 audit's own scope lock). A message whose price
 * isn't yet finalized at the moment of this one best-effort attempt simply
 * produces no row - it is never retried by anything in this module, and it
 * is reported as "unknown" by lib/agency/costs.ts, not "unpriced" (there is
 * no rate-card concept for this provider to distinguish a missing rate
 * from).
 */

export type TwilioPriceOutcome =
  | { outcome: "known"; cost: number }
  | { outcome: "unresolved"; reason: string }
  | { outcome: "rejected"; reason: string };

/**
 * Pure, no I/O - directly unit-testable. Twilio's documented convention
 * returns `price` as a negative decimal string representing a debit (e.g.
 * "-0.00750") - this is the NORMAL, expected case, not an error; the real
 * cost is Math.abs() of it. A genuine "0"/"0.00" is a real, known zero cost,
 * never treated as missing. A raw POSITIVE non-zero value contradicts
 * Twilio's own documented convention and is treated as anomalous - logged
 * for investigation by the caller, never silently accepted as though
 * nothing is unusual.
 */
export function parseTwilioPrice(rawPrice: string | null, rawCurrency: string | null): TwilioPriceOutcome {
  if (rawPrice === null || rawPrice.trim() === "") {
    return { outcome: "unresolved", reason: "price_not_yet_available" };
  }
  if (rawCurrency === null || rawCurrency.trim() === "") {
    return { outcome: "unresolved", reason: "missing_currency" };
  }

  const numeric = Number(rawPrice);
  if (!Number.isFinite(numeric)) {
    return { outcome: "rejected", reason: "malformed_price" };
  }
  if (numeric > 0) {
    return { outcome: "rejected", reason: "anomalous_positive_price" };
  }

  return { outcome: "known", cost: Math.abs(numeric) };
}

/**
 * Pure, no I/O. dateSent is Twilio's own record of when the message was
 * actually sent (outbound) or received (inbound) - the real historical
 * business-event moment. dateCreated (when the Twilio resource record
 * itself was created) is only a fallback for the rare case dateSent is
 * absent. Never "now" - see this module's own header comment.
 */
export function resolveOccurredAt(dateSent: Date | null, dateCreated: Date | null): string | null {
  if (dateSent) return dateSent.toISOString();
  if (dateCreated) return dateCreated.toISOString();
  return null;
}

/** Twilio returns these as decimal strings that are always non-negative integers in practice - descriptive fields only, never gating whether a cost event is KNOWN (only price/currency do that). A malformed value here is stored as null rather than blocking the whole cost event. */
function parseNonNegativeIntOrNull(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export type SmsDirection = "inbound" | "outbound";

export type RecordSmsCostEventInput = {
  organizationId: string;
  sourceMessageId: string;
  providerMessageId: string;
  /** Trackpr's own messages.direction for this row - never Twilio's own more granular direction string, which is preserved in metadata instead. */
  direction: SmsDirection;
  /** Test seam only - production callers must never pass this; defaults to the real Twilio-backed fetchTwilioMessage, mirroring lib/automation/sms.ts's own sendSmsFn convention. */
  fetchFn?: (providerMessageId: string) => Promise<FetchTwilioMessageResult>;
};

export type RecordSmsCostEventResult =
  | { outcome: "known"; cost: number; currency: string }
  | { outcome: "unresolved"; reason: string }
  | { outcome: "rejected"; reason: string }
  | { outcome: "fetch_failed"; error: string }
  | { outcome: "error"; error: string };

/**
 * The one place an sms_cost_events row is ever written. Never estimates,
 * never applies a local rate, never converts currencies, never combines
 * currencies, never invents a price. Every non-"known" outcome writes no
 * row at all - there is no placeholder, no $0, no partial record.
 */
export async function recordSmsCostEventForMessage(
  service: SupabaseClient,
  input: RecordSmsCostEventInput,
): Promise<RecordSmsCostEventResult> {
  const fetchFn = input.fetchFn ?? fetchTwilioMessage;
  const fetched = await fetchFn(input.providerMessageId);
  if (!fetched.ok) return { outcome: "fetch_failed", error: fetched.error };

  const priceOutcome = parseTwilioPrice(fetched.message.price, fetched.message.priceUnit);
  if (priceOutcome.outcome !== "known") return priceOutcome;

  const occurredAt = resolveOccurredAt(fetched.message.dateSent, fetched.message.dateCreated);
  if (!occurredAt) return { outcome: "unresolved", reason: "missing_occurred_at" };

  const currency = fetched.message.priceUnit!.toLowerCase();

  const { error } = await service.from("sms_cost_events").upsert(
    {
      organization_id: input.organizationId,
      provider: "twilio",
      service: "sms",
      source_message_id: input.sourceMessageId,
      provider_message_id: input.providerMessageId,
      direction: input.direction,
      provider_status: fetched.message.status,
      price: priceOutcome.cost,
      currency,
      num_segments: parseNonNegativeIntOrNull(fetched.message.numSegments),
      num_media: parseNonNegativeIntOrNull(fetched.message.numMedia),
      occurred_at: occurredAt,
      metadata: fetched.message.direction ? { twilio_direction: fetched.message.direction } : null,
    },
    { onConflict: "source_message_id", ignoreDuplicates: true },
  );

  if (error) return { outcome: "error", error: error.message };

  return { outcome: "known", cost: priceOutcome.cost, currency };
}
