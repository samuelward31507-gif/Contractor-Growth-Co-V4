import type { SupabaseClient } from "@supabase/supabase-js";
import { contactDisplayName } from "@/lib/contacts/format";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import { fromCents, isOverdue, toCents } from "@/lib/invoices/domain";
import { INVOICING_LIVE_AT, type InvoiceMoneySummary } from "@/lib/invoices/summary";
import type { AttentionItem } from "./queries";

/**
 * Phase 2D: the Dashboard's SQL-backed loaders (supabase/pending/
 * dashboard_sql.sql). The database counts and sums over the organization's
 * complete data - no more 1,000/5,000/500/2,000-row reads summed in
 * TypeScript - and this module turns the raw figures back into exactly the
 * shapes and strings the Dashboard already rendered. Definitions are the
 * existing TypeScript ones (see the SQL file's header); parity is proved by
 * supabase/pending/scratch/validate-dashboard-sql.mjs.
 *
 * Time semantics are unchanged and stay here: "today" for appointments and
 * the briefing is the server-local calendar day (what
 * summarizeAppointments / briefing isToday have always used), passed to SQL
 * as [dayStart, dayEnd); invoice "overdue" is still judged by isOverdue
 * against the organization-timezone date the page computes.
 */

/** The server-local calendar day containing `now`, as [start, end) - exactly the day isSameCalendarDay/isToday compare against. */
export function serverLocalDayBounds(now: Date): { dayStart: Date; dayEnd: Date } {
  return { dayStart: new Date(now.getFullYear(), now.getMonth(), now.getDate()), dayEnd: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) };
}

const sumCents = (values: number[]) => fromCents(values.reduce((sum, value) => sum + toCents(value), 0));

// ---------------------------------------------------------------------------
// dashboard_summary
// ---------------------------------------------------------------------------

export type DashboardSummary = {
  hot_lead_count: number;
  pipeline_value: number;
  appointments_today: number;
  quotes_out_count: number;
  quotes_out_value: number;
  ready_to_schedule_count: number;
  ready_to_schedule_value: number;
  won_not_finished_count: number;
  won_not_finished_value: number;
  invoiced: number;
  invoiced_count: number;
  collected: number;
  payment_count: number;
  outstanding: number;
  outstanding_count: number;
  open_due_buckets: { due_date: string; balance_due: number; count: number }[];
  draft_count: number;
  not_yet_invoiced_count: number;
  not_yet_invoiced_known_value: number;
  not_yet_invoiced_unknown_count: number;
};

/** What the page showed when its reads failed: every figure 0 (the reads returned []). */
export const EMPTY_DASHBOARD_SUMMARY: DashboardSummary = {
  hot_lead_count: 0,
  pipeline_value: 0,
  appointments_today: 0,
  quotes_out_count: 0,
  quotes_out_value: 0,
  ready_to_schedule_count: 0,
  ready_to_schedule_value: 0,
  won_not_finished_count: 0,
  won_not_finished_value: 0,
  invoiced: 0,
  invoiced_count: 0,
  collected: 0,
  payment_count: 0,
  outstanding: 0,
  outstanding_count: 0,
  open_due_buckets: [],
  draft_count: 0,
  not_yet_invoiced_count: 0,
  not_yet_invoiced_known_value: 0,
  not_yet_invoiced_unknown_count: 0,
};

export async function getDashboardSummary(supabase: SupabaseClient, organizationId: string, now: Date = new Date()): Promise<{ data: DashboardSummary; failed: boolean }> {
  const { dayStart, dayEnd } = serverLocalDayBounds(now);
  const { data, error } = await supabase.rpc("dashboard_summary", {
    p_organization_id: organizationId,
    p_day_start: dayStart.toISOString(),
    p_day_end: dayEnd.toISOString(),
    p_invoicing_live_at: INVOICING_LIVE_AT,
  });
  if (error || !data) return { data: EMPTY_DASHBOARD_SUMMARY, failed: true };
  return { data: data as DashboardSummary, failed: false };
}

/** The four "Money at a glance" figures computeMoneySnapshot produced (counts of its lists, and knownOpportunityValue). */
export type DashboardMoneyCounts = { quotesOutCount: number; readyToScheduleCount: number; wonNotFinishedCount: number; knownOpportunityValue: number };

