import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "./events";
import { startWorkflowExecutionAsService, failWorkflowExecutionAsService } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { getLead, type LeadStatus } from "@/lib/leads/queries";
import { getContact } from "@/lib/contacts/queries";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";

export const LEAD_REACTIVATION_WORKFLOW = "lead_reactivation_followup";

const TOUCH_1_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days since the last inbound customer message
const TOUCH_2_DELAY_MS = 21 * 24 * 60 * 60 * 1000; // 21 days since the last inbound customer message

// Only these statuses are reactivation candidates: 'appointment'/'estimate'
// already have their own dedicated follow-up automations (layering a
// generic inactivity message on top would be redundant/conflicting), and
// 'won'/'lost' are closed outcomes ('lost' already owned by Phase 4.8's
// nurture flow). See the Phase 4.9 audit report for the full reasoning.
const ELIGIBLE_LEAD_STATUSES: LeadStatus[] = ["new", "contacted", "qualified"];

const ACTIVE_APPOINTMENT_STATUSES = ["scheduled", "confirmed"];
const ACTIVE_ESTIMATE_STATUSES = ["sent", "accepted"];
const ACTIVE_JOB_STATUSES = ["scheduled", "in_progress"];

type CandidateLead = {
  id: string;
  organization_id: string;
  contact_id: string | null;
  service: string | null;
  source: string | null;
  ai_summary: string | null;
  status: string;
};

export type ReactivationOutcome =
  | { leadId: string; outcome: "dispatched"; occurrence: 1 | 2; executionId: string }
  | { leadId: string; outcome: "no_contact" }
  | { leadId: string; outcome: "no_open_conversation" }
  | { leadId: string; outcome: "no_inbound_history" }
  | { leadId: string; outcome: "not_due" }
  | { leadId: string; outcome: "skipped_duplicate" }
  | { leadId: string; outcome: "active_engagement" }
  | { leadId: string; outcome: "not_eligible_status" }
  | { leadId: string; outcome: "failed"; error: string };

export type ReactivationRunResult = {
  candidates: number;
  outcomes: ReactivationOutcome[];
};

/**
 * Finds leads that have gone genuinely inactive (no inbound customer
 * message for 7/21 days, measured live off messages.created_at, never off
 * leads.updated_at/contacts.updated_at/conversations.updated_at/outbound
 * timestamps - see the Phase 4.9 audit) and dispatches each eligible one to
 * n8n for AI drafting. Structurally mirrors processLeadNurture (Phase 4.8):
 * repeated-safe, idempotent, does not compose or send a message itself -
 * only ever recommends a send by dispatching to n8n; sendOutboundMessage()
 * is only ever reached later, from the n8n callback route, after
 * evaluateOutboundGate() has independently re-verified eligibility.
 *
 * Unlike lead.lost (a one-time, effectively irreversible status
 * transition), inactivity is a continuous, self-correcting condition: a
 * customer reply immediately un-inactivates the lead. There is deliberately
 * no separate lifecycle event and no frozen timing anchor - elapsed time is
 * recomputed fresh from the live last-inbound-message timestamp on every
 * call, so a reply between touch 1 and touch 2 naturally pushes touch 2's
 * eligibility back out to 21 days after that NEW reply, with no special
 * "cancel" logic required. Candidates are scanned directly from `leads`
 * (there is no prior lifecycle event to scan, unlike processLeadNurture).
 */
export async function processLeadReactivation(supabase: SupabaseClient, now: Date = new Date()): Promise<ReactivationRunResult> {
  const { data: rawCandidates } = await supabase
    .from("leads")
    .select("id, organization_id, contact_id, service, source, ai_summary, status")
    .in("status", ELIGIBLE_LEAD_STATUSES)
    .limit(500);

  const candidates = (rawCandidates ?? []) as CandidateLead[];
  const outcomes: ReactivationOutcome[] = [];

  for (const lead of candidates) {
    outcomes.push(await processOneLead(supabase, lead, now));
  }

  return { candidates: candidates.length, outcomes };
}

