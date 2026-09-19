import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The sole read path for automation_settings.enabled. No row for a given
 * (organization_id, automation_id) means enabled - this table only ever
 * records an explicit override (Phase A/C design decision: no migration
 * backfill), so an organization that has never touched its automation
 * settings behaves exactly as it always has, with zero behavior change.
 * Explicitly scoped by organization_id on every call (never relies on RLS
 * alone to prevent cross-org reads), so this is safe to call with either a
 * session-scoped client (RLS additionally enforces is_org_member as
 * defense in depth) or a service-role client (webhook/cron callers, where
 * RLS does not apply at all).
 */
export async function getAutomationEnabled(
  supabase: SupabaseClient,
  organizationId: string,
  automationId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("automation_settings")
    .select("enabled")
    .eq("organization_id", organizationId)
    .eq("automation_id", automationId)
    .maybeSingle();

  return (data?.enabled as boolean | undefined) ?? true;
}

/**
 * Phase G: batch variant of getAutomationEnabled for rendering an entire
 * automation list/detail page - one query for every automation_settings
 * row this organization has ever touched, instead of one query per catalog
 * automation. Missing from the returned map still means enabled (same
 * default as getAutomationEnabled) - callers should read it as
 * `map.get(id) ?? true`, never assume a present-but-false entry is the only
 * way to be disabled.
 */
export async function getAutomationEnabledMap(supabase: SupabaseClient, organizationId: string): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();

  const { data } = await supabase
    .from("automation_settings")
    .select("automation_id, enabled")
    .eq("organization_id", organizationId);

  for (const row of (data ?? []) as { automation_id: string; enabled: boolean }[]) {
    map.set(row.automation_id, row.enabled);
  }

  return map;
}

export type EnableToggleAudit = {
  action: "automation_enabled" | "automation_disabled";
  metadata: { previous_enabled: boolean; new_enabled: boolean };
};

/**
 * Phase H: the pure decision behind setAutomationEnabled's audit call,
 * extracted so it can be unit tested directly (app/(app)/automations/
 * actions.ts is a "use server" file - every export must be an async
 * function, so a plain synchronous helper has to live here instead).
 * Returns null for a no-op toggle (e.g. clicking "enable" on an automation
 * that's already enabled) - no automation_enabled/automation_disabled row
 * should ever be written for a state that didn't actually change.
 */
export function shouldAuditEnableToggle(previousEnabled: boolean, newEnabled: boolean): EnableToggleAudit | null {
  if (previousEnabled === newEnabled) return null;
  return {
    action: newEnabled ? "automation_enabled" : "automation_disabled",
    metadata: { previous_enabled: previousEnabled, new_enabled: newEnabled },
  };
}

// ============================================================================
// Automation Configuration V1
//
// automation_settings.config is a jsonb column - arbitrary in the schema,
// but every consumer below treats it as strictly typed and bounded. Two
// distinct access modes exist deliberately:
//
// - read*Config(raw): the LENIENT path, used at candidate-evaluation time.
//   A missing row, missing key, wrong type, out-of-range value, or stray
//   extra field all silently fall back to the exact hardcoded default the
//   automation used before configuration existed - this function must
//   never throw and must never let malformed stored data break a
//   scheduled/manual run.
// - validate*Config(input): the STRICT path, used only when an admin
//   submits a new value to save. Invalid input is rejected with a specific
//   error, never silently coerced to a default - a mistake must never be
//   silently saved as something else.
//
// Both share the same bounds constants, so "safe to read" and "safe to
// write" can never drift apart.
// ============================================================================

export type ConfigValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

// ---- appointment-reminders: reminder_lead_time_hours ----

export type AppointmentReminderConfig = { reminder_lead_time_hours: number };

export const APPOINTMENT_REMINDER_CONFIG_DEFAULTS: AppointmentReminderConfig = { reminder_lead_time_hours: 24 };