export function dashboardMoneyCounts(summary: DashboardSummary): DashboardMoneyCounts {
  return {
    quotesOutCount: summary.quotes_out_count,
    readyToScheduleCount: summary.ready_to_schedule_count,
    wonNotFinishedCount: summary.won_not_finished_count,
    knownOpportunityValue: sumCents([summary.quotes_out_value, summary.ready_to_schedule_value, summary.won_not_finished_value]),
  };
}

/** summarizeInvoiceMoney's result, from the SQL aggregates - overdue still decided by isOverdue against the org-timezone `today`. */
export function dashboardInvoiceSummary(summary: DashboardSummary, today: string): InvoiceMoneySummary {
  const overdueBuckets = summary.open_due_buckets.filter((bucket) => isOverdue({ status: "sent", dueDate: bucket.due_date }, today));
  return {
    invoiced: sumCents([summary.invoiced]),
    invoicedCount: summary.invoiced_count,
    collected: sumCents([summary.collected]),
    paymentCount: summary.payment_count,
    outstanding: sumCents([summary.outstanding]),
    outstandingCount: summary.outstanding_count,
    overdue: sumCents(overdueBuckets.map((bucket) => bucket.balance_due)),
    overdueCount: overdueBuckets.reduce((count, bucket) => count + bucket.count, 0),
    draftCount: summary.draft_count,
    notYetInvoicedCount: summary.not_yet_invoiced_count,
    notYetInvoicedKnownValue: sumCents([summary.not_yet_invoiced_known_value]),
    notYetInvoicedUnknownCount: summary.not_yet_invoiced_unknown_count,
  };
}

// ---------------------------------------------------------------------------
// dashboard_conversation_attention
// ---------------------------------------------------------------------------

type ConversationAttentionRow = {
  kind: "awaiting_reply" | "abandoned_conversation";
  item_position: number;
  conversation_id: string;
  contact_first_name: string | null;
  contact_last_name: string | null;
  last_activity_at: string;
};

function nameOrNull(first: string | null, last: string | null): string | null {
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name || null;
}

/**
 * getDashboardData's awaiting_reply / abandoned_conversation items (at most 5
 * each, same order, same text). A failed read yields none - exactly what the
 * conversations/messages reads did before (they never set partialData).
 */
export async function getDashboardConversationAttention(supabase: SupabaseClient, organizationId: string, now: number = Date.now()): Promise<{ awaitingReply: AttentionItem[]; abandonedConversations: AttentionItem[] }> {
  const { data, error } = await supabase.rpc("dashboard_conversation_attention", { p_organization_id: organizationId, p_now: new Date(now).toISOString() });
  const rows = (error || !data ? [] : (data as ConversationAttentionRow[])).slice().sort((a, b) => a.item_position - b.item_position);
  const awaitingReply: AttentionItem[] = rows
    .filter((row) => row.kind === "awaiting_reply")
    .map((row) => ({
      id: `reply-${row.conversation_id}`,
      kind: "awaiting_reply",
      title: nameOrNull(row.contact_first_name, row.contact_last_name) ?? "Customer",
      detail: `Waiting for a reply ${formatRelativeTime(row.last_activity_at)}`,
      value: null,
      href: `/conversations/${row.conversation_id}`,
    }));
  const abandonedConversations: AttentionItem[] = rows
    .filter((row) => row.kind === "abandoned_conversation")
    .map((row) => ({
      id: `abandoned-${row.conversation_id}`,
      kind: "abandoned_conversation",
      title: nameOrNull(row.contact_first_name, row.contact_last_name) ?? "Customer",
      detail: `No reply since we last reached out, ${formatRelativeTime(row.last_activity_at)}`,
      value: null,
      href: `/conversations/${row.conversation_id}`,
    }));
  return { awaitingReply, abandonedConversations };
}

// ---------------------------------------------------------------------------
// dashboard_briefing
// ---------------------------------------------------------------------------

type NamedRow = { id: string; title: string; contact_first_name: string | null; contact_last_name: string | null; has_contact: boolean };
export type DashboardBriefingInputs = {
  appointments_today: (NamedRow & { start_at: string })[];
  estimates_awaiting: (NamedRow & { amount: number | null })[];
  jobs_recently_completed: (NamedRow & { amount: number | null })[];
  responded_reviews: { id: string; status: string; job_id: string }[];
  responded_referrals: { id: string; status: string; job_id: string }[];
  appointments_booked_today: number;
  estimates_sent_today: number;
  estimates_sent_today_value: number;
  jobs_won_or_completed_today: number;
  jobs_won_or_completed_today_value: number;
  ai_escalations_count: number;
  hot_lead_count: number;
};

