import type { SupabaseClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { getNotificationSettings, type NotificationSettings } from "@/lib/settings/queries";
import { sendSms, resolveAppBaseUrl, type SendSmsResult } from "@/lib/automation/sms";

/**
 * Founder-facing notification dispatch - the missing consumer for the
 * notify_on_hot_lead / notify_on_ai_escalation / notify_on_missed_call /
 * notify_on_appointment_booked settings (lib/settings/queries.ts). Those
 * settings and their Settings UI already existed; nothing anywhere ever read
 * them to actually send anything (the audit's own P0 finding). This module
 * is the single place that changes.
 *
 * Every caller must already be calling from a point in its own flow that is
 * naturally idempotent per real-world business event (an automation event's
 * own duplicate check, an execution's own running-status guard, a
 * conditional UPDATE that only affects a row the first time) - this module
 * deliberately adds no second, competing dedup mechanism of its own. See
 * each call site's own comment for exactly which existing guarantee it
 * relies on.
 *
 * Never throws, and never awaited for its result by anything that could let
 * a notification failure affect core business state - every failure (missing
 * config, a provider error, a thrown exception) is caught and logged here,
 * the same fire-and-log contract lib/email/send-signup-notification.ts
 * already established for founder-facing email.
 */

export type FounderNotificationKind = "hot_lead" | "ai_escalation" | "missed_call" | "appointment_booked" | "automation_degraded" | "owner_digest";

export type FounderNotificationInput = {
  organizationId: string;
  kind: FounderNotificationKind;
  /** One short, human-readable line describing what happened - e.g. "Jane Doe replied with urgency: emergency about a burst pipe." Never includes Google credentials, internal ids, or anything not meant for the founder's own phone/email. */
  summary: string;
  /** App-relative path the founder can open for detail, e.g. "/leads/<id>". Optional - omitted when there's nothing more specific to link to. */
  detailPath?: string | null;
  /** Phase 3G-1: restricts delivery to SMS (the weekly owner digest is SMS-only). Omitted, both configured channels are attempted, as before. */
  smsOnly?: boolean;
};

/**
 * Phase 3G-1: what notifyFounder actually did, for callers that must record
 * a real delivery outcome (the weekly owner digest). Existing callers ignore
 * it, exactly as they ignored the old void result.
 */
export type FounderNotificationResult =
  | { outcome: "disabled" }
  | { outcome: "no_recipient" }
  | { outcome: "delivered"; sms: boolean; email: boolean }
  | { outcome: "failed" };

const SETTING_KEY: Record<FounderNotificationKind, keyof NotificationSettings> = {
  hot_lead: "notify_on_hot_lead",
  ai_escalation: "notify_on_ai_escalation",
  missed_call: "notify_on_missed_call",
  appointment_booked: "notify_on_appointment_booked",
  automation_degraded: "notify_on_automation_degraded",
  owner_digest: "notify_on_owner_digest",
};

const KIND_LABEL: Record<FounderNotificationKind, string> = {
  hot_lead: "Hot lead",
  ai_escalation: "AI escalation",
  missed_call: "Missed call",
  appointment_booked: "Appointment booked",
  automation_degraded: "Automation needs attention",
  owner_digest: "Weekly summary",
};

function buildDetailUrl(detailPath?: string | null): string | null {
  if (!detailPath) return null;
  const base = resolveAppBaseUrl();
  if (!base) return null;
  return `${base}${detailPath.startsWith("/") ? detailPath : `/${detailPath}`}`;
}

function buildSubject(kind: FounderNotificationKind, organizationName: string): string {
  return `${KIND_LABEL[kind]} - ${organizationName}`;
}

function buildEmailBody(input: FounderNotificationInput, organizationName: string): string {
  const lines = [`${KIND_LABEL[input.kind]} for ${organizationName}.`, "", input.summary];
  const url = buildDetailUrl(input.detailPath);
  if (url) {
    lines.push("", url);
  }
  return lines.join("\n");
}

function buildSmsBody(input: FounderNotificationInput, organizationName: string): string {
  // SMS stays short - one line plus, when resolvable, a direct link. Never
  // includes an opt-out line: this is an operational alert to the
  // organization's own owner/staff, not a customer-facing marketing/AI
  // message, so it is never subject to contacts.sms_opt_out or the outbound
  // gate - see sendSms() below, the raw provider boundary, not
  // sendOutboundMessage().
  const url = buildDetailUrl(input.detailPath);
  const base = `${KIND_LABEL[input.kind]} (${organizationName}): ${input.summary}`;
  return url ? `${base} ${url}` : base;
}

type SendEmailFn = (input: { to: string; from: string; subject: string; text: string }) => Promise<{ error?: unknown }>;

async function sendViaResend(email: { to: string; from: string; subject: string; text: string }): Promise<{ error?: unknown }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { error: new Error("RESEND_API_KEY is not configured") };
  }
  const resend = new Resend(apiKey);
  const result = await resend.emails.send(email);
  return { error: result.error ?? undefined };
}

