import type { SupabaseClient } from "@supabase/supabase-js";
import { E164_PATTERN } from "@/lib/automation/sms";

export type SmsPhoneValidationResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Server-side validation for the SMS routing number, independent of
 * whatever the browser already checked. Reuses lib/automation/sms.ts's own
 * E164_PATTERN rather than a second, competing format check - this is the
 * exact pattern sendSms() and evaluateOutboundGate() already gate on, so a
 * number that passes here is guaranteed to also pass at the provider
 * boundary. Never rewrites/normalizes the input beyond trimming surrounding
 * whitespace - a user's number is either already correct or rejected, never
 * silently altered into a different number.
 */
export function validateSmsPhoneNumber(raw: string): SmsPhoneValidationResult {
  const value = raw.trim();

  if (!value) {
    return { ok: false, error: "Enter a phone number." };
  }

  if (!E164_PATTERN.test(value)) {
    return { ok: false, error: "Enter a valid phone number in E.164 format, e.g. +15551234567." };
  }

  return { ok: true, value };
}

/**
 * The single source of truth for "which organization does this inbound SMS
 * number belong to" - used by both the inbound webhook (routing an actual
 * message) and, indirectly, by the settings page (checking whether the
 * number the user is about to set is already visibly theirs). Scoped to
 * exactly the column app/api/webhooks/sms/inbound/route.ts already reads;
 * this function does not duplicate that route's routing decision, it *is*
 * that routing decision, called from one place.
 */
export async function findOrganizationBySmsPhoneNumber(
  supabase: SupabaseClient,
  smsPhoneNumber: string,
): Promise<{ id: string } | null> {
  const { data } = await supabase.from("organizations").select("id").eq("sms_phone_number", smsPhoneNumber).maybeSingle();

  return data ?? null;
}

/**
 * Read helper for the settings page - mirrors lib/settings/queries.ts's
 * getBusinessProfile() shape exactly (a single-row select scoped to the
 * caller's own organization id, relying on organizations_select's existing
 * is_org_member() RLS policy for isolation, not a fresh authorization check
 * of its own).
 */
export async function getOrganizationSmsNumber(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  const { data } = await supabase.from("organizations").select("sms_phone_number").eq("id", organizationId).maybeSingle();

  return (data?.sms_phone_number as string | null | undefined) ?? null;
}
