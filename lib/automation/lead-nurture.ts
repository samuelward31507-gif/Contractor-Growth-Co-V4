import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "./events";
import { startWorkflowExecutionAsService, failWorkflowExecutionAsService } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { getAutomationEnabled } from "./settings";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getLead } from "@/lib/leads/queries";
import { getContact } from "@/lib/contacts/queries";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";

export const LEAD_LOST_NURTURE_WORKFLOW = "lead_lost_nurture_followup";

const TOUCH_1_DELAY_MS = 72 * 60 * 60 * 1000; // 72 hours after lead.lost
const TOUCH_2_DELAY_MS = 14 * 24 * 60 * 60 * 1000; // 14 days after lead.lost

type LostEventRow = {
  id: string;
  organization_id: string;
  entity_id: string;
  created_at: string;
};

export type NurtureOutcome =
  | { leadId: string; outcome: "dispatched"; occurrence: 1 | 2; executionId: string }
  | { leadId: string; outcome: "not_lost" }
  | { leadId: string; outcome: "not_due" }
  | { leadId: string; outcome: "skipped_duplicate" }
  | { leadId: string; outcome: "skipped_disabled" }
  | { leadId: string; outcome: "failed"; error: string };

export type NurtureRunResult = {
  candidates: number;
  outcomes: NurtureOutcome[];
};

/**
 * Finds leads that went lost (via the lead.lost lifecycle event) and are
 * due for a nurture touch, and dispatches each eligible one to n8n for AI
 * drafting. Mirrors the structural shape of processAppointmentReminders/
 * processEstimateFollowups (repeated-safe, org-scoped, idempotent scan
 * over `automation_events`), but does NOT compose or send a message
 * itself the way those two do - this only ever recommends a send by
 * dispatching to n8n; sendOutboundMessage() is only ever reached later,
 * from the n8n callback route, after evaluateOutboundGate() has
 * independently re-verified the lead is still 'lost' right then. Designed
 * to be called repeatedly on a schedule - every step is idempotent, so
 * calling this twice in the same window is always safe (requirements I/J).
 *
 * Uses each lead's own `lead.lost` automation_events row as the timing
 * anchor (its `created_at`) rather than any column on `leads` itself - see
 * lib/automation/lead-lost.ts for why leads.updated_at is unsafe to use
 * for this. At most one touch per lead per call: if both the 72-hour and
 * 14-day thresholds are already due (e.g. the cron was down for a while),
 * the more current one (touch 2) is preferred over dispatching a stale
 * first touch, mirroring the identical choice already made in
 * processEstimateFollowups.
 */
export async function processLeadNurture(supabase: SupabaseClient, now: Date = new Date()): Promise<NurtureRunResult> {
  const { data: lostEvents } = await supabase
    .from("automation_events")
    .select("id, organization_id, entity_id, created_at")
    .eq("event_type", "lead.lost")
    .limit(500);

  const events = (lostEvents ?? []) as LostEventRow[];
  const outcomes: NurtureOutcome[] = [];

  for (const event of events) {
    outcomes.push(await processOneLead(supabase, event, now));
  }

  return { candidates: events.length, outcomes };
}

