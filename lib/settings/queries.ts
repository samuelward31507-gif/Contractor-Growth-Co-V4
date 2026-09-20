import type { SupabaseClient } from "@supabase/supabase-js";

export type BusinessProfile = {
  id: string;
  name: string;
  owner_name: string | null;
  trade: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  website: string | null;
  timezone: string;
  review_url: string | null;
  facebook_url: string | null;
  emergency_service: boolean;
  after_hours_handling: string | null;
  estimate_process: string | null;
  lead_sources: string[] | null;
};

const PROFILE_COLUMNS =
  "id, name, owner_name, trade, phone, email, address, city, state, zip, website, timezone, review_url, facebook_url, emergency_service, after_hours_handling, estimate_process, lead_sources";

/**
 * First Contractor Onboarding: the fixed, small set of channels the
 * onboarding/operations form lets a contractor describe as their current
 * lead sources - informational context for onboarding/agency setup, never
 * confused with leads.source (per-lead runtime attribution, a free-text
 * value set by the actual lead-capture/webhook paths). Validated server-side
 * against this exact list - never a free-text value.
 */
export const LEAD_SOURCE_OPTIONS = [
  { value: "website", label: "Website" },
  { value: "google", label: "Google" },
  { value: "facebook", label: "Facebook" },
  { value: "phone", label: "Phone" },
  { value: "referral", label: "Referral" },
  { value: "other", label: "Other" },
] as const;

export type LeadSourceValue = (typeof LEAD_SOURCE_OPTIONS)[number]["value"];

/**
 * First Client Onboarding V1: the same trade list the marketing site's Get
 * Started form already uses (app/(marketing)/get-started/get-started-form.tsx)
 * - kept as its own copy rather than a shared import, since the marketing
 * route group is frozen and this one lives in the authenticated app.
 */
export const TRADE_OPTIONS = ["HVAC", "Plumbing", "Electrical", "Roofing", "Remodeling", "Concrete", "Landscaping", "Painting", "Flooring", "Other"];

/**
 * The business profile lives directly on `organizations` (name is already
 * the canonical business name there - no duplicate field is introduced).
 * Scoped to the caller's own organization id, resolved server-side.
 */