/**
 * Conservative, documented bounds - not derived from any hard technical
 * constraint. Minimum of 1 hour rules out zero/negative values, which would
 * mean "remind at or after the appointment already started" (an invalid,
 * effectively-immediate reminder). Maximum of 168 hours (7 days) keeps the
 * eligibility window a sane, human-reviewable size; a value near the
 * maximum, combined with a low-frequency cron, could plausibly delay a
 * reminder by close to one cron cycle - documented here as an operational
 * consideration, not enforced as a hard rule, since coupling validation
 * bounds to the cron schedule would be a strange, brittle dependency.
 */
export const REMINDER_LEAD_TIME_MIN_HOURS = 1;
export const REMINDER_LEAD_TIME_MAX_HOURS = 168;

/** Lenient read path - see the module comment above. Never throws. */
export function readAppointmentReminderConfig(raw: unknown): AppointmentReminderConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...APPOINTMENT_REMINDER_CONFIG_DEFAULTS };
  }
  const value = (raw as Record<string, unknown>).reminder_lead_time_hours;
  if (isFiniteInteger(value) && value >= REMINDER_LEAD_TIME_MIN_HOURS && value <= REMINDER_LEAD_TIME_MAX_HOURS) {
    return { reminder_lead_time_hours: value };
  }
  return { ...APPOINTMENT_REMINDER_CONFIG_DEFAULTS };
}

const APPOINTMENT_REMINDER_CONFIG_KEYS = new Set(["reminder_lead_time_hours"]);

/** Strict validation path for an admin-submitted write - see the module comment above. Rejects, never coerces. */
export function validateAppointmentReminderConfig(input: unknown): ConfigValidationResult<AppointmentReminderConfig> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid configuration." };
  }
  const extraKeys = Object.keys(input as Record<string, unknown>).filter((key) => !APPOINTMENT_REMINDER_CONFIG_KEYS.has(key));
  if (extraKeys.length > 0) {
    return { ok: false, error: `Unknown configuration field(s): ${extraKeys.join(", ")}.` };
  }
  const value = (input as Record<string, unknown>).reminder_lead_time_hours;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: "Reminder lead time must be a number." };
  }
  if (!Number.isInteger(value)) {
    return { ok: false, error: "Reminder lead time must be a whole number of hours." };
  }
  if (value < REMINDER_LEAD_TIME_MIN_HOURS || value > REMINDER_LEAD_TIME_MAX_HOURS) {
    return { ok: false, error: `Reminder lead time must be between ${REMINDER_LEAD_TIME_MIN_HOURS} and ${REMINDER_LEAD_TIME_MAX_HOURS} hours.` };
  }
  return { ok: true, value: { reminder_lead_time_hours: value } };
}

// ---- estimate-followup: followup_1_hours / followup_2_hours ----

export type EstimateFollowupConfig = { followup_1_hours: number; followup_2_hours: number };

export const ESTIMATE_FOLLOWUP_CONFIG_DEFAULTS: EstimateFollowupConfig = { followup_1_hours: 24, followup_2_hours: 72 };

/** Same "conservative, documented, not technically derived" rationale as the reminder bounds above. 30 days is a generous but bounded ceiling for a follow-up cadence. */
export const FOLLOWUP_HOURS_MIN = 1;
export const FOLLOWUP_HOURS_MAX = 720;

/** Lenient read path - see the module comment above. Never throws. Also silently falls back to defaults if followup_2 <= followup_1 (touch 2 must fire strictly after touch 1, or touch 1 would never be reachable - see processOneEstimate's occurrence logic). */
export function readEstimateFollowupConfig(raw: unknown): EstimateFollowupConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...ESTIMATE_FOLLOWUP_CONFIG_DEFAULTS };
  }
  const obj = raw as Record<string, unknown>;
  const f1 = obj.followup_1_hours;
  const f2 = obj.followup_2_hours;
  const validF1 = isFiniteInteger(f1) && f1 >= FOLLOWUP_HOURS_MIN && f1 <= FOLLOWUP_HOURS_MAX;
  const validF2 = isFiniteInteger(f2) && f2 >= FOLLOWUP_HOURS_MIN && f2 <= FOLLOWUP_HOURS_MAX;
  if (validF1 && validF2 && (f2 as number) > (f1 as number)) {
    return { followup_1_hours: f1 as number, followup_2_hours: f2 as number };
  }
  return { ...ESTIMATE_FOLLOWUP_CONFIG_DEFAULTS };
}

