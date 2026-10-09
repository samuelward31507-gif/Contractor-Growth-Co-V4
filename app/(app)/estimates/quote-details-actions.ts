"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getLineItemSubtotal, parseLineItemInput, parseQuoteText } from "@/lib/estimates/details";

/**
 * Editing what the customer reads on the quote: its line items, scope of
 * work and terms (supabase/pending/estimate_quote_details.sql).
 *
 * Draft-only, exactly like updateEstimate: once a quote is sent, the
 * customer is responding to it, so it can never change underneath them.
 * Every action checks the estimate is a draft of the caller's organization
 * first (for a clear message); RLS and the line-item guard trigger enforce
 * the same rules in the database regardless.
 *
 * After any line-item change the estimate's amount is set to the line-item
 * subtotal, so the total the customer approves is always the itemized sum.
 */

export type QuoteDetailsResult = { ok: true } | { ok: false; error: string };

type LineItemFields = { description: string; quantity: string; unit: string; unitPrice: string };

async function requireOrganization() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) redirect("/onboarding");
  return { supabase, organizationId: membership.organizationId };
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function requireDraft(supabase: Supabase, organizationId: string, estimateId: string): Promise<QuoteDetailsResult> {
  if (!estimateId) return { ok: false, error: "Missing estimate." };
  const { data, error } = await supabase.from("estimates").select("id, status").eq("id", estimateId).eq("organization_id", organizationId).maybeSingle();
  if (error) return { ok: false, error: "We couldn't load this estimate." };
  if (!data) return { ok: false, error: "This estimate could not be found." };
  if (data.status !== "draft") return { ok: false, error: "This quote has been sent, so it can no longer be changed." };
  return { ok: true };
}

/** Keeps estimates.amount equal to the line-item subtotal (only while a draft). */
async function syncAmount(supabase: Supabase, organizationId: string, estimateId: string): Promise<void> {
  const subtotal = await getLineItemSubtotal(supabase, organizationId, estimateId);
  if (subtotal == null) return;
  await supabase.from("estimates").update({ amount: subtotal }).eq("id", estimateId).eq("organization_id", organizationId).eq("status", "draft");
}

function done(estimateId: string): QuoteDetailsResult {
  revalidatePath("/money");
  revalidatePath(`/estimates/${estimateId}`);
  return { ok: true };
}

export async function addEstimateLineItem(estimateId: string, fields: LineItemFields): Promise<QuoteDetailsResult> {
  const parsed = parseLineItemInput(fields);
  if (!parsed.ok) return parsed;
  const { supabase, organizationId } = await requireOrganization();
  const draft = await requireDraft(supabase, organizationId, estimateId);
  if (!draft.ok) return draft;

  const { data: last } = await supabase
    .from("estimate_line_items")
    .select("position")
    .eq("estimate_id", estimateId)
    .eq("organization_id", organizationId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from("estimate_line_items").insert({
    organization_id: organizationId,
    estimate_id: estimateId,
    position: last ? Number(last.position) + 1 : 0,
    description: parsed.value.description,
    quantity: parsed.value.quantity,
    unit: parsed.value.unit,
    unit_price: parsed.value.unitPrice,
  });
  if (error) return { ok: false, error: "We couldn't add this line item." };

  await syncAmount(supabase, organizationId, estimateId);
  return done(estimateId);
}

export async function updateEstimateLineItem(estimateId: string, itemId: string, fields: LineItemFields): Promise<QuoteDetailsResult> {
  const parsed = parseLineItemInput(fields);
  if (!parsed.ok) return parsed;
  const { supabase, organizationId } = await requireOrganization();
  const draft = await requireDraft(supabase, organizationId, estimateId);
  if (!draft.ok) return draft;

  const { data, error } = await supabase
    .from("estimate_line_items")
    .update({ description: parsed.value.description, quantity: parsed.value.quantity, unit: parsed.value.unit, unit_price: parsed.value.unitPrice })
    .eq("id", itemId)
    .eq("estimate_id", estimateId)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: "We couldn't save this line item." };
  if (!data) return { ok: false, error: "This line item could not be found." };

  await syncAmount(supabase, organizationId, estimateId);
  return done(estimateId);
}

export async function removeEstimateLineItem(estimateId: string, itemId: string): Promise<QuoteDetailsResult> {
  const { supabase, organizationId } = await requireOrganization();
  const draft = await requireDraft(supabase, organizationId, estimateId);
  if (!draft.ok) return draft;

  const { data, error } = await supabase
    .from("estimate_line_items")
    .delete()
    .eq("id", itemId)
    .eq("estimate_id", estimateId)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: "We couldn't remove this line item." };
  if (!data) return { ok: false, error: "This line item could not be found." };

  // Removing the last item leaves the amount as it was - the contractor can
  // still set a single total with Edit Estimate.
  await syncAmount(supabase, organizationId, estimateId);
  return done(estimateId);
}

export async function saveEstimateQuoteText(estimateId: string, fields: { scopeOfWork: string; terms: string }): Promise<QuoteDetailsResult> {
  const scope = parseQuoteText(fields.scopeOfWork, "scope of work");
  if (!scope.ok) return scope;
  const terms = parseQuoteText(fields.terms, "terms");
  if (!terms.ok) return terms;

  const { supabase, organizationId } = await requireOrganization();
  const draft = await requireDraft(supabase, organizationId, estimateId);
  if (!draft.ok) return draft;

  const { data, error } = await supabase
    .from("estimates")
    .update({ scope_of_work: scope.value, terms: terms.value })
    .eq("id", estimateId)
    .eq("organization_id", organizationId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: "We couldn't save the scope and terms." };
  if (!data) return { ok: false, error: "This quote has been sent, so it can no longer be changed." };

  return done(estimateId);
}
