"use server";

import { revalidatePath } from "next/cache";
import { getFounderContext, type FounderContext } from "@/lib/founder/access";
import { DEAL_STAGES, parseDealInput, parseItemInput, parseMrrInput, parseReviewInput, type DealStage } from "@/lib/founder/model";

/**
 * Founder Command Center writes. Each action re-resolves founder access
 * (never trusting that the page rendered for a founder), scopes every write
 * to the caller's own owner_id, and RLS enforces the same again. A missing
 * migration or a non-founder caller gets the same refusal.
 */

export type FounderActionResult = { ok: true; id?: string } | { ok: false; error: string };
type Fields = Record<string, unknown>;

const NOT_AVAILABLE: FounderActionResult = { ok: false, error: "The Founder Command Center isn't available for this account." };

async function founder(): Promise<FounderContext | null> {
  return getFounderContext();
}

function refresh() {
  revalidatePath("/founder", "layout");
}

async function dealBelongsToFounder(ctx: FounderContext, dealId: string | null): Promise<boolean> {
  if (!dealId) return true;
  const { data } = await ctx.supabase.from("founder_deals").select("id").eq("id", dealId).eq("owner_id", ctx.userId).maybeSingle();
  return Boolean(data);
}

// --- tasks and events --------------------------------------------------------

export async function createFounderItem(fields: Fields): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const parsed = parseItemInput(fields, ctx.timeZone);
  if (!parsed.ok) return parsed;
  if (!(await dealBelongsToFounder(ctx, parsed.value.dealId))) return { ok: false, error: "That deal could not be found." };
  const v = parsed.value;
  const { data, error } = await ctx.supabase
    .from("founder_items")
    .insert({ owner_id: ctx.userId, kind: v.kind, title: v.title, notes: v.notes, priority: v.priority, due_at: v.dueAt, starts_at: v.startsAt, ends_at: v.endsAt, deal_id: v.dealId })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "We couldn't save that. Please try again." };
  refresh();
  return { ok: true, id: data.id };
}

/** Quick capture: just a title, saved as an undated task to sort later. */
export async function quickCaptureFounderItem(title: string): Promise<FounderActionResult> {
  return createFounderItem({ kind: "task", title, priority: "medium" });
}

export async function updateFounderItem(id: string, fields: Fields): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const parsed = parseItemInput(fields, ctx.timeZone);
  if (!parsed.ok) return parsed;
  if (!(await dealBelongsToFounder(ctx, parsed.value.dealId))) return { ok: false, error: "That deal could not be found." };
  const v = parsed.value;
  const { data, error } = await ctx.supabase
    .from("founder_items")
    .update({ kind: v.kind, title: v.title, notes: v.notes, priority: v.priority, due_at: v.dueAt, starts_at: v.startsAt, ends_at: v.endsAt, deal_id: v.dealId })
    .eq("id", id)
    .eq("owner_id", ctx.userId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: "We couldn't save that. Please try again." };
  if (!data) return { ok: false, error: "That item could not be found." };
  refresh();
  return { ok: true, id: data.id };
}

export async function setFounderItemCompleted(id: string, completed: boolean): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  // Guarded on the current state, so a double-tap can't move the completion time.
  const query = ctx.supabase
    .from("founder_items")
    .update({ completed_at: completed ? new Date().toISOString() : null })
    .eq("id", id)
    .eq("owner_id", ctx.userId);
  const { data, error } = await (completed ? query.is("completed_at", null) : query.not("completed_at", "is", null)).select("id").maybeSingle();
  if (error) return { ok: false, error: "We couldn't update that item." };
  if (!data) {
    const { data: exists } = await ctx.supabase.from("founder_items").select("id").eq("id", id).eq("owner_id", ctx.userId).maybeSingle();
    if (!exists) return { ok: false, error: "That item could not be found." };
  }
  refresh();
  return { ok: true, id };
}

export async function deleteFounderItem(id: string): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const { data, error } = await ctx.supabase.from("founder_items").delete().eq("id", id).eq("owner_id", ctx.userId).select("id").maybeSingle();
  if (error) return { ok: false, error: "We couldn't delete that item." };
  if (!data) return { ok: false, error: "That item could not be found." };
  refresh();
  return { ok: true, id };
}