const ESTIMATE_FOLLOWUP_CONFIG_KEYS = new Set(["followup_1_hours", "followup_2_hours"]);

/** Strict validation path for an admin-submitted write - see the module comment above. Rejects, never coerces. */
export function validateEstimateFollowupConfig(input: unknown): ConfigValidationResult<EstimateFollowupConfig> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid configuration." };
  }
  const obj = input as Record<string, unknown>;
  const extraKeys = Object.keys(obj).filter((key) => !ESTIMATE_FOLLOWUP_CONFIG_KEYS.has(key));
  if (extraKeys.length > 0) {
    return { ok: false, error: `Unknown configuration field(s): ${extraKeys.join(", ")}.` };
  }
  const f1 = obj.followup_1_hours;
  const f2 = obj.followup_2_hours;

  if (typeof f1 !== "number" || !Number.isFinite(f1)) return { ok: false, error: "First follow-up must be a number." };
  if (typeof f2 !== "number" || !Number.isFinite(f2)) return { ok: false, error: "Second follow-up must be a number." };
  if (!Number.isInteger(f1) || !Number.isInteger(f2)) return { ok: false, error: "Follow-up timing must be whole numbers of hours." };
  if (f1 < FOLLOWUP_HOURS_MIN || f1 > FOLLOWUP_HOURS_MAX) {
    return { ok: false, error: `First follow-up must be between ${FOLLOWUP_HOURS_MIN} and ${FOLLOWUP_HOURS_MAX} hours.` };
  }
  if (f2 < FOLLOWUP_HOURS_MIN || f2 > FOLLOWUP_HOURS_MAX) {
    return { ok: false, error: `Second follow-up must be between ${FOLLOWUP_HOURS_MIN} and ${FOLLOWUP_HOURS_MAX} hours.` };
  }
  if (f2 <= f1) {
    return { ok: false, error: "Second follow-up must be later than the first follow-up." };
  }

  return { ok: true, value: { followup_1_hours: f1, followup_2_hours: f2 } };
}

// ---- inbound-customer-reply: recent_message_window, respect_business_hours ----
//
// Automation Configuration V2.1/V2.2. recent_message_window controls only
// how many recent conversation messages are included in the AI's context
// when n8n drafts a reply - see lib/automation/customer-reply.ts.
// respect_business_hours (V2.2) controls only whether the outbound gate
// additionally requires the organization's configured business hours to be
// open before allowing this automation's send - see
// lib/automation/outbound-gate.ts's isWithinBusinessHours(). Neither field
// has any bearing on content safety, opt-out handling, duplicate-send
// protection, retry, execution/authorization behavior, or n8n/Twilio.

export type InboundCustomerReplyConfig = { recent_message_window: number; respect_business_hours: boolean };

export const DEFAULT_INBOUND_CUSTOMER_REPLY_CONFIG: InboundCustomerReplyConfig = {
  recent_message_window: 10,
  respect_business_hours: false,
};

/**
 * Conservative, documented bounds - not derived from any hard technical
 * constraint. Minimum of 1 keeps at least the triggering exchange for
 * context. Maximum of 50 preserves the existing "bounded so the AI gets
 * useful context without an unbounded transcript dump" rationale already
 * documented in customer-reply.ts.
 */
export const RECENT_MESSAGE_WINDOW_MIN = 1;
export const RECENT_MESSAGE_WINDOW_MAX = 50;

/**
 * Lenient read path - see the module comment above. Never throws. Each
 * field is defaulted independently (not a joint fallback like
 * readEstimateFollowupConfig's f1/f2 pair) - the two fields have no
 * cross-field constraint, and an organization that saved a V2.1-era config
 * (recent_message_window only, before respect_business_hours existed) must
 * keep reading recent_message_window correctly, with respect_business_hours
 * simply defaulting to false, rather than the whole stored object being
 * treated as malformed.
 */
