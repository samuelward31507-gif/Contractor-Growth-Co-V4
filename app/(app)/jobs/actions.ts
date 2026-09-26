"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { emitJobLifecycleEvent, emitJobCreatedEvent } from "@/lib/automation/jobs";
import { emitPostJobFollowup } from "@/lib/automation/post-job-followup";
import { resolveOrCreateContact } from "@/lib/contacts/resolve";
import { emitLeadCreatedFollowup } from "@/lib/automation/lead-followup";
import { emitLeadStageChanged } from "@/lib/automation/lead-stage-history";
import { getJob } from "@/lib/jobs/queries";

/**
 * Job status transitions, plus (Growth System Completion Pass 1) direct job
 * creation. Estimate acceptance -> exactly one job
 * (lib/automation/jobs.ts's emitJobCreatedFromEstimate) remains completely
 * unchanged and is still the ONLY path that can create a job FROM an
 * estimate. createJob below is a second, independent entry point for a job
 * with no originating estimate at all - both paths share the same
 * job.created event/kickoff dispatch (emitJobCreatedEvent), so lifecycle
 * automation behaves identically regardless of how the job was created.
 */

export type JobActionResult = { ok: true; id?: string } | { ok: false; error: string };

export type CreateJobFormState = { error?: string; success?: boolean; id?: string };

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

  return { supabase, organizationId: membership.organizationId, userId: user.id };
}

async function verifyContactInOrganization(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const { data } = await supabase.from("contacts").select("id").eq("id", contactId).eq("organization_id", organizationId).maybeSingle();
  return Boolean(data);
}

/**
 * Confirms the selected lead belongs to the caller's organization AND is
 * associated with the same contact chosen for this job - mirrors
 * app/(app)/appointments/actions.ts's verifyLeadForContact exactly, the same
 * real security check (never trusting client-side filtering for this
 * relationship).
 */
async function verifyLeadForContact(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  leadId: string,
  contactId: string,
): Promise<boolean> {
  const { data } = await supabase.from("leads").select("id, contact_id").eq("id", leadId).eq("organization_id", organizationId).maybeSingle();
  if (!data) return false;
  return data.contact_id === contactId;
}

/**
 * Growth System Completion Pass 1: the smallest clean way for a contractor
 * to create a job with no originating estimate (e.g. work agreed on the
 * phone, or booked directly with a customer). Uses the caller's own
 * session-scoped client throughout - exactly like every other Server Action
 * in this codebase - so RLS's existing is_org_member policy and the
 * payment-gate RESTRICTIVE policy both apply automatically; no separate
 * payment/RLS check is written here because none is needed. Organization id
 * is always resolved server-side via requireOrganization(), never trusted
 * from the form. Reuses the existing `jobs` schema and JobStatus values
 * unchanged, and dispatches the same job.created event/kickoff notification
 * emitJobCreatedFromEstimate already uses (see emitJobCreatedEvent) -
 * "preserve lifecycle automation where appropriate."
 */
