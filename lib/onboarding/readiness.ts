import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getBusinessProfile,
  getBusinessHours,
  getLeadIntakeToken,
  getAutomationMode,
  hasAiSettingsConfigured,
  hasBookingSettingsConfigured,
  getBookingSettings,
  type AutomationMode,
} from "@/lib/settings/queries";
import { getOrganizationSmsNumber } from "@/lib/settings/sms-routing";
import { getCalendarConnection } from "@/lib/calendar/connection";

/**
 * First Client Onboarding V1: a single, factual readiness computation
 * shared by the client-facing onboarding page (app/onboarding) and the
 * agency's read-only organization detail page (app/agency/organizations/[id]) -
 * one source of truth, so the two surfaces can never disagree about whether
 * an organization is actually ready. Every check reads real, already-existing
 * settings data (lib/settings/queries.ts, lib/settings/sms-routing.ts) -
 * nothing here is a new metric or a fabricated health signal.
 *
 * Status rules (factual, not invented):
 * - "live": automation_mode is already 'live'.
 * - "setup": the business profile itself is incomplete (no name/phone) -
 *   nothing else can be meaningfully configured yet.
 * - "blocked": business profile is complete, but the SMS number is missing -
 *   this is the exact same requirement app/(app)/settings/actions.ts's
 *   updateAutomationMode() already enforces server-side before allowing Go
 *   Live, so "blocked" here always matches what Go Live would actually reject.
 * - "testing": business + SMS are both present, but business hours haven't
 *   been configured yet (recommended, not enforced by the Go Live gate).
 * - "ready": every check passes; Go Live is available.
 */
export type OnboardingStatus = "setup" | "blocked" | "testing" | "ready" | "live";

/**
 * Growth System Completion Pass 1: a three-way distinction, not just
 * complete/incomplete - a Growth System capability (AI booking, Google
 * Calendar sync) that a contractor has never configured is genuinely
 * "not_ready" (a real gap the founder should see), but one they explicitly
 * configured OFF/disconnected is "disabled_by_intent" (a valid choice, never
 * displayed or treated as a problem). `complete` stays true for both "ready"
 * and "disabled_by_intent" (neither blocks anything downstream, including
 * canGoLive below) - only "not_ready" is ever actually incomplete. Pre-
 * existing items (business/hours/leadCapture/sms/ai) only ever resolve to
 * "ready"/"not_ready" - the "disabled_by_intent" state has no meaning for
 * them and is never produced.
 */
export type ReadinessState = "ready" | "not_ready" | "disabled_by_intent";

export type ReadinessItem = {
  key: "business" | "hours" | "leadCapture" | "sms" | "ai" | "booking" | "calendar";
  label: string;
  complete: boolean;
  state: ReadinessState;
  detail: string;
};

export type OnboardingReadiness = {
  status: OnboardingStatus;
  automationMode: AutomationMode;
  items: ReadinessItem[];
  /** The subset of incomplete items that actually block Go Live server-side (business, sms) - distinct from merely-recommended items (hours, ai). */
  blockingKeys: ReadinessItem["key"][];
};