export function readInboundCustomerReplyConfig(raw: unknown): InboundCustomerReplyConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_INBOUND_CUSTOMER_REPLY_CONFIG };
  }
  const obj = raw as Record<string, unknown>;

  const windowValue = obj.recent_message_window;
  const recentMessageWindow =
    isFiniteInteger(windowValue) && windowValue >= RECENT_MESSAGE_WINDOW_MIN && windowValue <= RECENT_MESSAGE_WINDOW_MAX
      ? windowValue
      : DEFAULT_INBOUND_CUSTOMER_REPLY_CONFIG.recent_message_window;

  const respectBusinessHours =
    typeof obj.respect_business_hours === "boolean" ? obj.respect_business_hours : DEFAULT_INBOUND_CUSTOMER_REPLY_CONFIG.respect_business_hours;

  return { recent_message_window: recentMessageWindow, respect_business_hours: respectBusinessHours };
}

const INBOUND_CUSTOMER_REPLY_CONFIG_KEYS = new Set(["recent_message_window", "respect_business_hours"]);

/** Strict validation path for an admin-submitted write - see the module comment above. Rejects, never coerces. Requires both fields present. */
export function validateInboundCustomerReplyConfig(input: unknown): ConfigValidationResult<InboundCustomerReplyConfig> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid configuration." };
  }
  const obj = input as Record<string, unknown>;
  const extraKeys = Object.keys(obj).filter((key) => !INBOUND_CUSTOMER_REPLY_CONFIG_KEYS.has(key));
  if (extraKeys.length > 0) {
    return { ok: false, error: `Unknown configuration field(s): ${extraKeys.join(", ")}.` };
  }
  const windowValue = obj.recent_message_window;
  if (typeof windowValue !== "number" || !Number.isFinite(windowValue)) {
    return { ok: false, error: "Recent message context must be a number." };
  }
  if (!Number.isInteger(windowValue)) {
    return { ok: false, error: "Recent message context must be a whole number." };
  }
  if (windowValue < RECENT_MESSAGE_WINDOW_MIN || windowValue > RECENT_MESSAGE_WINDOW_MAX) {
    return { ok: false, error: `Recent message context must be between ${RECENT_MESSAGE_WINDOW_MIN} and ${RECENT_MESSAGE_WINDOW_MAX} messages.` };
  }
  if (typeof obj.respect_business_hours !== "boolean") {
    return { ok: false, error: "Respect business hours must be true or false." };
  }
  return { ok: true, value: { recent_message_window: windowValue, respect_business_hours: obj.respect_business_hours } };
}

// ---- instant-lead-followup: respect_business_hours ----
//
// Automation Configuration V2.2. Controls only whether the outbound gate
// additionally requires the organization's configured business hours to be
// open before allowing this automation's send - see the module comment
// above and lib/automation/outbound-gate.ts's isWithinBusinessHours().

export type InstantLeadFollowupConfig = { respect_business_hours: boolean };

export const DEFAULT_INSTANT_LEAD_FOLLOWUP_CONFIG: InstantLeadFollowupConfig = { respect_business_hours: false };

/** Lenient read path - see the module comment above. Never throws. */
export function readInstantLeadFollowupConfig(raw: unknown): InstantLeadFollowupConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_INSTANT_LEAD_FOLLOWUP_CONFIG };
  }
  const value = (raw as Record<string, unknown>).respect_business_hours;
  return {
    respect_business_hours: typeof value === "boolean" ? value : DEFAULT_INSTANT_LEAD_FOLLOWUP_CONFIG.respect_business_hours,
  };
}

const INSTANT_LEAD_FOLLOWUP_CONFIG_KEYS = new Set(["respect_business_hours"]);

