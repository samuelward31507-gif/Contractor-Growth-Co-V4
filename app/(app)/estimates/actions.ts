"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { emitEstimateSent, emitEstimateLifecycleEvent } from "@/lib/automation/estimates";
import { deliverEstimateToCustomer, describeEstimateDelivery, type EstimateDeliverySummary } from "@/lib/automation/estimate-delivery";
import { resolveCustomerLinkBaseUrl } from "@/lib/estimates/approval-link";
import { emitJobCreatedFromEstimate } from "@/lib/automation/jobs";
import { findRecentDuplicateEstimate } from "@/lib/estimates/duplicate-guard";
import { getJobByEstimateId } from "@/lib/jobs/queries";
import { getLineItemSubtotal } from "@/lib/estimates/details";

export type EstimateActionResult = { ok: true; id?: string } | { ok: false; error: string };

/**
 * Final Batch 3: sending an estimate is two facts, reported separately and
 * truthfully - the estimate became 'sent' (its approval link is live), and
 * whether the customer was actually texted. `delivery.texted` is true only
 * when the provider accepted the text; any block, skip or provider failure
 * says so in `delivery.message` - never a blanket "sent".
 */
export type EstimateSendResult = { ok: true; id: string; delivery: EstimateDeliverySummary } | { ok: false; error: string };

export type EstimateFormState = {
  error?: string;
  success?: boolean;
  id?: string;
};

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

async function verifyContactInOrganization(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  return Boolean(data);
}

type ParsedEstimateForm =
  | { input: { contactId: string; leadId: string | null; title: string; amount: number | null; notes: string | null; expiresAt: string | null }; error?: undefined }
  | { input?: undefined; error: string };