export async function createJob(_prevState: CreateJobFormState, formData: FormData): Promise<CreateJobFormState> {
  const { supabase, organizationId } = await requireOrganization();

  const contactId = String(formData.get("contactId") ?? "").trim();
  const leadId = String(formData.get("leadId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();

  if (!contactId) return { error: "Select a contact for this job." };
  if (!title) return { error: "Enter a title for this job." };

  const contactValid = await verifyContactInOrganization(supabase, organizationId, contactId);
  if (!contactValid) return { error: "Select a valid contact." };

  if (leadId) {
    const leadValid = await verifyLeadForContact(supabase, organizationId, leadId, contactId);
    if (!leadValid) return { error: "Select a valid lead for this contact." };
  }

  let amount: number | null = null;
  if (amountRaw) {
    const parsed = Number(amountRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: "Enter a valid job amount." };
    }
    amount = parsed;
  }

  const { data: created, error: insertError } = await supabase
    .from("jobs")
    .insert({
      organization_id: organizationId,
      contact_id: contactId,
      lead_id: leadId || null,
      estimate_id: null,
      title,
      amount,
      status: "scheduled",
      notes: notes || null,
    })
    .select("id")
    .single();

  if (insertError || !created) {
    return { error: "We couldn't create this job. Please try again." };
  }

  await emitJobCreatedEvent(supabase, organizationId, created.id, null);

  revalidatePath("/jobs");
  return { success: true, id: created.id };
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

/**
 * Growth System Completion Pass 2, Part 8: unlike markReferralConverted
 * above (which only ever LINKS an already-existing lead), this is the one
 * path that actually creates a brand-new lead for a referred person - for
 * the common case where the contractor has a name/phone for who was
 * referred but hasn't entered them into Trackpr yet. Reuses the exact same
 * primitives app/(app)/leads/actions.ts's createLead already uses
 * (resolveOrCreateContact for the referred person - never a raw insert, so
 * no duplicate contact; emitLeadStageChanged + emitLeadCreatedFollowup for
 * the identical lead.created/lead.stage_changed lifecycle every other lead
 * source triggers - no parallel lead system), then folds the result back
 * into referral_requests exactly like markReferralConverted does, so
 * attribution (which customer referred which lead) is preserved in the
 * same single place it already lived.
 *
 * Guarded the same way markReferralConverted is guarded (status must still
 * be requested/responded), plus `.is("referred_lead_id", null)` so a
 * referral already converted - by either action - can never be converted a
 * second time, which is also what prevents a duplicate lead for the same
 * referral on a retried/double-clicked submission.
 */
export type CreateLeadFromReferralInput = {
  firstName: string;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  service?: string | null;
};

export async function createLeadFromReferral(jobId: string, input: CreateLeadFromReferralInput): Promise<JobActionResult> {
  const { supabase, organizationId, userId } = await requireOrganization();
  return createLeadFromReferralForOrganization(supabase, organizationId, userId, jobId, input);
}

/**
 * The testable core of createLeadFromReferral, split out from the Server
 * Action wrapper above purely so it can be called directly in a Node test
 * with a real, already-signed-in session client - requireOrganization()
 * itself calls next/headers's cookies() via lib/supabase/server's
 * createClient(), which (like every other cookie-based Server Action in
 * this codebase - see app/(app)/leads/actions.ts's createLead) has no real
 * request scope outside an actual Next.js request, so it can never be
 * exercised directly in a plain Node test. This function takes the exact
 * same already-resolved {supabase, organizationId, userId} shape
 * requireOrganization() would have produced, so behavior is identical
 * either way - the wrapper adds nothing but that resolution.
 */
export async function createLeadFromReferralForOrganization(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  userId: string,
  jobId: string,
  input: CreateLeadFromReferralInput,
): Promise<JobActionResult> {
  const firstName = input.firstName.trim();
  if (!firstName) return { ok: false, error: "Enter the referred person's name." };
  const phone = input.phone?.trim() || null;
  const email = input.email?.trim() || null;
  if (!phone && !email) return { ok: false, error: "Enter a phone number or email for the referred person." };

  const { data: referral } = await supabase
    .from("referral_requests")
    .select("id, referred_lead_id, status")
    .eq("job_id", jobId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!referral) return { ok: false, error: "This job has no referral request to convert." };
  if (referral.referred_lead_id) return { ok: false, error: "This referral has already been converted to a lead." };
  if (referral.status !== "requested" && referral.status !== "responded") {
    return { ok: false, error: "This referral request is not in an eligible state." };
  }

  // Trackpr 2.0, Phase 4C (P2 #3): claim the referral BEFORE creating a
  // contact or lead, using the exact same atomic conditional-update
  // primitive this function already relied on (only reordered, and split
  // into two updates since the real lead id doesn't exist yet at claim
  // time). Two concurrent calls for the same referral can both pass the
  // plain read above, but only one can win this atomic update (status must
  // still be requested/responded AND referred_lead_id must still be null) -
  // the loser fails here, before ever creating a contact or lead, which is
  // what actually closes the duplicate-lead race the previous ordering left
  // open (it used to create the lead first, so a losing concurrent call
  // still left behind a real, unattributed lead).
  const { data: claimedReferral, error: claimError } = await supabase
    .from("referral_requests")
    .update({ status: "converted", resolved_at: new Date().toISOString() })
    .eq("id", referral.id)
    .eq("organization_id", organizationId)
    .in("status", ["requested", "responded"])
    .is("referred_lead_id", null)
    .select("id")
    .maybeSingle();

  if (claimError || !claimedReferral) {
    return { ok: false, error: "This referral has already been converted to a lead." };
  }

  /** Reverts the claim above back to the referral's real, original status - used whenever this call fails AFTER claiming but BEFORE a lead actually exists, so the referral remains a normal, retriable referral rather than a permanently broken "converted with no lead" row. */
  async function releaseClaim() {
    await supabase.from("referral_requests").update({ status: referral!.status, resolved_at: null }).eq("id", referral!.id).eq("organization_id", organizationId);
  }

  const contactResult = await resolveOrCreateContact(supabase, {
    organizationId,
    firstName,
    lastName: input.lastName?.trim() || null,
    phone,
    email,
  });

  if (contactResult.outcome === "error") {
    await releaseClaim();
    return { ok: false, error: contactResult.error };
  }
  if (contactResult.outcome === "conflict") {
    await releaseClaim();
    return { ok: false, error: "This phone and email belong to two different existing contacts. Resolve the conflict first." };
  }
  const contact = contactResult.contact;

  // The referring job's own title is a real, known fact about what prompted
  // this referral - a reasonable default for the referred lead's service
  // interest when the contractor doesn't specify one, never a fabricated
  // generic value.
  const originatingJob = await getJob(supabase, organizationId, jobId);
  const service = input.service?.trim() || originatingJob?.title || "Referral";

  const { data: lead, error: insertError } = await supabase
    .from("leads")
    .insert({ organization_id: organizationId, contact_id: contact.id, source: "referral", service, status: "new", temperature: "warm" })
    .select("id")
    .single();

  if (insertError || !lead) {
    await releaseClaim();
    return { ok: false, error: "We couldn't create this lead." };
  }

  // The referral is already exclusively claimed by this call (the atomic
  // update above already won the race) - recording the real lead id here is
  // a plain update, not a second race to protect against.
  const { error: attributionError } = await supabase.from("referral_requests").update({ referred_lead_id: lead.id }).eq("id", referral.id).eq("organization_id", organizationId);

  if (attributionError) {
    // The referral is genuinely converted and a real lead now exists from
    // it - only the referred_lead_id pointer itself failed to persist. Never
    // rolled back here (unlike the earlier failures): reverting the status
    // now would make an already-real conversion look unconverted again.
    console.error("[jobs] referral attribution pointer failed to save after a successful claim + lead creation", { jobId, leadId: lead.id, error: attributionError.message });
  }

  await recordAudit(supabase, organizationId, "referral_marked_converted", "referral_request", referral.id);

  await emitLeadStageChanged(supabase, { leadId: lead.id, previousStatus: null, newStatus: "new", source: "manual", actorUserId: userId });

  await emitLeadCreatedFollowup(supabase, {
    leadId: lead.id,
    contactId: contact.id,
    organizationId,
    source: "referral",
    service,
    status: "new",
    temperature: "warm",
    estimatedValue: null,
  });

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/leads");
  revalidatePath("/dashboard");
  return { ok: true, id: lead.id };
}
