"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { emitEstimateSent, emitEstimateLifecycleEvent } from "@/lib/automation/estimates";
import { emitJobCreatedFromEstimate } from "@/lib/automation/jobs";

export type EstimateActionResult = { ok: true; id?: string } | { ok: false; error: string };

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

  revalidatePath("/estimates");
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

  const { data, error: updateError } = await supabase
    .from("estimates")
    .update({
      contact_id: input.contactId,
      lead_id: input.leadId,
      title: input.title,
      amount: input.amount,
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

  revalidatePath("/estimates");
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
export async function sendEstimate(estimateId: string): Promise<EstimateActionResult> {
  const { supabase, organizationId } = await requireOrganization();

  const { data, error } = await supabase
    .from("estimates")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", estimateId)
    .eq("organization_id", organizationId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: "We couldn't send this estimate." };
  if (!data) return { ok: false, error: "This estimate could not be found or has already been sent." };

  await emitEstimateSent(supabase, estimateId);

  revalidatePath("/estimates");
  revalidatePath(`/estimates/${estimateId}`);
  return { ok: true, id: data.id };
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
    revalidatePath("/jobs");
  } else if (toStatus === "declined") {
    await emitEstimateLifecycleEvent(supabase, estimateId, "estimate.declined");
  }
  // cancelled: no dedicated automation event (not in the Phase 4.5 Events
  // list) - leaving 'sent' is what blocks future follow-ups.

  revalidatePath("/estimates");
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
