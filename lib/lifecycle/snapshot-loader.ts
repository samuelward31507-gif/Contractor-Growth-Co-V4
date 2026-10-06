import type { SupabaseClient } from "@supabase/supabase-js";
import { getAutomationConfig, readCustomerReactivationConfig, readEstimateFollowupConfig } from "@/lib/automation/settings";
import { INVOICING_LIVE_AT } from "@/lib/invoices/summary";
import type { LifecycleSnapshot, SnapshotMessage } from "./snapshot";

/**
 * P0-B B1: reads one contact's lifecycle facts into a typed LifecycleSnapshot.
 * READ-ONLY: SELECTs only, no writes, no new persistent state. Every query
 * is scoped by organization_id AND contact_id (never relies on RLS alone),
 * so it is safe with a member's session client (RLS also applies) or the
 * service-role client. A failed read is reported via `failed`, never turned
 * into "no rows" silently - callers must not act on a failed snapshot.
 *
 * Not wired into any consumer in B1.
 */

/** Messages read for the lead-phase signals (respond / converse / awaiting reply). */
export const SNAPSHOT_MESSAGE_LIMIT = 200;
const ROW_LIMIT = 500;

export type LoadedLifecycleSnapshot = { snapshot: LifecycleSnapshot; failed: false } | { snapshot: null; failed: true; error: string };

export async function loadLifecycleSnapshot(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  options: { asOf?: Date } = {},
): Promise<LoadedLifecycleSnapshot> {
  const asOf = (options.asOf ?? new Date()).toISOString();
  const scoped = (table: string, columns: string) => supabase.from(table).select(columns).eq("organization_id", organizationId).eq("contact_id", contactId);

  const [contact, leads, appointments, estimates, jobs, invoices, conversations, opportunities, reactivationConfig, estimateConfig] = await Promise.all([
    supabase.from("contacts").select("id, sms_opt_out").eq("organization_id", organizationId).eq("id", contactId).maybeSingle(),
    scoped("leads", "id, status, created_at").limit(ROW_LIMIT),
    scoped("appointments", "id, lead_id, status, start_at, end_at, created_at").limit(ROW_LIMIT),
    scoped("estimates", "id, lead_id, status, sent_at, expires_at, created_at").limit(ROW_LIMIT),
    scoped("jobs", "id, lead_id, estimate_id, status, created_at, completed_at").limit(ROW_LIMIT),
    scoped("invoices", "id, job_id, status, due_date").limit(ROW_LIMIT),
    scoped("conversations", "id").limit(ROW_LIMIT),
    scoped("opportunities", "type").eq("status", "open").limit(ROW_LIMIT),
    getAutomationConfig(supabase, organizationId, "customer-reactivation"),
    getAutomationConfig(supabase, organizationId, "estimate-followup"),
  ]);

  const firstError = [contact, leads, appointments, estimates, jobs, invoices, conversations, opportunities].find((result) => result.error)?.error;
  if (firstError) return { snapshot: null, failed: true, error: firstError.message };
  if (!contact.data) return { snapshot: null, failed: true, error: "contact_not_found" };

  // Review/referral requests by the contact's jobs (their own contact_id is nullable).
  const jobIds = ((jobs.data ?? []) as unknown as { id: string }[]).map((row) => row.id);
  const requests = (table: string) =>
    jobIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : supabase.from(table).select("id, job_id, status, requested_at").eq("organization_id", organizationId).in("job_id", jobIds).limit(ROW_LIMIT);
  const [reviews, referrals] = await Promise.all([requests("review_requests"), requests("referral_requests")]);
  const requestError = reviews.error ?? referrals.error;
  if (requestError) return { snapshot: null, failed: true, error: requestError.message };

  const conversationIds = ((conversations.data ?? []) as unknown as { id: string }[]).map((row) => row.id);
  let messages: SnapshotMessage[] = [];
  if (conversationIds.length > 0) {
    const read = await supabase
      .from("messages")
      .select("direction, status, created_at")
      .eq("organization_id", organizationId)
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: false })
      .limit(SNAPSHOT_MESSAGE_LIMIT);
    if (read.error) return { snapshot: null, failed: true, error: read.error.message };
    messages = ((read.data ?? []) as { direction: "inbound" | "outbound"; status: string | null; created_at: string }[]).map((row) => ({ direction: row.direction, status: row.status, createdAt: row.created_at }));
  }

  type Row = Record<string, string | null>;
  const rows = (result: { data: unknown }) => (result.data ?? []) as Row[];

  return {
    failed: false,
    snapshot: {
      contactId,
      asOf,
      policy: {
        dormancyDays: readCustomerReactivationConfig(reactivationConfig).inactivity_days,
        estimateFollowupHours: readEstimateFollowupConfig(estimateConfig).followup_1_hours,
        invoicingLiveAt: INVOICING_LIVE_AT,
      },
      smsOptOut: Boolean((contact.data as { sms_opt_out?: boolean }).sms_opt_out),
      leads: rows(leads).map((row) => ({ id: row.id!, status: row.status!, createdAt: row.created_at! })),
      appointments: rows(appointments).map((row) => ({ id: row.id!, leadId: row.lead_id, status: row.status!, startAt: row.start_at!, endAt: row.end_at, createdAt: row.created_at })),
      estimates: rows(estimates).map((row) => ({ id: row.id!, leadId: row.lead_id, status: row.status!, sentAt: row.sent_at, expiresAt: row.expires_at, createdAt: row.created_at! })),
      jobs: rows(jobs).map((row) => ({ id: row.id!, leadId: row.lead_id, estimateId: row.estimate_id, status: row.status!, createdAt: row.created_at!, completedAt: row.completed_at })),
      invoices: rows(invoices).map((row) => ({ id: row.id!, jobId: row.job_id, status: row.status!, dueDate: row.due_date })),
      reviewRequests: rows(reviews).map((row) => ({ id: row.id!, jobId: row.job_id, status: row.status!, requestedAt: row.requested_at })),
      referralRequests: rows(referrals).map((row) => ({ id: row.id!, jobId: row.job_id, status: row.status!, requestedAt: row.requested_at })),
      messages,
      openOpportunityTypes: [...new Set(rows(opportunities).map((row) => row.type!))].sort(),
    },
  };
}