function parseEstimateForm(formData: FormData): ParsedEstimateForm {
  const contactId = String(formData.get("contactId") ?? "").trim();
  const leadId = String(formData.get("leadId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  const expiresAtRaw = String(formData.get("expiresAt") ?? "").trim();

  if (!contactId) return { error: "Select a contact for this estimate." };
  if (!title) return { error: "Enter a title for this estimate." };

  let amount: number | null = null;
  if (amountRaw) {
    const parsed = Number(amountRaw);
    if (!Number.isFinite(parsed)) return { error: "Enter a valid amount." };
    if (parsed < 0) return { error: "Amount cannot be negative." };
    amount = parsed;
  }

  // <input type="date"> submits YYYY-MM-DD; stored as an end-of-day UTC
  // instant so "expires" reads naturally as "through this date" regardless
  // of the viewer's timezone, matching how expires_at is only ever compared
  // to `now()` (never rendered with a time component).
  let expiresAt: string | null = null;
  if (expiresAtRaw) {
    const parsed = new Date(`${expiresAtRaw}T23:59:59.999Z`);
    if (Number.isNaN(parsed.getTime())) return { error: "Enter a valid expiration date." };
    expiresAt = parsed.toISOString();
  }

  return {
    input: {
      contactId,
      leadId: leadId || null,
      title,
      amount,
      notes: notes || null,
      expiresAt,
    },
  };
}

export async function createEstimate(_prevState: EstimateFormState, formData: FormData): Promise<EstimateFormState> {
  const { input, error } = parseEstimateForm(formData);
  if (error || !input) return { error: error ?? "Enter estimate details." };

  const { supabase, organizationId } = await requireOrganization();

  const contactValid = await verifyContactInOrganization(supabase, organizationId, input.contactId);
  if (!contactValid) return { error: "Select a valid contact." };

  // A repeated submission of the same form resolves to the draft it already
  // created rather than a second identical estimate (see duplicate-guard.ts).
  const duplicateId = await findRecentDuplicateEstimate(supabase, organizationId, input);
  if (duplicateId) {
    revalidatePath("/money");
    return { success: true, id: duplicateId };
  }

  const { data, error: insertError } = await supabase
    .from("estimates")
    .insert({
      organization_id: organizationId,
      contact_id: input.contactId,
      lead_id: input.leadId,
      title: input.title,
      amount: input.amount,
      notes: input.notes,
      expires_at: input.expiresAt,
      status: "draft",
    })
    .select("id")
    .single();

  if (insertError || !data) return { error: "We couldn't create this estimate. Please try again." };

  revalidatePath("/money");
  return { success: true, id: data.id };
}

/**
 * Draft-only edit. Once an estimate has been sent, its terms are what the
 * customer is responding to - editing it in place would silently change
 * what "accept"/"decline" refers to, so this is scoped to 'draft' the same
 * way sendEstimate is scoped to originate from 'draft'.
 */
export async function updateEstimate(_prevState: EstimateFormState, formData: FormData): Promise<EstimateFormState> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing estimate." };

  const { input, error } = parseEstimateForm(formData);
  if (error || !input) return { error: error ?? "Enter estimate details." };

  const { supabase, organizationId } = await requireOrganization();

  const contactValid = await verifyContactInOrganization(supabase, organizationId, input.contactId);
  if (!contactValid) return { error: "Select a valid contact." };

  // An itemized quote's total is its line-item subtotal - the amount field
  // can't set a different figure than the items the customer will read.
  const lineItemSubtotal = await getLineItemSubtotal(supabase, organizationId, id);

  const { data, error: updateError } = await supabase
    .from("estimates")
    .update({
      contact_id: input.contactId,
      lead_id: input.leadId,
      title: input.title,
      amount: lineItemSubtotal ?? input.amount,
      notes: input.notes,
      expires_at: input.expiresAt,
    })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();

  if (updateError) return { error: "We couldn't update this estimate." };
  if (!data) return { error: "This estimate could not be found or is no longer a draft." };

  revalidatePath("/money");
  revalidatePath(`/estimates/${id}`);
  return { success: true, id: data.id };
}

/**
 * The moment an estimate "becomes sent" in this application - transitions
 * draft -> sent, stamps sent_at (the timestamp every follow-up timing
 * calculation is anchored to), and triggers emitEstimateSent(). Only valid
 * from 'draft' - re-sending an already-sent estimate is a no-op, not a
 * second automation event (idempotency lives at the automation-event layer
 * too, but guarding the state transition itself here is cheap and correct).
 */
export async function sendEstimate(estimateId: string): Promise<EstimateSendResult> {
  const { supabase, organizationId } = await requireOrganization();

  // An itemized quote goes out with its total equal to the line-item
  // subtotal, in the same write that sends it.
  const lineItemSubtotal = await getLineItemSubtotal(supabase, organizationId, estimateId);

  const { data, error } = await supabase
    .from("estimates")
    .update({ status: "sent", sent_at: new Date().toISOString(), ...(lineItemSubtotal != null ? { amount: lineItemSubtotal } : {}) })
    .eq("id", estimateId)
    .eq("organization_id", organizationId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: "We couldn't send this estimate." };
  if (!data) return { ok: false, error: "This estimate could not be found or has already been sent." };

  await emitEstimateSent(supabase, estimateId);
  // Delivers the real approval link to the customer (gated like every other
  // automated send) - sending an estimate no longer depends on the
  // contractor copying the link out of the page.
  //
  // Final Batch 3: the delivery outcome is no longer discarded - the caller is
  // told whether the customer was actually texted (see EstimateSendResult).
  // The estimate stays 'sent' either way: its approval link is live and can
  // be shared by hand, and the delivery event is idempotent per estimate, so
  // reverting to draft could never re-text it.
  const outcome = await deliverEstimateToCustomer(supabase, estimateId, resolveCustomerLinkBaseUrl((await headers()).get("host")));

  revalidatePath("/money");
  revalidatePath(`/estimates/${estimateId}`);
  return { ok: true, id: data.id, delivery: describeEstimateDelivery(outcome) };
}

/**
 * Final Batch 3: the next action for an accepted estimate with no job. Reuses
 * the one existing estimate -> job path (emitJobCreatedFromEstimate: same
 * insert, idempotent on estimate_id, lead -> won, job.created kickoff) that
 * acceptance itself runs - for the case where that side effect never landed.
 * Only for an accepted estimate of the caller's organization; never a second
 * job (an existing one is returned instead).
 */
export async function createJobFromAcceptedEstimate(estimateId: string): Promise<EstimateActionResult> {
  const { supabase, organizationId } = await requireOrganization();

  const { data: estimate, error } = await supabase.from("estimates").select("id, status").eq("id", estimateId).eq("organization_id", organizationId).maybeSingle();
  if (error) return { ok: false, error: "We couldn't load this estimate." };
  if (!estimate) return { ok: false, error: "This estimate could not be found." };
  if (estimate.status !== "accepted") return { ok: false, error: "Only an accepted estimate can become a job." };

  const existing = await getJobByEstimateId(supabase, organizationId, estimateId);
  if (existing) return { ok: true, id: existing.id };

  await emitJobCreatedFromEstimate(supabase, organizationId, estimateId);
  const created = await getJobByEstimateId(supabase, organizationId, estimateId);
  if (!created) return { ok: false, error: "We couldn't create the job. Please try again." };

  revalidatePath("/money");
  revalidatePath("/jobs");
  revalidatePath(`/estimates/${estimateId}`);
  return { ok: true, id: created.id };
}

async function transitionEstimate(
  estimateId: string,
  toStatus: "accepted" | "declined" | "cancelled",
  fromStatuses: string[],
): Promise<EstimateActionResult> {
  const { supabase, organizationId } = await requireOrganization();

  const patch: Record<string, unknown> = { status: toStatus };
  if (toStatus === "accepted" || toStatus === "declined") {
    patch.responded_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("estimates")
    .update(patch)
    .eq("id", estimateId)
    .eq("organization_id", organizationId)
    .in("status", fromStatuses)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: "We couldn't update this estimate." };
  if (!data) return { ok: false, error: "This estimate could not be found or is not in an eligible state." };

  if (toStatus === "accepted") {
    await emitEstimateLifecycleEvent(supabase, estimateId, "estimate.accepted");
    // Phase 4.6: estimate accepted is the sole job-creation trigger, per
    // explicit decision. Idempotent - see emitJobCreatedFromEstimate.
    await emitJobCreatedFromEstimate(supabase, organizationId, estimateId);
    revalidatePath("/money");
  } else if (toStatus === "declined") {
    await emitEstimateLifecycleEvent(supabase, estimateId, "estimate.declined");
  }
  // cancelled: no dedicated automation event (not in the Phase 4.5 Events
  // list) - leaving 'sent' is what blocks future follow-ups.

  revalidatePath("/money");
  revalidatePath(`/estimates/${estimateId}`);
  return { ok: true, id: data.id };
}

export async function markEstimateAccepted(estimateId: string): Promise<EstimateActionResult> {
  return transitionEstimate(estimateId, "accepted", ["sent"]);
}

export async function markEstimateDeclined(estimateId: string): Promise<EstimateActionResult> {
  return transitionEstimate(estimateId, "declined", ["sent"]);
}

export async function cancelEstimate(estimateId: string): Promise<EstimateActionResult> {
  return transitionEstimate(estimateId, "cancelled", ["draft", "sent"]);
}
