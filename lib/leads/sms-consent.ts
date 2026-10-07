import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Final Batch 2: SMS consent captured by a web form posting to the public
 * lead-intake endpoint. Nothing here is a legal opinion.
 *
 * State model - leads.sms_consent (supabase/pending/lead_sms_consent.sql),
 * written in the same insert that creates the lead:
 *   null           - the lead did not come through the public form (manual,
 *                    inbound SMS, missed call, referral, every existing row).
 *                    Behavior unchanged.
 *   'granted'      - the form sent affirmative consent (sms_consent true/"yes"/...).
 *   'declined'     - the form sent an explicit "no".
 *   'not_provided' - the form sent no consent field, or an unrecognized value.
 * The outbound gate allows automated SMS about a lead only when its state is
 * null or 'granted' (reason lead_sms_consent_missing otherwise). The lead is
 * always created; staff handle it as usual.
 *
 * "No consent" is deliberately NOT "opted out": contacts.sms_opt_out stays
 * the one STOP/START flag and is never written from the form - a missing or
 * declined consent never manufactures a STOP, and START/STOP keep their
 * exact semantics. An affirmative consent never clears a STOP either.
 *
 * Evidence: an affirmative or explicit answer is also recorded in audit_log
 * (sms_consent_recorded) with the disclosure wording the form showed, if sent.
 * The audit row is evidence only - the gate never reads it.
 */

export type SmsConsentChoice = "granted" | "declined" | "unknown";
export type LeadSmsConsent = "granted" | "declined" | "not_provided";

export const SMS_CONSENT_AUDIT_ACTION = "sms_consent_recorded";
export const MAX_CONSENT_TEXT_LENGTH = 1000;

/** Lead consent states under which no automated SMS may be sent about the lead. */
export const LEAD_SMS_CONSENT_BLOCKING: ReadonlySet<string> = new Set<LeadSmsConsent>(["declined", "not_provided"]);

/**
 * Example wording a contractor can place next to an SMS checkbox on their own
 * form and adapt (the business name, the purpose). Displayed in Settings; the
 * form should send the exact text it showed as `sms_consent_text`. Not legal
 * advice - each business is responsible for its own disclosure.
 */
export const DEFAULT_SMS_CONSENT_DISCLOSURE =
  "I agree to receive text messages from this business about my request. Message frequency varies. Message and data rates may apply. Reply STOP to opt out.";

const GRANTED = new Set(["true", "yes", "y", "1", "on", "granted", "accepted"]);
const DECLINED = new Set(["false", "no", "n", "0", "off", "declined", "denied"]);

/** Only an explicit true/false-like value counts; anything else (absent, empty, unrecognized) is "unknown". */
export function parseSmsConsent(value: unknown): SmsConsentChoice {
  if (value === true) return "granted";
  if (value === false) return "declined";
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (GRANTED.has(normalized)) return "granted";
  if (DECLINED.has(normalized)) return "declined";
  return "unknown";
}

/** The state a lead CREATED by this submission carries: anything but an affirmative consent blocks automated SMS. */
export function leadSmsConsentFor(choice: SmsConsentChoice): LeadSmsConsent {
  return choice === "granted" ? "granted" : choice === "declined" ? "declined" : "not_provided";
}

/**
 * A submission attached to a lead that already exists (a returning contact's
 * open lead, or a duplicate resubmission): an explicit answer replaces the
 * lead's state; no answer leaves it exactly as it was (never downgrades an
 * existing lead). A decline that cannot be persisted returns ok:false - the
 * caller must not report success for a person who said no.
 */
export async function applySmsConsentToExistingLead(
  service: SupabaseClient,
  input: { organizationId: string; leadId: string; choice: SmsConsentChoice },
): Promise<{ ok: boolean }> {
  if (input.choice === "unknown") return { ok: true };
  const { data, error } = await service
    .from("leads")
    .update({ sms_consent: leadSmsConsentFor(input.choice) })
    .eq("id", input.leadId)
    .eq("organization_id", input.organizationId)
    .select("id");
  if (error || !data || data.length === 0) {
    console.error("[lead-capture] failed to record SMS consent on the lead", { organizationId: input.organizationId, leadId: input.leadId, choice: input.choice, code: error?.code ?? null });
    return { ok: input.choice !== "declined" };
  }
  return { ok: true };
}

/** Evidence row for an explicit answer. Never fails the intake (the lead's own state is what the gate reads). */
export async function recordSmsConsentEvidence(
  service: SupabaseClient,
  input: { organizationId: string; leadId: string; contactId: string; choice: SmsConsentChoice; disclosureText: string | null; source: string },
): Promise<void> {
  if (input.choice === "unknown") return;
  const { error } = await service.from("audit_log").insert({
    organization_id: input.organizationId,
    user_id: null,
    action: SMS_CONSENT_AUDIT_ACTION,
    entity_type: "lead",
    entity_id: input.leadId,
    metadata: {
      consent: input.choice,
      channel: "sms",
      capture_method: "web_form",
      contact_id: input.contactId,
      source: input.source,
      disclosure_text: input.disclosureText,
    },
  });
  if (error) console.error("[lead-capture] failed to record SMS consent evidence", { organizationId: input.organizationId, leadId: input.leadId, error: error.message });
}
