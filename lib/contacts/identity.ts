import { isValidEmail } from "@/lib/auth/validation";
import { E164_PATTERN } from "@/lib/automation/sms";

/**
 * Contact Deduplication V1 - the single, canonical identity-normalization
 * logic. Every production path that creates or updates a contact's phone/
 * email must compute phone_normalized/email_normalized through these exact
 * functions - never a second, hand-rolled normalization - so the database's
 * own unique indexes (organization_id, phone_normalized) and
 * (organization_id, email_normalized) actually mean what they claim to
 * mean. This file has no I/O and no organization awareness; it only turns
 * one raw string into one deterministic identity value or null.
 */

/**
 * Normalizes a phone number into E.164 where that can be done without
 * guessing. Strips common formatting characters (spaces, dashes, dots,
 * parens) first. Three cases:
 *
 *   1. Already starts with "+" - validated as-is against E164_PATTERN
 *      (the same pattern lib/automation/sms.ts's sendSms()/evaluateOutboundGate()
 *      already use), never altered further.
 *   2. Exactly 10 digits, no country code - assumed North American
 *      (+1<10 digits>) per explicit product decision (Trackpr is a US/
 *      Canada contractor CRM). This is the one deliberate default this
 *      function makes.
 *   3. Exactly 11 digits starting with "1" - treated as a NANP number with
 *      its country code already present, "+" prepended.
 *
 * Anything else (7-digit local numbers, numbers with an unrecognized
 * shape, garbage input) returns null rather than guessing - an ambiguous
 * phone number must never be treated as an exact identity match.
 */
export function normalizePhoneForIdentity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");

  let candidate: string;
  if (hasPlus) {
    candidate = `+${digits}`;
  } else if (digits.length === 10) {
    candidate = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    candidate = `+${digits}`;
  } else {
    return null;
  }

  return E164_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Normalizes an email into a canonical matching form: trimmed, lowercased.
 * Deliberately does NOT apply any provider-specific transformation (Gmail's
 * dot-insensitivity, plus-address stripping, etc.) - those are provider
 * behaviors, not universal email semantics, and applying them here would
 * make two genuinely different mailboxes match as "the same identity."
 * Invalid email shapes return null.
 */
export function normalizeEmailForIdentity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!isValidEmail(trimmed)) return null;
  return trimmed.toLowerCase();
}
