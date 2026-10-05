import type { SupabaseClient } from "@supabase/supabase-js";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { createAutomationEventAsService } from "@/lib/automation/events";
import { startWorkflowExecutionAsService, completeWorkflowExecutionAsService } from "@/lib/automation/executions";
import { OPEN_LEAD_STATUSES, type LeadStatus, type LeadTemperature } from "./queries";

/**
 * P0 A1: deterministic lead attribution for AUTOMATED intake (web form,
 * referral, missed call, inbound SMS).
 *
 * A conversation is the customer's SMS thread (one open SMS conversation per
 * contact); a lead is a commercial opportunity, and a contact can have many
 * over time. conversations.lead_id is only the thread's CURRENT
 * opportunity - never historical truth (the messages are the history).
 *
 * The rule, for one automated intake:
 *   - the contact has an open lead  -> reuse it (no duplicate parallel open
 *     lead); the conversation's own open lead is preferred, otherwise the
 *     newest open lead;
 *   - the contact has no open lead (none at all, or only closed ones) ->
 *     create one new lead; closed leads stay untouched.
 * Then the contact's open SMS conversation is found/created and its pointer
 * moved to that lead when it is empty or points at a lead that is no longer
 * this contact's open opportunity. A pointer already on an open lead of
 * this contact is never moved.
 *
 * Safe to call repeatedly: once a lead exists it is open, so a repeat call
 * reuses it. Manual contractor-created leads never go through here - a
 * contractor may deliberately create a second open lead.
 */
export type LeadIntakeInput = {
  organizationId: string;
  contactId: string;
  /** leads.source for a newly created lead - each path keeps its existing value. */
  source: string;
  service?: string | null;
  temperature?: LeadTemperature;
};

export type LeadIntakeResult =
  | { ok: true; leadId: string; created: boolean; conversationId: string | null; previousConversationLeadId: string | null }
  | { ok: false; error: string };

type LeadRow = { id: string; contact_id: string | null; status: LeadStatus };

const isOpenLeadOf = (lead: LeadRow | null, contactId: string): lead is LeadRow => !!lead && lead.contact_id === contactId && OPEN_LEAD_STATUSES.has(lead.status);

export async function resolveLeadForIntake(supabase: SupabaseClient, input: LeadIntakeInput): Promise<LeadIntakeResult> {
  const { organizationId, contactId } = input;

  const { data: existingConversation } = await supabase
    .from("conversations")
    .select("id, lead_id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("channel", "sms")
    .eq("status", "open")
    .maybeSingle();
  const pointerLeadId = (existingConversation?.lead_id as string | null | undefined) ?? null;

  let pointerLead: LeadRow | null = null;
  if (pointerLeadId) {
    const { data } = await supabase
      .from("leads")
      .select("id, contact_id, status")
      .eq("id", pointerLeadId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    pointerLead = (data as LeadRow | null) ?? null;
  }

  let leadId: string | null = isOpenLeadOf(pointerLead, contactId) ? pointerLead.id : null;
  let created = false;

  if (!leadId) {
    const { data: newestOpen } = await supabase
      .from("leads")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .in("status", [...OPEN_LEAD_STATUSES])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    leadId = (newestOpen?.id as string | undefined) ?? null;
  }

  if (!leadId) {
    const { data: newLead, error } = await supabase
      .from("leads")
      .insert({
        organization_id: organizationId,
        contact_id: contactId,
        source: input.source,
        service: input.service ?? null,
        status: "new",
        temperature: input.temperature ?? "cold",
      })
      .select("id")
      .single();
    if (error || !newLead) return { ok: false, error: error?.message ?? "Could not create lead." };
    leadId = newLead.id as string;
    created = true;
  }

  const conversation = existingConversation ?? (await findOrCreateOpenConversation(supabase, organizationId, contactId, "sms", leadId));
  const conversationId = (conversation?.id as string | undefined) ?? null;

  // Move the pointer only when it is empty or stale. Conditional on the
  // value just read, so a concurrent intake that already moved it is never
  // overwritten.
  if (existingConversation && pointerLeadId !== leadId && !isOpenLeadOf(pointerLead, contactId)) {
    let update = supabase.from("conversations").update({ lead_id: leadId }).eq("id", existingConversation.id).eq("organization_id", organizationId);
    update = pointerLeadId ? update.eq("lead_id", pointerLeadId) : update.is("lead_id", null);
    const { error } = await update;
    if (error) console.error("[leads][intake] failed to move conversation lead pointer", { conversationId, leadId, error: error.message });
  }

  return { ok: true, leadId, created, conversationId, previousConversationLeadId: pointerLeadId };
}

/**
 * Records that another automated intake (e.g. a second web-form submission)
 * was attached to an EXISTING open lead instead of creating a duplicate one.
 * Same lifecycle-only event + execution shape as lead.stage_changed; the
 * idempotency key makes a redelivered intake a no-op.
 */
export async function recordLeadIntakeAsService(
  supabase: SupabaseClient,
  input: { organizationId: string; leadId: string; contactId: string; conversationId: string | null; source: string; idempotencyKey: string },
): Promise<void> {
  const eventResult = await createAutomationEventAsService(supabase, input.organizationId, {
    eventType: "lead.intake_received",
    entityType: "lead",
    entityId: input.leadId,
    payload: { lead_id: input.leadId, contact_id: input.contactId, conversation_id: input.conversationId, source: input.source, attached_to_existing_lead: true },
    idempotencyKey: input.idempotencyKey,
  });
  if (!eventResult.ok) {
    console.error("[leads][intake] failed to record lead.intake_received", { leadId: input.leadId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate || eventResult.skipped) return;

  const execution = await startWorkflowExecutionAsService(supabase, eventResult.event.id, "lead_intake_received_lifecycle");
  if (!execution.ok) {
    console.error("[leads][intake] failed to start lead.intake_received execution", { leadId: input.leadId, error: execution.error });
    return;
  }
  const completed = await completeWorkflowExecutionAsService(supabase, execution.execution.id, { lifecycle_only: true, lead_id: input.leadId, source: input.source });
  if (!completed.ok) console.error("[leads][intake] failed to complete lead.intake_received execution", { leadId: input.leadId, error: completed.error });
}

/** Whether an intake was already recorded for this lead since `sinceIso` (the web form's existing duplicate window). */
export async function hasRecentLeadIntake(supabase: SupabaseClient, organizationId: string, leadId: string, sinceIso: string): Promise<boolean> {
  const { data } = await supabase
    .from("automation_events")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("event_type", "lead.intake_received")
    .eq("entity_id", leadId)
    .gte("created_at", sinceIso)
    .limit(1)
    .maybeSingle();
  return !!data;
}