async function processOneLead(supabase: SupabaseClient, lead: CandidateLead, now: Date): Promise<ReactivationOutcome> {
  const leadId = lead.id;
  const organizationId = lead.organization_id;

  if (!lead.contact_id) {
    return { leadId, outcome: "no_contact" };
  }

  // Conversation resolution (requirement 6): an open SMS conversation must
  // already exist for this exact lead - never created here. A contact can
  // only ever have one open SMS conversation at a time (enforced by the
  // existing partial unique index), but that contact may have more than one
  // lead - if their single open SMS conversation is tied to a DIFFERENT
  // lead, this lead has no open SMS conversation of its own and must be
  // excluded, never sent through someone else's thread.
  const { data: openConversation } = await supabase
    .from("conversations")
    .select("id, lead_id")
    .eq("organization_id", organizationId)
    .eq("contact_id", lead.contact_id)
    .eq("channel", "sms")
    .eq("status", "open")
    .maybeSingle();

  if (!openConversation || openConversation.lead_id !== leadId) {
    return { leadId, outcome: "no_open_conversation" };
  }

  // Activity signal: MAX(messages.created_at) WHERE direction = 'inbound',
  // joined through ALL of this lead's conversations (any channel/status) -
  // not merely the single open SMS conversation just resolved above, per
  // the explicit requirement not to miss inbound activity that happened on
  // an earlier, now-closed conversation for the same lead.
  const { data: leadConversations } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId);

  const conversationIds = (leadConversations ?? []).map((row) => row.id as string);
  if (conversationIds.length === 0) {
    return { leadId, outcome: "no_inbound_history" };
  }

  const { data: lastInbound } = await supabase
    .from("messages")
    .select("created_at")
    .eq("organization_id", organizationId)
    .in("conversation_id", conversationIds)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastInbound) {
    return { leadId, outcome: "no_inbound_history" };
  }

  const elapsed = now.getTime() - new Date(lastInbound.created_at).getTime();

  // Touch 2 is independently gated on the SAME live signal, never on
  // "touch 1 already happened" - a customer reply after touch 1 resets
  // this elapsed value, which is what makes touch 2 correctly wait a fresh
  // 21 days from that new reply rather than firing on the original clock.
  let occurrence: 1 | 2 | null = null;
  if (elapsed >= TOUCH_2_DELAY_MS) {
    occurrence = 2;
  } else if (elapsed >= TOUCH_1_DELAY_MS) {
    occurrence = 1;
  }

  if (!occurrence) {
    return { leadId, outcome: "not_due" };
  }

  const idempotencyKey = `lead.reactivation:${leadId}:${occurrence}`;

  // Fast-path duplicate check (step 7) - an optimization only, so a
  // duplicate cron tick doesn't pay for the active-engagement/status
  // re-check queries below for a touch that's already been sent. The real,
  // race-proof guarantee against two concurrent cron ticks both creating
  // this touch remains createAutomationEventAsService's own idempotency-key
  // unique index below - no second idempotency system.
  const { data: existingEvent } = await supabase
    .from("automation_events")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingEvent) {
    return { leadId, outcome: "skipped_duplicate" };
  }

  // Defensive active-engagement check (step 8): leads.status is never
  // auto-synced when an appointment/estimate/job is created for this lead
  // (confirmed in the audit - no Server Action updates it), so status alone
  // cannot be trusted here.
  const [{ data: activeAppointment }, { data: activeEstimate }, { data: activeJob }] = await Promise.all([
    supabase
      .from("appointments")
      .select("id")
      .eq("lead_id", leadId)
      .eq("organization_id", organizationId)
      .in("status", ACTIVE_APPOINTMENT_STATUSES)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("estimates")
      .select("id")
      .eq("lead_id", leadId)
      .eq("organization_id", organizationId)
      .in("status", ACTIVE_ESTIMATE_STATUSES)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("jobs")
      .select("id")
      .eq("lead_id", leadId)
      .eq("organization_id", organizationId)
      .in("status", ACTIVE_JOB_STATUSES)
      .limit(1)
      .maybeSingle(),
  ]);

  if (activeAppointment || activeEstimate || activeJob) {
    return { leadId, outcome: "active_engagement" };
  }

  // Step 9: re-check the lead's live status immediately before dispatch -
  // everything above (conversation/message/engagement queries) takes time,
  // during which the lead could have been manually moved out of an eligible
  // status.
  const freshLead = await getLead(supabase, organizationId, leadId);
  if (!freshLead || !ELIGIBLE_LEAD_STATUSES.includes(freshLead.status)) {
    return { leadId, outcome: "not_eligible_status" };
  }

  const eventResult = await createAutomationEventAsService(supabase, organizationId, {
    eventType: "lead.reactivation",
    entityType: "lead",
    entityId: leadId,
    payload: { lead_id: leadId, contact_id: lead.contact_id, conversation_id: openConversation.id, occurrence },
    idempotencyKey,
  });

  if (!eventResult.ok) {
    return { leadId, outcome: "failed", error: eventResult.error };
  }
  if (eventResult.duplicate) {
    // Lost a race against another concurrent cron tick between the
    // fast-path check above and this insert - a clean, expected outcome,
    // not a failure.
    return { leadId, outcome: "skipped_duplicate" };
  }

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, LEAD_REACTIVATION_WORKFLOW);
  if (!executionResult.ok) {
    return { leadId, outcome: "failed", error: executionResult.error };
  }

  const executionId = executionResult.execution.id;

  const [aiSettings, businessProfile, contact] = await Promise.all([
    getAiSettings(supabase, organizationId),
    getBusinessProfile(supabase, organizationId),
    getContact(supabase, organizationId, lead.contact_id),
  ]);

  // Only real, stored facts are ever passed into the contract - service,
  // source, and the lead's own prior AI summary (if any). No prior
  // conversation transcript, no pricing, no availability - the n8n prompt
  // is instructed never to invent anything beyond what's given here.
  const contract: N8nWorkflowContract = {
    version: 1,
    event: {
      id: eventResult.event.id,
      type: "lead.reactivation",
      organization_id: organizationId,
      entity_type: "lead",
      entity_id: leadId,
      payload: {
        lead_id: leadId,
        contact_id: lead.contact_id,
        conversation_id: openConversation.id,
        service: lead.service,
        source: lead.source,
        ai_summary: lead.ai_summary,
        status: freshLead.status,
        occurrence,
      },
    },
    execution: {
      id: executionId,
      workflow_name: LEAD_REACTIVATION_WORKFLOW,
      attempt: executionResult.execution.attempt,
    },
    context: {
      organization: {
        id: organizationId,
        name: businessProfile?.name ?? "",
        timezone: businessProfile?.timezone ?? "UTC",
      },
      ai: {
        enabled: aiSettings.ai_enabled,
        tone: aiSettings.tone,
        business_introduction: aiSettings.business_introduction,
        general_instructions: aiSettings.general_instructions,
      },
      contact: contact
        ? {
            id: contact.id,
            first_name: contact.first_name,
            last_name: contact.last_name,
            phone: contact.phone,
            email: contact.email,
          }
        : null,
    },
  };

  after(async () => {
    const dispatch = await triggerN8nWorkflow(contract);
    if (!dispatch.ok) {
      const failed = await failWorkflowExecutionAsService(supabase, executionId, dispatch.error);
      if (!failed.ok) {
        console.error("[automation] failed to record lead.reactivation dispatch failure", {
          executionId,
          dispatchError: dispatch.error,
          recordError: failed.error,
        });
      }
    }
  });

  return { leadId, outcome: "dispatched", occurrence, executionId };
}