export async function computeOnboardingReadiness(supabase: SupabaseClient, organizationId: string): Promise<OnboardingReadiness> {
  const [profile, hours, smsNumber, aiConfigured, intakeToken, automationMode, bookingConfigured, bookingSettings, calendarConnection] = await Promise.all([
    getBusinessProfile(supabase, organizationId),
    getBusinessHours(supabase, organizationId),
    getOrganizationSmsNumber(supabase, organizationId),
    hasAiSettingsConfigured(supabase, organizationId),
    getLeadIntakeToken(supabase, organizationId),
    getAutomationMode(supabase, organizationId),
    hasBookingSettingsConfigured(supabase, organizationId),
    getBookingSettings(supabase, organizationId),
    getCalendarConnection(supabase, organizationId),
  ]);

  const businessComplete = Boolean(profile?.name) && Boolean(profile?.phone);
  const hoursComplete = hours.length > 0;
  const smsComplete = Boolean(smsNumber);
  const leadCaptureComplete = Boolean(intakeToken);

  // Growth System Completion Pass 1: AI booking is "ready" once a
  // booking_settings row exists AND the contractor left it enabled;
  // "disabled_by_intent" once configured and explicitly turned off (a valid
  // choice); "not_ready" only when never configured at all - the state
  // hasBookingSettingsConfigured (row existence) exists specifically to
  // distinguish from getBookingSettings' safe false-default.
  const bookingState: ReadinessState = !bookingConfigured ? "not_ready" : bookingSettings.booking_enabled ? "ready" : "disabled_by_intent";

  // Calendar: no connection at all is a valid choice (not every contractor
  // uses Google Calendar) - "disabled_by_intent", never "not_ready". A
  // connection that exists but is currently unhealthy (status: "error") IS a
  // real, "not_ready" problem - something is broken and needs the
  // contractor's attention, distinct from having never opted in.
  const calendarState: ReadinessState = !calendarConnection ? "disabled_by_intent" : calendarConnection.status === "error" ? "not_ready" : "ready";

  const items: ReadinessItem[] = [
    {
      key: "business",
      label: "Business information",
      complete: businessComplete,
      state: businessComplete ? "ready" : "not_ready",
      detail: businessComplete ? "Business name and phone on file." : "Add your business name and phone number.",
    },
    {
      key: "hours",
      label: "Business hours",
      complete: hoursComplete,
      state: hoursComplete ? "ready" : "not_ready",
      detail: hoursComplete ? "Business hours configured." : "Configure your business hours.",
    },
    {
      key: "leadCapture",
      label: "Lead capture",
      complete: leadCaptureComplete,
      state: leadCaptureComplete ? "ready" : "not_ready",
      detail: leadCaptureComplete ? "Your lead intake URL is ready to use." : "Lead intake is not yet available for this organization.",
    },
    {
      key: "sms",
      label: "Business phone number",
      complete: smsComplete,
      state: smsComplete ? "ready" : "not_ready",
      detail: smsComplete ? "Connected — customer replies can reach Trackpr." : "Connect your business number so customer replies can reach Trackpr.",
    },
    {
      key: "ai",
      label: "AI response settings",
      complete: aiConfigured,
      state: aiConfigured ? "ready" : "not_ready",
      detail: aiConfigured ? "Reviewed." : "Review how Trackpr should respond to new leads (AI can stay off).",
    },
    {
      key: "booking",
      label: "AI appointment booking",
      complete: bookingState !== "not_ready",
      state: bookingState,
      detail:
        bookingState === "ready"
          ? "Booking is configured and enabled."
          : bookingState === "disabled_by_intent"
            ? "Online booking is turned off — a valid choice, not a problem."
            : "Review booking settings, or turn booking off if you don't want AI scheduling.",
    },
    {
      key: "calendar",
      label: "Google Calendar sync",
      complete: calendarState !== "not_ready",
      state: calendarState,
      detail:
        calendarState === "ready"
          ? "Connected and healthy."
          : calendarState === "disabled_by_intent"
            ? "No calendar connected — a valid choice, not a problem."
            : "Your Google Calendar connection needs attention — reconnect it in Settings.",
    },
  ];

  let status: OnboardingStatus;
  if (automationMode === "live") {
    status = "live";
  } else if (!businessComplete) {
    status = "setup";
  } else if (!smsComplete) {
    status = "blocked";
  } else if (!hoursComplete) {
    status = "testing";
  } else {
    status = "ready";
  }

  return {
    status,
    automationMode,
    items,
    blockingKeys: ["business", "sms"],
  };
}

export const ONBOARDING_STATUS_LABEL: Record<OnboardingStatus, string> = {
  setup: "Setup",
  blocked: "Blocked",
  testing: "Testing",
  ready: "Ready",
  live: "Live",
};

/**
 * First Client Onboarding V1, Step 6 (Test Mode): the real, current outcome
 * of the most recent onboarding test lead, read from the exact same
 * automation_events/workflow_executions tables every other part of this
 * codebase already uses - never a second, invented status. Because n8n
 * dispatch is asynchronous (see lib/automation/lead-followup.ts's use of
 * next/server's after()), this can legitimately return status "running" for
 * a few seconds after the test is sent - the caller is expected to re-fetch
 * (e.g. on page reload) rather than treat "running" as a final answer.
 */
export type TestLeadOutcome = {
  leadId: string;
  createdAt: string;
  executionStatus: "running" | "completed" | "failed" | "cancelled" | null;
  blockedReason: string | null;
  errorMessage: string | null;
};

export const ONBOARDING_TEST_LEAD_SOURCE = "onboarding_test";

export async function getLatestTestLeadOutcome(supabase: SupabaseClient, organizationId: string): Promise<TestLeadOutcome | null> {
  const { data: lead } = await supabase
    .from("leads")
    .select("id, created_at")
    .eq("organization_id", organizationId)
    .eq("source", ONBOARDING_TEST_LEAD_SOURCE)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lead) return null;

  const { data: event } = await supabase
    .from("automation_events")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("entity_type", "lead")
    .eq("entity_id", lead.id)
    .eq("event_type", "lead.created")
    .maybeSingle();

  if (!event) {
    return { leadId: lead.id, createdAt: lead.created_at, executionStatus: null, blockedReason: null, errorMessage: null };
  }

  const { data: execution } = await supabase
    .from("workflow_executions")
    .select("status, error_message, metadata")
    .eq("automation_event_id", event.id)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!execution) {
    return { leadId: lead.id, createdAt: lead.created_at, executionStatus: null, blockedReason: null, errorMessage: null };
  }

  const metadata = (execution.metadata ?? {}) as Record<string, unknown>;
  return {
    leadId: lead.id,
    createdAt: lead.created_at,
    executionStatus: execution.status as TestLeadOutcome["executionStatus"],
    blockedReason: typeof metadata.blocked_reason === "string" ? metadata.blocked_reason : null,
    errorMessage: execution.error_message ?? null,
  };
}
