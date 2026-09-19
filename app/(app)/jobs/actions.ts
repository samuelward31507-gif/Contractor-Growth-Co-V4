"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { emitJobLifecycleEvent } from "@/lib/automation/jobs";
import { emitPostJobFollowup } from "@/lib/automation/post-job-followup";

/**
 * Job status transitions. Jobs themselves are only ever created by
 * lib/automation/jobs.ts's emitJobCreatedFromEstimate() (estimate accepted
 * -> exactly one job, per explicit decision) - there is no createJob action
 * here; manual job creation is intentionally out of scope, matching the
 * established architecture.
 */

export type JobActionResult = { ok: true; id?: string } | { ok: false; error: string };

async function requireOrganization() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  return { supabase, organizationId: membership.organizationId };
}

/**
 * scheduled -> in_progress. Status-only: the job.created/job.completed/
 * job.cancelled events are the only lifecycle events this architecture
 * defines (see JobLifecycleEventType in lib/automation/jobs.ts) - "started"
 * has no automation hook, so this stamps started_at for the contractor's
 * own record-keeping and nothing else, exactly matching the jobs table
 * migration's own comment that started_at/completed_at exist for
 * record-keeping with no automation deriving timing from them.
 */
export async function markJobStarted(jobId: string): Promise<JobActionResult> {
  const { supabase, organizationId } = await requireOrganization();

  const { data, error } = await supabase
    .from("jobs")
    .update({ status: "in_progress", started_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("organization_id", organizationId)
    .eq("status", "scheduled")
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: "We couldn't update this job." };
  if (!data) return { ok: false, error: "This job could not be found or is not in an eligible state." };

  revalidatePath("/jobs");
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, id: data.id };
}

async function transitionJob(
  jobId: string,
  toStatus: "completed" | "cancelled",
  fromStatuses: string[],
): Promise<JobActionResult> {
  const { supabase, organizationId } = await requireOrganization();

  const patch: Record<string, unknown> = { status: toStatus };
  if (toStatus === "completed") {
    patch.completed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("jobs")
    .update(patch)
    .eq("id", jobId)
    .eq("organization_id", organizationId)
    .in("status", fromStatuses)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: "We couldn't update this job." };
  if (!data) return { ok: false, error: "This job could not be found or is not in an eligible state." };

  if (toStatus === "completed") {
    await emitJobLifecycleEvent(supabase, jobId, "job.completed");
    // Phase 4.7: one combined thank-you + review-ask (when configured) +
    // referral-ask message, per explicit decision - idempotent, see
    // emitPostJobFollowup.
    await emitPostJobFollowup(supabase, organizationId, jobId);
  } else {
    await emitJobLifecycleEvent(supabase, jobId, "job.cancelled");
  }

  revalidatePath("/jobs");
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, id: data.id };
}

export async function markJobCompleted(jobId: string): Promise<JobActionResult> {
  return transitionJob(jobId, "completed", ["scheduled", "in_progress"]);
}

export async function markJobCancelled(jobId: string): Promise<JobActionResult> {
  return transitionJob(jobId, "cancelled", ["scheduled", "in_progress"]);
}

// ==================== Review & Referral Tracking V1 ====================
//
// Trackpr's automation can only ever record a review/referral as
// 'requested' (the SMS sent) or 'failed' (it didn't) - see
// lib/reviews-referrals/tracking.ts's own documentation. Whether a review
// was actually left, or a referral actually turned into a customer, is
// something only the contractor can really know; these four actions are
// the sole, explicit, authenticated way that ever gets recorded - never
// inferred by AI or by any automated reply-classification. Every mutation
// here is scoped by organization_id from the authenticated session (never a
// client-supplied id) and additionally re-verified by review_requests_
// update/referral_requests_update's own RLS (is_org_member), the same
// double-layer pattern every other mutation in this codebase uses.

async function recordAudit(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  action: "review_marked_completed" | "review_marked_declined" | "referral_marked_converted" | "referral_marked_declined",
  entityType: "review_request" | "referral_request",
  entityId: string,
): Promise<void> {
  const { error } = await supabase.rpc("create_review_referral_audit_event", {
    p_organization_id: organizationId,
    p_action: action,
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_metadata: {},
  });
  if (error) {
    console.error("[jobs] failed to record review/referral audit log entry", { organizationId, action, entityId, error: error.message });
  }
}

async function transitionReviewRequest(jobId: string, toStatus: "completed" | "declined"): Promise<JobActionResult> {
  const { supabase, organizationId } = await requireOrganization();

  const { data, error } = await supabase
    .from("review_requests")
    .update({ status: toStatus, resolved_at: new Date().toISOString() })
    .eq("job_id", jobId)
    .eq("organization_id", organizationId)
    .in("status", ["requested", "responded"])
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: "We couldn't update this review." };
  if (!data) return { ok: false, error: "This review request could not be found or is not in an eligible state." };

  await recordAudit(supabase, organizationId, toStatus === "completed" ? "review_marked_completed" : "review_marked_declined", "review_request", data.id);

  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, id: data.id };
}

export async function markReviewCompleted(jobId: string): Promise<JobActionResult> {
  return transitionReviewRequest(jobId, "completed");
}

export async function markReviewDeclined(jobId: string): Promise<JobActionResult> {
  return transitionReviewRequest(jobId, "declined");
}

export async function markReferralDeclined(jobId: string): Promise<JobActionResult> {
  const { supabase, organizationId } = await requireOrganization();

  const { data, error } = await supabase
    .from("referral_requests")
    .update({ status: "declined", resolved_at: new Date().toISOString() })
    .eq("job_id", jobId)
    .eq("organization_id", organizationId)
    .in("status", ["requested", "responded"])
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: "We couldn't update this referral." };
  if (!data) return { ok: false, error: "This referral request could not be found or is not in an eligible state." };

  await recordAudit(supabase, organizationId, "referral_marked_declined", "referral_request", data.id);

  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, id: data.id };
}

/**
 * The V1 attribution structure (requirement: "clean V1 structure that can
 * later support customer -> referral -> referred lead -> converted job").
 * referredLeadId is optional - a contractor can mark a referral converted
 * even without linking a specific existing Trackpr lead (e.g. the referred
 * person hasn't been entered as a lead yet); when given, it must be a real
 * lead in this same organization (re-verified here, never trusted merely
 * because the form offered it as an option).
 */
export async function markReferralConverted(jobId: string, referredLeadId: string | null): Promise<JobActionResult> {
  const { supabase, organizationId } = await requireOrganization();

  if (referredLeadId) {
    const { data: lead } = await supabase.from("leads").select("id").eq("id", referredLeadId).eq("organization_id", organizationId).maybeSingle();
    if (!lead) return { ok: false, error: "That lead could not be found in this organization." };
  }

  const { data, error } = await supabase
    .from("referral_requests")
    .update({ status: "converted", resolved_at: new Date().toISOString(), referred_lead_id: referredLeadId })
    .eq("job_id", jobId)
    .eq("organization_id", organizationId)
    .in("status", ["requested", "responded"])
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: "We couldn't update this referral." };
  if (!data) return { ok: false, error: "This referral request could not be found or is not in an eligible state." };

  await recordAudit(supabase, organizationId, "referral_marked_converted", "referral_request", data.id);

  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, id: data.id };
}