async function processOneLead(supabase: SupabaseClient, lostEvent: LostEventRow, now: Date): Promise<NurtureOutcome> {
  const leadId = lostEvent.entity_id;
  const organizationId = lostEvent.organization_id;

  // Phase C: checked first, before the getLead lookup below, so a disabled
  // organization pays no further query cost for this candidate.
  if (!(await getAutomationEnabled(supabase, organizationId, "lost-lead-nurture"))) {
    return { leadId, outcome: "skipped_disabled" };
  }

  // Only process leads whose CURRENT status is still 'lost' (requirement:
  // "only process leads whose current status is 'lost'") - a lead that
  // became active again since going lost is never a nurture candidate,
  // full stop, regardless of how much time has passed.
  const lead = await getLead(supabase, organizationId, leadId);
  if (!lead || lead.status !== "lost") {
    return { leadId, outcome: "not_lost" };
  }

  const lostAt = new Date(lostEvent.created_at).getTime();
  const elapsed = now.getTime() - lostAt;

  let occurrence: 1 | 2 | null = null;
  if (elapsed >= TOUCH_2_DELAY_MS) {
    occurrence = 2;
  } else if (elapsed >= TOUCH_1_DELAY_MS) {
    occurrence = 1;
  }

  if (!occurrence) {
    return { leadId, outcome: "not_due" };
  }

  // Resolve contact/conversation BEFORE creating the automation_events row:
  // the n8n callback route (app/api/automation/n8n-callback) has no other way
  // to learn contact_id/conversation_id at callback time - it only ever reads
  // them back out of this event's own stored `payload` column, never from
  // anything n8n's callback body carries. Omitting conversation_id here would
  // make evaluateOutboundGate() unconditionally deny every real send with
  // "missing_conversation_id", regardless of how good the AI's drafted
  // message was - so it must be resolved first and included at creation time.
  let conversationId: string | null = null;
  let contact: { id: string; first_name: string | null; last_name: string | null; phone: string | null; email: string | null } | null = null;

  if (lead.contact_id) {
    const fetchedContact = await getContact(supabase, organizationId, lead.contact_id);
    contact = fetchedContact
      ? {
          id: fetchedContact.id,
          first_name: fetchedContact.first_name,
          last_name: fetchedContact.last_name,
          phone: fetchedContact.phone,
          email: fetchedContact.email,
        }
      : null;

    const conversation = await findOrCreateOpenConversation(supabase, organizationId, lead.contact_id, "sms", leadId);
    conversationId = conversation?.id ?? null;
  }

  const idempotencyKey = `lead.lost_nurture:${leadId}:${occurrence}`;

  const eventResult = await createAutomationEventAsService(supabase, organizationId, {
    eventType: "lead.lost_nurture",
    entityType: "lead",
    entityId: leadId,
    payload: { lead_id: leadId, contact_id: lead.contact_id, conversation_id: conversationId, occurrence },
    idempotencyKey,
  });

  if (!eventResult.ok) {
    return { leadId, outcome: "failed", error: eventResult.error };
  }
  if (eventResult.duplicate) {
    return { leadId, outcome: "skipped_duplicate" };
  }
  if (eventResult.skipped) {
    return { leadId, outcome: "skipped_disabled" };
  }

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, LEAD_LOST_NURTURE_WORKFLOW);
  if (!executionResult.ok) {
    return { leadId, outcome: "failed", error: executionResult.error };
  }

  const executionId = executionResult.execution.id;

  const [aiSettings, businessProfile] = await Promise.all([
    getAiSettings(supabase, organizationId),
    getBusinessProfile(supabase, organizationId),
  ]);

  // Only real, stored facts are ever passed into the contract - service,
  // source, and the AI's own prior summary (if any). No prior conversation
  // transcript, no pricing, no availability - the n8n prompt is instructed
  // never to invent anything beyond what's given here.
  const contract: N8nWorkflowContract = {
    version: 1,
    event: {
      id: eventResult.event.id,
      type: "lead.lost_nurture",
      organization_id: organizationId,
      entity_type: "lead",
      entity_id: leadId,
      payload: {
        lead_id: leadId,
        contact_id: lead.contact_id,
        conversation_id: conversationId,
        service: lead.service,
        source: lead.source,
        ai_summary: lead.ai_summary,
        status: lead.status,
        occurrence,
      },
    },
    execution: {
      id: executionId,
      workflow_name: LEAD_LOST_NURTURE_WORKFLOW,
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
      contact,
    },
  };

  after(async () => {
    const dispatch = await triggerN8nWorkflow(contract);
    if (!dispatch.ok) {
      const failed = await failWorkflowExecutionAsService(supabase, executionId, dispatch.error);
      if (!failed.ok) {
        console.error("[automation] failed to record lead.lost_nurture dispatch failure", {
          executionId,
          dispatchError: dispatch.error,
          recordError: failed.error,
        });
      }
    }
  });

  return { leadId, outcome: "dispatched", occurrence, executionId };
}
