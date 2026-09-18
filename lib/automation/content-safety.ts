/**
 * Heuristic, keyword/pattern-based backstop against the specific unsupported
 * claims Phase 4.3 forbids an AI-drafted outbound message from making
 * (pricing, guaranteed availability/scheduling, payment claims, discounts).
 * This is deliberately not a language model and will have false
 * positives/negatives - it exists because the AI's own instructions are not
 * a security boundary ("do not trust values coming from n8n merely because
 * they are syntactically valid"). It is the last line of defense before a
 * message can leave the safe outbound gate, not the only one - the n8n
 * prompt already instructs the model not to make these claims in the first
 * place.
 */

export type ContentSafetyResult = { safe: true } | { safe: false; reason: string };

const PRICE_PATTERN = /\$\s?\d|(?:\bUSD\b)|\b\d+(?:\.\d{2})?\s*(?:dollars|bucks)\b/i;
const DISCOUNT_PATTERN = /\b\d{1,3}\s*%\s*off\b|\bdiscount\b|\bcoupon\b|\bpromo\s*code\b/i;
const GUARANTEE_PATTERN = /\bguarantee(d)?\b|\b100%\s*(guaranteed|satisfaction)\b|\bpromise(d)?\b/i;
// Deliberately does NOT match a plain "scheduled for/at/on <time>" phrase -
// stating an appointment's ACTUAL, already-stored time that way is exactly
// what Phase 4.4's confirmation/reminder messages need to say legitimately.
// What this still catches is the AI inventing a NEW commitment: a specific
// arrival promise, "on our way", an ETA, or claiming something was booked/
// assigned that Trackpr doesn't actually show.
const SCHEDULING_CLAIM_PATTERN =
  /\b(?:will|can|will be)\s+(?:arrive|be there|be over|get there|show up)\b|\bon (?:our|my) way\b|\beta\b|\bbooked\s+(?:you|for|an? (?:appointment|technician))\b|\btechnician\s+is\s+(?:on|booked|assigned|en route)\b/i;
const PAYMENT_CLAIM_PATTERN = /\bpayment\s+(?:received|processed|confirmed)\b|\bpaid\s+in\s+full\b|\binvoice\s+(?:paid|settled)\b/i;
const ESTIMATE_CLAIM_PATTERN = /\byour\s+estimate\s+(?:is|of)\b|\bestimate\s+is\s+ready\b|\bestimate\s+has\s+been\s+(?:created|generated|sent)\b/i;

const CHECKS: { pattern: RegExp; reason: string }[] = [
  { pattern: PRICE_PATTERN, reason: "message appears to state a specific price" },
  { pattern: DISCOUNT_PATTERN, reason: "message appears to offer a discount/promo" },
  { pattern: GUARANTEE_PATTERN, reason: "message appears to make a guarantee/promise" },
  { pattern: SCHEDULING_CLAIM_PATTERN, reason: "message appears to claim a specific arrival time or booked appointment" },
  { pattern: PAYMENT_CLAIM_PATTERN, reason: "message appears to claim a payment was received" },
  { pattern: ESTIMATE_CLAIM_PATTERN, reason: "message appears to claim an estimate exists" },
];

export function evaluateContentSafety(body: string): ContentSafetyResult {
  for (const { pattern, reason } of CHECKS) {
    if (pattern.test(body)) {
      return { safe: false, reason };
    }
  }
  return { safe: true };
}