// --- deals ------------------------------------------------------------------------

function dealRow(v: ReturnType<typeof parseDealInput> & { ok: true }) {
  const d = v.value;
  return {
    name: d.name,
    contact_name: d.contactName,
    contact_email: d.contactEmail,
    stage: d.stage,
    expected_mrr: d.expectedMrr,
    next_action: d.nextAction,
    next_action_at: d.nextActionAt,
    won_amount: d.wonAmount,
    won_on: d.wonOn,
    lost_reason: d.lostReason,
    notes: d.notes,
  };
}

export async function createFounderDeal(fields: Fields): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const parsed = parseDealInput(fields, ctx.timeZone);
  if (!parsed.ok) return parsed;
  const { data, error } = await ctx.supabase.from("founder_deals").insert({ owner_id: ctx.userId, ...dealRow(parsed) }).select("id").single();
  if (error || !data) return { ok: false, error: "We couldn't save this deal. Please try again." };
  refresh();
  return { ok: true, id: data.id };
}

export async function updateFounderDeal(id: string, fields: Fields): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const parsed = parseDealInput(fields, ctx.timeZone);
  if (!parsed.ok) return parsed;
  const { data, error } = await ctx.supabase.from("founder_deals").update(dealRow(parsed)).eq("id", id).eq("owner_id", ctx.userId).select("id").maybeSingle();
  if (error) return { ok: false, error: "We couldn't save this deal. Please try again." };
  if (!data) return { ok: false, error: "That deal could not be found." };
  refresh();
  return { ok: true, id: data.id };
}

/**
 * Moves an open deal along the pipeline. Won needs an amount and a date, so
 * it goes through the edit form (updateFounderDeal), never a one-click move.
 */
export async function moveFounderDealStage(id: string, stage: string): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  if (!(DEAL_STAGES as readonly string[]).includes(stage) || stage === "won") return { ok: false, error: "Choose a valid stage. To mark a deal won, edit it and enter the amount and date." };
  const { data, error } = await ctx.supabase
    .from("founder_deals")
    .update({ stage: stage as DealStage, won_amount: null, won_on: null })
    .eq("id", id)
    .eq("owner_id", ctx.userId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: "We couldn't move this deal." };
  if (!data) return { ok: false, error: "That deal could not be found." };
  refresh();
  return { ok: true, id: data.id };
}

export async function deleteFounderDeal(id: string): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const { data, error } = await ctx.supabase.from("founder_deals").delete().eq("id", id).eq("owner_id", ctx.userId).select("id").maybeSingle();
  if (error) return { ok: false, error: "We couldn't delete this deal." };
  if (!data) return { ok: false, error: "That deal could not be found." };
  refresh();
  return { ok: true, id };
}

// --- MRR ----------------------------------------------------------------------------

export async function createFounderMrrEntry(fields: Fields): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const parsed = parseMrrInput(fields);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const { data, error } = await ctx.supabase
    .from("founder_mrr_entries")
    .insert({ owner_id: ctx.userId, month: v.month, kind: v.kind, amount: v.amount, is_forecast: v.isForecast, customer: v.customer, description: v.description, source: "manual" })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "We couldn't save this entry. Please try again." };
  refresh();
  return { ok: true, id: data.id };
}

export async function deleteFounderMrrEntry(id: string): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const { data, error } = await ctx.supabase.from("founder_mrr_entries").delete().eq("id", id).eq("owner_id", ctx.userId).select("id").maybeSingle();
  if (error) return { ok: false, error: "We couldn't delete this entry." };
  if (!data) return { ok: false, error: "That entry could not be found." };
  refresh();
  return { ok: true, id };
}

// --- daily review ----------------------------------------------------------------------

export async function saveFounderReview(fields: Fields): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const parsed = parseReviewInput(fields);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const { data, error } = await ctx.supabase
    .from("founder_reviews")
    .upsert(
      { owner_id: ctx.userId, review_date: v.reviewDate, wins: v.wins, blockers: v.blockers, priorities_next: v.prioritiesNext, notes: v.notes },
      { onConflict: "owner_id,review_date" },
    )
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "We couldn't save your review. Please try again." };
  refresh();
  return { ok: true, id: data.id };
}