export const EMPTY_BRIEFING_INPUTS: DashboardBriefingInputs = {
  appointments_today: [],
  estimates_awaiting: [],
  jobs_recently_completed: [],
  responded_reviews: [],
  responded_referrals: [],
  appointments_booked_today: 0,
  estimates_sent_today: 0,
  estimates_sent_today_value: 0,
  jobs_won_or_completed_today: 0,
  jobs_won_or_completed_today_value: 0,
  ai_escalations_count: 0,
  hot_lead_count: 0,
};

export async function getDashboardBriefingInputs(supabase: SupabaseClient, organizationId: string, now: Date = new Date()): Promise<{ data: DashboardBriefingInputs; failed: boolean }> {
  const { dayStart, dayEnd } = serverLocalDayBounds(now);
  const { data, error } = await supabase.rpc("dashboard_briefing", {
    p_organization_id: organizationId,
    p_day_start: dayStart.toISOString(),
    p_day_end: dayEnd.toISOString(),
    p_seven_days_ago: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error || !data) return { data: EMPTY_BRIEFING_INPUTS, failed: true };
  return { data: data as DashboardBriefingInputs, failed: false };
}

/** The contact label the briefing lists used: contactDisplayName when there is a contact, null when there isn't. */
export function briefingContactName(row: NamedRow): string | null {
  return row.has_contact ? contactDisplayName({ first_name: row.contact_first_name, last_name: row.contact_last_name }) : null;
}

export function briefingMoney(amount: number | null): string | null {
  return amount != null ? formatCurrency(amount) : null;
}

// ---------------------------------------------------------------------------
// dashboard_record_attention (supabase/pending/dashboard_attention_sql.sql)
// ---------------------------------------------------------------------------

type ContactNameColumns = { contact_first_name: string | null; contact_last_name: string | null };
export type DashboardRecordAttention = {
  overdue_appointments: ({ id: string; title: string; start_at: string } & ContactNameColumns)[];
  awaiting_confirmation: ({ id: string; title: string; confirmation_requested_at: string } & ContactNameColumns)[];
  hot_leads: ({ id: string; service: string | null; estimated_value: number | null } & ContactNameColumns)[];
  high_value_leads: ({ id: string; service: string | null; estimated_value: number | null } & ContactNameColumns)[];
  pending_estimate_leads: ({ id: string; service: string | null; estimated_value: number | null } & ContactNameColumns)[];
  uncontacted_dedup_lead_ids: string[];
  recent_leads: ({ id: string; service: string | null; created_at: string } & ContactNameColumns)[];
  recent_appointments: ({ id: string; title: string; created_at: string } & ContactNameColumns)[];
  new_leads: number;
  open_leads: number;
  upcoming_appointments: number;
  pending_estimates: number;
  pipeline: { new: number; contacted: number; qualified: number; appointment: number; estimate: number; won: number };
};

/** What getDashboardData produced when its leads/appointments/estimates reads all failed: nothing (the reads returned []). */
export const EMPTY_RECORD_ATTENTION: DashboardRecordAttention = {
  overdue_appointments: [],
  awaiting_confirmation: [],
  hot_leads: [],
  high_value_leads: [],
  pending_estimate_leads: [],
  uncontacted_dedup_lead_ids: [],
  recent_leads: [],
  recent_appointments: [],
  new_leads: 0,
  open_leads: 0,
  upcoming_appointments: 0,
  pending_estimates: 0,
  pipeline: { new: 0, contacted: 0, qualified: 0, appointment: 0, estimate: 0, won: 0 },
};

/**
 * Phase 2E: everything getDashboardData derived from its leads (500),
 * appointments (200) and estimates (500) reads, computed over complete data.
 * `highValueThreshold` is passed in (HIGH_VALUE_THRESHOLD) so the definition
 * keeps one source of truth.
 */
export async function getDashboardRecordAttention(supabase: SupabaseClient, organizationId: string, highValueThreshold: number, now: number = Date.now()): Promise<{ data: DashboardRecordAttention; failed: boolean }> {
  const { data, error } = await supabase.rpc("dashboard_record_attention", {
    p_organization_id: organizationId,
    p_now: new Date(now).toISOString(),
    p_high_value_threshold: highValueThreshold,
  });
  if (error || !data) return { data: EMPTY_RECORD_ATTENTION, failed: true };
  return { data: data as DashboardRecordAttention, failed: false };
}