export async function getBusinessProfile(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<BusinessProfile | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select(PROFILE_COLUMNS)
    .eq("id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return data as BusinessProfile;
}

/**
 * Small, focused read used by other modules (Appointments) that only need
 * the configured timezone for display - avoids pulling the whole profile
 * just to format a date.
 */
export async function getOrganizationTimezone(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string | undefined> {
  const { data } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", organizationId)
    .maybeSingle();

  return data?.timezone ?? undefined;
}

export type DayOfWeek =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export const DAYS_OF_WEEK: { value: DayOfWeek; label: string }[] = [
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
  { value: "sunday", label: "Sunday" },
];

export type BusinessHour = {
  day_of_week: DayOfWeek;
  is_open: boolean;
  open_time: string | null;
  close_time: string | null;
};

export async function getBusinessHours(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<BusinessHour[]> {
  const { data } = await supabase
    .from("business_hours")
    .select("day_of_week, is_open, open_time, close_time")
    .eq("organization_id", organizationId);

  return (data ?? []) as BusinessHour[];
}

/**
 * The table only has rows the org has actually saved - this fills in the
 * rest of the week with a sensible, clearly-a-default schedule (Mon-Fri
 * 9-5, weekends closed) purely for the editor's initial display. Nothing is
 * persisted until the contractor saves.
 */
export function withDefaultHours(existing: BusinessHour[]): Record<DayOfWeek, BusinessHour> {
  const byDay = new Map(existing.map((row) => [row.day_of_week, row]));
  const result = {} as Record<DayOfWeek, BusinessHour>;

  for (const { value } of DAYS_OF_WEEK) {
    const isWeekend = value === "saturday" || value === "sunday";
    result[value] = byDay.get(value) ?? {
      day_of_week: value,
      is_open: !isWeekend,
      open_time: isWeekend ? null : "09:00",
      close_time: isWeekend ? null : "17:00",
    };
  }

  return result;
}

export type Service = {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
};

export async function getServices(supabase: SupabaseClient, organizationId: string): Promise<Service[]> {
  const { data } = await supabase
    .from("services")
    .select("id, name, description, is_active, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  return (data ?? []) as Service[];
}

export type ServiceArea = {
  id: string;
  name: string;
};

export async function getServiceAreas(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ServiceArea[]> {
  const { data } = await supabase
    .from("service_areas")
    .select("id, name")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  return (data ?? []) as ServiceArea[];
}

export type AutomationMode = "test" | "live";

/**
 * Fast-Track Production Readiness, Pass 3: the organization-level go-live
 * gate consulted by lib/automation/outbound-gate.ts before any
 * customer-facing automated send. Defaults to 'test' via the column's own
 * DEFAULT - a missing row/value is impossible once the migration has run,
 * but this still fails to the safe value rather than trusting an
 * unexpected shape.
 */
export async function getAutomationMode(supabase: SupabaseClient, organizationId: string): Promise<AutomationMode> {
  const { data } = await supabase
    .from("organizations")
    .select("automation_mode")
    .eq("id", organizationId)
    .maybeSingle();

  return data?.automation_mode === "live" ? "live" : "test";
}

/**
 * First-Client Lead Capture V1: the per-organization secret that
 * app/api/leads/capture/[token]/route.ts looks up to resolve organization
 * scope for an inbound lead - never an organization id itself. Every
 * organization has one (see its migration's backfill), so this should
 * never actually return null in practice; the null case is handled anyway
 * rather than assumed away.
 */
export async function getLeadIntakeToken(supabase: SupabaseClient, organizationId: string): Promise<string | null> {
  const { data } = await supabase
    .from("organizations")
    .select("lead_intake_token")
    .eq("id", organizationId)
    .maybeSingle();

  return data?.lead_intake_token ?? null;
}

/**
 * First Client Onboarding V1: whether AI has actually been configured at
 * least once, as distinct from getAiSettings()'s safe defaults (which
 * return ai_enabled: false for an org that has never touched this page at
 * all). Onboarding readiness must never claim "AI configuration present"
 * for an org that simply hasn't looked at it yet - this checks real row
 * existence, not the presence of a default.
 */
export async function hasAiSettingsConfigured(supabase: SupabaseClient, organizationId: string): Promise<boolean> {
  const { data } = await supabase.from("ai_settings").select("organization_id").eq("organization_id", organizationId).maybeSingle();
  return Boolean(data);
}

export const AI_TONE_OPTIONS = ["Professional", "Friendly", "Casual", "Direct", "Empathetic"];

export type AiSettings = {
  ai_enabled: boolean;
  tone: string | null;
  business_introduction: string | null;
  general_instructions: string | null;
  emergency_instructions: string | null;
  escalation_instructions: string | null;
};

const DEFAULT_AI_SETTINGS: AiSettings = {
  ai_enabled: false,
  tone: null,
  business_introduction: null,
  general_instructions: null,
  emergency_instructions: null,
  escalation_instructions: null,
};

/**
 * `ai_settings` is a 1:1 config row that may not exist yet for this org -
 * that's expected, not an error. Callers always get a usable object with
 * safe defaults rather than having to check for null.
 */
export async function getAiSettings(supabase: SupabaseClient, organizationId: string): Promise<AiSettings> {
  const { data } = await supabase
    .from("ai_settings")
    .select(
      "ai_enabled, tone, business_introduction, general_instructions, emergency_instructions, escalation_instructions",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();

  return data ? (data as AiSettings) : DEFAULT_AI_SETTINGS;
}

export type BookingSettings = {
  booking_enabled: boolean;
  minimum_notice_minutes: number;
  default_duration_minutes: number;
  buffer_minutes: number;
};

const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  booking_enabled: false,
  minimum_notice_minutes: 60,
  default_duration_minutes: 60,
  buffer_minutes: 0,
};

export async function getBookingSettings(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<BookingSettings> {
  const { data } = await supabase
    .from("booking_settings")
    .select("booking_enabled, minimum_notice_minutes, default_duration_minutes, buffer_minutes")
    .eq("organization_id", organizationId)
    .maybeSingle();

  return data ? (data as BookingSettings) : DEFAULT_BOOKING_SETTINGS;
}

export type NotificationSettings = {
  notification_email: string | null;
  notification_phone: string | null;
  notify_on_hot_lead: boolean;
  notify_on_ai_escalation: boolean;
  notify_on_missed_call: boolean;
  notify_on_appointment_booked: boolean;
  escalation_contact_name: string | null;
};

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  notification_email: null,
  notification_phone: null,
  notify_on_hot_lead: true,
  notify_on_ai_escalation: true,
  notify_on_missed_call: true,
  notify_on_appointment_booked: true,
  escalation_contact_name: null,
};

export async function getNotificationSettings(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<NotificationSettings> {
  const { data } = await supabase
    .from("notification_settings")
    .select(
      "notification_email, notification_phone, notify_on_hot_lead, notify_on_ai_escalation, notify_on_missed_call, notify_on_appointment_booked, escalation_contact_name",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();

  return data ? (data as NotificationSettings) : DEFAULT_NOTIFICATION_SETTINGS;
}