/** Strict validation path for an admin-submitted write - see the module comment above. Rejects, never coerces. */
export function validateInstantLeadFollowupConfig(input: unknown): ConfigValidationResult<InstantLeadFollowupConfig> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid configuration." };
  }
  const obj = input as Record<string, unknown>;
  const extraKeys = Object.keys(obj).filter((key) => !INSTANT_LEAD_FOLLOWUP_CONFIG_KEYS.has(key));
  if (extraKeys.length > 0) {
    return { ok: false, error: `Unknown configuration field(s): ${extraKeys.join(", ")}.` };
  }
  if (typeof obj.respect_business_hours !== "boolean") {
    return { ok: false, error: "Respect business hours must be true or false." };
  }
  return { ok: true, value: { respect_business_hours: obj.respect_business_hours } };
}

// ---- lost-lead-nurture: touch_1_days / touch_2_days ----
//
// Automation Configuration V3. Controls only the elapsed-time thresholds
// lib/automation/lead-nurture.ts uses to decide whether a lost lead is due
// its first or second nurture touch - see computeNurtureOccurrence() there.
// Has no bearing on the outbound gate, content safety, opt-out handling,
// duplicate-send protection, retry, execution/authorization behavior,
// business-hours logic, or n8n/Twilio.

export type LostLeadNurtureConfig = { touch_1_days: number; touch_2_days: number };

export const DEFAULT_LOST_LEAD_NURTURE_CONFIG: LostLeadNurtureConfig = { touch_1_days: 3, touch_2_days: 14 };

/** Same "conservative, documented, not technically derived" rationale as the other timing bounds above. 90 days is a generous but bounded ceiling for a nurture cadence. */
export const NURTURE_TOUCH_DAYS_MIN = 1;
export const NURTURE_TOUCH_DAYS_MAX = 90;

/** Lenient read path - see the module comment above. Never throws. Also silently falls back to defaults if touch_2 <= touch_1 (touch 2 must fire strictly after touch 1, or touch 1 would never be reachable - see computeNurtureOccurrence's logic), mirroring readEstimateFollowupConfig's identical cross-field rationale. */
export function readLostLeadNurtureConfig(raw: unknown): LostLeadNurtureConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_LOST_LEAD_NURTURE_CONFIG };
  }
  const obj = raw as Record<string, unknown>;
  const t1 = obj.touch_1_days;
  const t2 = obj.touch_2_days;
  const validT1 = isFiniteInteger(t1) && t1 >= NURTURE_TOUCH_DAYS_MIN && t1 <= NURTURE_TOUCH_DAYS_MAX;
  const validT2 = isFiniteInteger(t2) && t2 >= NURTURE_TOUCH_DAYS_MIN && t2 <= NURTURE_TOUCH_DAYS_MAX;
  if (validT1 && validT2 && (t2 as number) > (t1 as number)) {
    return { touch_1_days: t1 as number, touch_2_days: t2 as number };
  }
  return { ...DEFAULT_LOST_LEAD_NURTURE_CONFIG };
}

const LOST_LEAD_NURTURE_CONFIG_KEYS = new Set(["touch_1_days", "touch_2_days"]);

/** Strict validation path for an admin-submitted write - see the module comment above. Rejects, never coerces. */
export function validateLostLeadNurtureConfig(input: unknown): ConfigValidationResult<LostLeadNurtureConfig> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid configuration." };
  }
  const obj = input as Record<string, unknown>;
  const extraKeys = Object.keys(obj).filter((key) => !LOST_LEAD_NURTURE_CONFIG_KEYS.has(key));
  if (extraKeys.length > 0) {
    return { ok: false, error: `Unknown configuration field(s): ${extraKeys.join(", ")}.` };
  }
  const t1 = obj.touch_1_days;
  const t2 = obj.touch_2_days;

  if (typeof t1 !== "number" || !Number.isFinite(t1)) return { ok: false, error: "First follow-up must be a number." };
  if (typeof t2 !== "number" || !Number.isFinite(t2)) return { ok: false, error: "Second follow-up must be a number." };
  if (!Number.isInteger(t1) || !Number.isInteger(t2)) return { ok: false, error: "Follow-up timing must be whole numbers of days." };
  if (t1 < NURTURE_TOUCH_DAYS_MIN || t1 > NURTURE_TOUCH_DAYS_MAX) {
    return { ok: false, error: `First follow-up must be between ${NURTURE_TOUCH_DAYS_MIN} and ${NURTURE_TOUCH_DAYS_MAX} days.` };
  }
  if (t2 < NURTURE_TOUCH_DAYS_MIN || t2 > NURTURE_TOUCH_DAYS_MAX) {
    return { ok: false, error: `Second follow-up must be between ${NURTURE_TOUCH_DAYS_MIN} and ${NURTURE_TOUCH_DAYS_MAX} days.` };
  }
  if (t2 <= t1) {
    return { ok: false, error: "Second follow-up must be later than the first follow-up." };
  }

  return { ok: true, value: { touch_1_days: t1, touch_2_days: t2 } };
}

