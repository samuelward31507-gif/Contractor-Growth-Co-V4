import type { SupabaseClient } from "@supabase/supabase-js";
import { getAutomationEnabled } from "@/lib/automation/settings";
import { FOLLOWUP_CADENCE_HOURS, touchDueAt } from "./config";
import { FOLLOWUP_AUTOMATION_ID, FOLLOWUP_COLUMNS, transitionFollowup, type FollowupRow } from "./store";

const HOUR_MS = 60 * 60 * 1000;

/**
 * P0 A4: the Follow-Up Engine's producers. They only record INTENT in
 * public.followups - they never send and never dispatch; the dispatcher in
 * engine.ts is the only thing that acts.
 */

export type EnsureFollowupResult =
  | { outcome: "disabled" }
  | { outcome: "created"; followup: FollowupRow }
  | { outcome: "existing"; followup: FollowupRow }
  | { outcome: "failed"; error: string };

/**
 * Producer: records that a new lead is owed a no-reply follow-up. Expresses
 * intent only - never sends, never dispatches. Default-off: nothing is
 * recorded unless the organization has enabled the automation. One row per
 * (lead, stage) - a repeated call returns the existing row.
 */
export async function ensureLeadFollowup(
  service: SupabaseClient,
  input: { organizationId: string; leadId: string; now?: Date },
): Promise<EnsureFollowupResult> {
  if (!(await getAutomationEnabled(service, input.organizationId, FOLLOWUP_AUTOMATION_ID))) return { outcome: "disabled" };
  const now = input.now ?? new Date();

  const { data: inserted, error } = await service
    .from("followups")
    .insert({ organization_id: input.organizationId, lead_id: input.leadId, stage: "lead_no_reply", state: "pending", created_at: now.toISOString() })
    .select(FOLLOWUP_COLUMNS);
  if (error) {
    if (error.code === "23505") {
      const { data: existing } = await service.from("followups").select(FOLLOWUP_COLUMNS).eq("lead_id", input.leadId).eq("stage", "lead_no_reply").maybeSingle();
      if (existing) return { outcome: "existing", followup: existing as FollowupRow };
    }
    return { outcome: "failed", error: error.message };
  }
  const pending = ((inserted ?? []) as FollowupRow[])[0];
  if (!pending) return { outcome: "failed", error: "insert returned no row" };

  const firstDue = touchDueAt(new Date(pending.created_at), pending.stage, 1)!;
  const scheduled = await transitionFollowup(service, pending, "scheduled", { next_action_at: firstDue.toISOString(), waiting_on: "customer", next_action: "send_followup" });
  return { outcome: "created", followup: scheduled ?? pending };
}

/**
 * Reactivation: a dormant follow-up (its touch went stale - never sent late)
 * comes back when the lead shows fresh intent (another intake on the same
 * open lead). The next touch is rescheduled one first-cadence step from now,
 * never "now", so reactivation can never fire an old overdue touch.
 */
export async function reactivateLeadFollowup(
  service: SupabaseClient,
  input: { organizationId: string; leadId: string; now?: Date },
): Promise<FollowupRow | null> {
  if (!(await getAutomationEnabled(service, input.organizationId, FOLLOWUP_AUTOMATION_ID))) return null;
  const now = input.now ?? new Date();
  const { data } = await service.from("followups").select(FOLLOWUP_COLUMNS).eq("organization_id", input.organizationId).eq("lead_id", input.leadId).eq("state", "paused").eq("paused_reason", "dormant").maybeSingle();
  if (!data) return null;
  const row = data as FollowupRow;
  const next = new Date(now.getTime() + FOLLOWUP_CADENCE_HOURS[row.stage][0] * HOUR_MS);
  return transitionFollowup(service, row, "scheduled", { next_action_at: next.toISOString(), paused_reason: null, reactivated_at: now.toISOString(), waiting_on: "customer", next_action: "send_followup" });
}

