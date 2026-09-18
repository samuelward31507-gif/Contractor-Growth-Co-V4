"use server";

import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { emitJobLifecycleEvent } from "@/lib/automation/jobs";
import { emitPostJobFollowup } from "@/lib/automation/post-job-followup";

/**
 * Backend-only job status transitions for Phase 4.6. There is no Jobs UI
 * yet (app/(app)/jobs/page.tsx is still the pre-existing placeholder,
 * deliberately left untouched). Jobs themselves are only ever created by
 * lib/automation/jobs.ts's emitJobCreatedFromEstimate() (estimate accepted
 * -> exactly one job, per explicit decision) - there is no createJob action
 * here, since manual job creation is out of scope this phase.
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

  return { ok: true, id: data.id };
}

export async function markJobCompleted(jobId: string): Promise<JobActionResult> {
  return transitionJob(jobId, "completed", ["scheduled", "in_progress"]);
}

export async function markJobCancelled(jobId: string): Promise<JobActionResult> {
  return transitionJob(jobId, "cancelled", ["scheduled", "in_progress"]);
}