/** Resolves true only when the email was actually handed to the provider. */
async function notifyByEmail(to: string, input: FounderNotificationInput, organizationName: string, sendEmail: SendEmailFn): Promise<boolean> {
  const from = process.env.EMAIL_FROM;
  if (!process.env.RESEND_API_KEY || !from) {
    console.error("[notifications] Skipped founder email: RESEND_API_KEY and/or EMAIL_FROM is not configured.");
    return false;
  }

  try {
    const { error } = await sendEmail({ to, from, subject: buildSubject(input.kind, organizationName), text: buildEmailBody(input, organizationName) });
    if (error) {
      console.error("[notifications] Resend returned an error while sending a founder notification", { organizationId: input.organizationId, kind: input.kind, error });
      return false;
    }
    return true;
  } catch (error) {
    console.error("[notifications] Failed to send founder notification email", { organizationId: input.organizationId, kind: input.kind, error });
    return false;
  }
}

/**
 * Resolves true only when the provider accepted the SMS. Phase 3G-1: failures
 * log only the provider's error code (or the thrown error's name) - never the
 * provider's message, which can echo the destination phone number.
 */
async function notifyBySms(to: string, input: FounderNotificationInput, organizationName: string, sendSmsFn: (input: { organizationId: string; to: string; body: string }) => Promise<SendSmsResult>): Promise<boolean> {
  try {
    const result = await sendSmsFn({ organizationId: input.organizationId, to, body: buildSmsBody(input, organizationName) });
    if (!result.ok) {
      console.error("[notifications] Failed to send founder notification SMS", { organizationId: input.organizationId, kind: input.kind, providerErrorCode: result.providerErrorCode ?? null, unconfigured: result.unconfigured ?? false });
      return false;
    }
    return true;
  } catch (error) {
    console.error("[notifications] Failed to send founder notification SMS", { organizationId: input.organizationId, kind: input.kind, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

/**
 * Sends a founder-facing notification for one of the four settings-gated
 * trigger points, honoring every rule the task requires:
 * - setting OFF (the org's own notify_on_* column) -> absolutely nothing is
 *   sent, not even a log-only attempt.
 * - setting ON but neither notification_email nor notification_phone is
 *   configured -> also nothing is sent (there is nowhere to send it) - this
 *   is the "neither" case, handled by both per-channel branches below
 *   simply not running, not by a special case.
 * - both configured -> both channels are attempted independently; a failure
 *   on one never blocks or is masked by the other (Promise.all over two
 *   independent, individually-caught tasks).
 * - organization isolation: every value used (settings, organization name)
 *   is read fresh, scoped to organizationId, from the database - nothing is
 *   ever trusted from a caller-supplied object beyond the id itself.
 * - no secrets/provider internals: the message is built entirely from
 *   `summary` (caller-composed, plain text) and the organization's own
 *   name/detail link - never a Google token, an internal database id beyond
 *   what's already embedded in detailPath, or a raw provider error.
 */
export async function notifyFounder(
  supabase: SupabaseClient,
  input: FounderNotificationInput,
  deps: { sendEmail?: SendEmailFn; sendSmsFn?: (input: { organizationId: string; to: string; body: string }) => Promise<SendSmsResult> } = {},
): Promise<FounderNotificationResult> {
  try {
    const [settings, organization] = await Promise.all([
      getNotificationSettings(supabase, input.organizationId),
      supabase.from("organizations").select("name").eq("id", input.organizationId).maybeSingle(),
    ]);

    if (!settings[SETTING_KEY[input.kind]]) return { outcome: "disabled" };

    const organizationName = (organization.data?.name as string | undefined) ?? "Trackpr";
    const sendEmail = deps.sendEmail ?? sendViaResend;
    const sendSmsFn = deps.sendSmsFn ?? sendSms;

    const emailTo = input.smsOnly ? null : settings.notification_email;
    const smsTo = settings.notification_phone;
    if (!emailTo && !smsTo) return { outcome: "no_recipient" };

    const [email, sms] = await Promise.all([
      emailTo ? notifyByEmail(emailTo, input, organizationName, sendEmail) : Promise.resolve(false),
      smsTo ? notifyBySms(smsTo, input, organizationName, sendSmsFn) : Promise.resolve(false),
    ]);

    return email || sms ? { outcome: "delivered", sms, email } : { outcome: "failed" };
  } catch (error) {
    // Fire-and-log, never fire-and-throw - a broken or unconfigured
    // notification path must never roll back or fail the core business
    // event (a lead, an escalation, a call, a booking) that triggered it.
    console.error("[notifications] notifyFounder failed unexpectedly", { organizationId: input.organizationId, kind: input.kind, error: error instanceof Error ? error.name : "unknown" });
    return { outcome: "failed" };
  }
}