// ---- lead-reactivation: touch_1_days / touch_2_days ----
//
// Automation Configuration V4. Controls only the elapsed-time thresholds
// lib/automation/lead-reactivation.ts uses to decide whether a quiet lead
// is due its first or second reactivation touch - see
// computeReactivationOccurrence() there. Has no bearing on the outbound
// gate, content safety, opt-out handling, duplicate-send protection,
// retry, execution/authorization behavior, business-hours logic, or
// n8n/Twilio.

export type LeadReactivationConfig = { touch_1_days: number; touch_2_days: number };

export const DEFAULT_LEAD_REACTIVATION_CONFIG: LeadReactivationConfig = { touch_1_days: 7, touch_2_days: 21 };

/**
 * Deliberately its own named pair, not a reuse of NURTURE_TOUCH_DAYS_MIN/MAX
 * above - the two automations' bounds happen to share the same values
 * today, but lead-reactivation and lost-lead-nurture are independent
 * automations with independent config rows; coupling their bounds
 * constants would make a future change to one silently affect the other.
 * Same "conservative, documented, not technically derived" rationale as
 * every other timing bound in this file.
 */
export const REACTIVATION_TOUCH_DAYS_MIN = 1;
export const REACTIVATION_TOUCH_DAYS_MAX = 90;

/** Lenient read path - see the module comment above. Never throws. Also silently falls back to defaults if touch_2 <= touch_1 (touch 2 must fire strictly after touch 1, or touch 1 would never be reachable - see computeReactivationOccurrence's logic), mirroring readLostLeadNurtureConfig's identical cross-field rationale. */
export function readLeadReactivationConfig(raw: unknown): LeadReactivationConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_LEAD_REACTIVATION_CONFIG };
  }
  const obj = raw as Record<string, unknown>;
  const t1 = obj.touch_1_days;
  const t2 = obj.touch_2_days;
  const validT1 = isFiniteInteger(t1) && t1 >= REACTIVATION_TOUCH_DAYS_MIN && t1 <= REACTIVATION_TOUCH_DAYS_MAX;
  const validT2 = isFiniteInteger(t2) && t2 >= REACTIVATION_TOUCH_DAYS_MIN && t2 <= REACTIVATION_TOUCH_DAYS_MAX;
  if (validT1 && validT2 && (t2 as number) > (t1 as number)) {
    return { touch_1_days: t1 as number, touch_2_days: t2 as number };
  }
  return { ...DEFAULT_LEAD_REACTIVATION_CONFIG };
}

const LEAD_REACTIVATION_CONFIG_KEYS = new Set(["touch_1_days", "touch_2_days"]);

