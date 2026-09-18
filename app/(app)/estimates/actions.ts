"use server";

import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { emitEstimateSent, emitEstimateLifecycleEvent } from "@/lib/automation/estimates";

/**
 * Backend-only estimate CRUD for Phase 4.5. There is no Estimates UI yet
 * (app/(app)/estimates/page.tsx is still the pre-existing placeholder,
 * deliberately left untouched) - these actions exist so the automation
 * layer has a real, callable "an estimate becomes sent/accepted/declined"
 * moment to hook into, exactly the way app/(app)/appointments/actions.ts
 * already did for appointments before this phase. A future UI phase wires
 * a form to these; nothing here assumes FormData because nothing calls it
 * that way yet.
 */

export type EstimateActionResult = { ok: true; id?: string } | { ok: false; error: string };

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

export type CreateEstimateInput = {
  contactId: string;
  leadId?: string | null;
  title: string;
  amount?: number | null;
  notes?: string | null;
  expiresAt?: string | null;
};

export async function createEstimate(input: CreateEstimateInput): Promise<EstimateActionResult> {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Enter a title for this estimate." };
  if (!input.contactId) return { ok: false, error: "Select a contact for this estimate." };

  const { supabase, organizationId } = await requireOrganization();

  const contactValid = await verifyContactInOrganization(supabase, organizationId, input.contactId);
  if (!contactValid) return { ok: false, error: "Select a valid contact." };

  const { data, error } = await supabase
    .from("estimates")
    .insert({
      organization_id: organizationId,
      contact_id: input.contactId,
      lead_id: input.leadId ?? null,
      title,
      amount: input.amount ?? null,
      notes: input.notes ?? null,
      expires_at: input.expiresAt ?? null,
      status: "draft",
    })
    .select("id")
    .single();

  if (error || !data) return { ok: false, error: "We couldn't create this estimate." };
  return { ok: true, id: data.id };
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
  } else if (toStatus === "declined") {
    await emitEstimateLifecycleEvent(supabase, estimateId, "estimate.declined");
  }
  // cancelled: no dedicated automation event (not in the Phase 4.5 Events
  // list) - leaving 'sent' is what blocks future follow-ups.

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