/** Strict validation path for an admin-submitted write - see the module comment above. Rejects, never coerces. */
export function validateLeadReactivationConfig(input: unknown): ConfigValidationResult<LeadReactivationConfig> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid configuration." };
  }
  const obj = input as Record<string, unknown>;
  const extraKeys = Object.keys(obj).filter((key) => !LEAD_REACTIVATION_CONFIG_KEYS.has(key));
  if (extraKeys.length > 0) {
    return { ok: false, error: `Unknown configuration field(s): ${extraKeys.join(", ")}.` };
  }
  const t1 = obj.touch_1_days;
  const t2 = obj.touch_2_days;

  if (typeof t1 !== "number" || !Number.isFinite(t1)) return { ok: false, error: "First follow-up must be a number." };
  if (typeof t2 !== "number" || !Number.isFinite(t2)) return { ok: false, error: "Second follow-up must be a number." };
  if (!Number.isInteger(t1) || !Number.isInteger(t2)) return { ok: false, error: "Follow-up timing must be whole numbers of days." };
  if (t1 < REACTIVATION_TOUCH_DAYS_MIN || t1 > REACTIVATION_TOUCH_DAYS_MAX) {
    return { ok: false, error: `First follow-up must be between ${REACTIVATION_TOUCH_DAYS_MIN} and ${REACTIVATION_TOUCH_DAYS_MAX} days.` };
  }
  if (t2 < REACTIVATION_TOUCH_DAYS_MIN || t2 > REACTIVATION_TOUCH_DAYS_MAX) {
    return { ok: false, error: `Second follow-up must be between ${REACTIVATION_TOUCH_DAYS_MIN} and ${REACTIVATION_TOUCH_DAYS_MAX} days.` };
  }
  if (t2 <= t1) {
    return { ok: false, error: "Second follow-up must be later than the first follow-up." };
  }

  return { ok: true, value: { touch_1_days: t1, touch_2_days: t2 } };
}

// ---- Shared DB access ----

/** Single organization, single automation - raw config, for a dry-run preview or any other single-org read. */
export async function getAutomationConfig(supabase: SupabaseClient, organizationId: string, automationId: string): Promise<unknown> {
  const { data } = await supabase
    .from("automation_settings")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("automation_id", automationId)
    .maybeSingle();

  return data?.config ?? null;
}

/** Single organization, every automation it has ever configured - for rendering the automation list/detail UI in one query. */
export async function getAutomationConfigMap(supabase: SupabaseClient, organizationId: string): Promise<Map<string, unknown>> {
  const map = new Map<string, unknown>();

  const { data } = await supabase.from("automation_settings").select("automation_id, config").eq("organization_id", organizationId);

  for (const row of (data ?? []) as { automation_id: string; config: unknown }[]) {
    map.set(row.automation_id, row.config);
  }

  return map;
}

/**
 * Single automation, every organization that has ever configured it - keyed
 * by organization_id. Used by the scan-wide functions
 * (processAppointmentReminders/processEstimateFollowups) whose candidate
 * query spans every organization at once (the cron path), where a single
 * global config value can no longer be assumed. Safe and correct for the
 * manual-run path too without any special-casing: RLS (automation_settings_
 * select -> is_org_member) already scopes this to exactly the caller's own
 * organization's row when called with a session client, so the map simply
 * contains at most one entry in that case.
 */
export async function getAutomationConfigByOrganization(supabase: SupabaseClient, automationId: string): Promise<Map<string, unknown>> {
  const map = new Map<string, unknown>();

  const { data } = await supabase.from("automation_settings").select("organization_id, config").eq("automation_id", automationId);

  for (const row of (data ?? []) as { organization_id: string; config: unknown }[]) {
    map.set(row.organization_id, row.config);
  }

  return map;
}

export type ConfigUpdateAudit = {
  action: "automation_config_updated";
  metadata: { previous_config: Record<string, unknown>; new_config: Record<string, unknown> };
};

/**
 * The pure decision behind every config-update Server Action's audit call -
 * generic across both configurable automations, since both configs are
 * flat objects of the same shape produced deterministically by the same
 * read/validate functions (stable key order), so a JSON-string comparison
 * is a safe, simple equality check. Returns null for a no-op save (the
 * submitted value is identical to what's already stored) - no audit row
 * for a save that didn't actually change anything.
 */
export function shouldAuditConfigUpdate(
  previousConfig: Record<string, unknown>,
  newConfig: Record<string, unknown>,
): ConfigUpdateAudit | null {
  if (JSON.stringify(previousConfig) === JSON.stringify(newConfig)) return null;
  return { action: "automation_config_updated", metadata: { previous_config: previousConfig, new_config: newConfig } };
}
