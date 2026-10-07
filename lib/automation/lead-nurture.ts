import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { failWorkflowExecutionAsService } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { claimAndHandOffTouch, type DerivedTouchAdapter, type DerivedTouchSubject, type HandOffResult } from "./touch-runtime";
import { getAutomationEnabled, getAutomationConfigByOrganization, readLostLeadNurtureConfig, type LostLeadNurtureConfig } from "./settings";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getLead, type Lead } from "@/lib/leads/queries";
import { getContact } from "@/lib/contacts/queries";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";
import { readAllPages } from "@/lib/bi/revenue-attribution";
import { enabledPerOrganization, hoursPastDue, isTouchOverdue, recordOverdueTouch, recordLifecycleBlockedTouch } from "./late-touch";
import { checkLifecycleEligibility, type LifecycleBlockReason } from "./lifecycle-eligibility";

export const LEAD_LOST_NURTURE_WORKFLOW = "lead_lost_nurture_followup";
export const LOST_LEAD_NURTURE_AUTOMATION_ID = "lost-lead-nurture";
export const LEAD_LOST_NURTURE_EVENT_TYPE = "lead.lost_nurture";

/**
 * Automation Configuration V3: the pure decision behind which touch (if
 * any) is due, given elapsed time since a lead went lost and the
 * organization's own configured thresholds - extracted so "the configured
 * cadence, not a hardcoded constant, drives occurrence" can be unit tested
 * directly. At most one touch per call: if both thresholds have already
 * been crossed, the more current one (2) is preferred over dispatching a
 * stale first touch - matching the identical choice already made in
 * lib/automation/estimate-followups.ts's computeFollowupOccurrence.
 */
export function computeNurtureOccurrence(elapsedMs: number, config: LostLeadNurtureConfig): 1 | 2 | null {
  const touch1Ms = config.touch_1_days * 24 * 60 * 60 * 1000;
  const touch2Ms = config.touch_2_days * 24 * 60 * 60 * 1000;
  if (elapsedMs >= touch2Ms) return 2;
  if (elapsedMs >= touch1Ms) return 1;
  return null;
}


/**
 * P0-B B2.8c: one lost-lead nurture touch, as the shared touch runtime sees
 * it. The producer below still owns discovery, cadence, the 48-hour rule and
 * the recorded A3 block; `schedule` carries its cadence for the claim and is
 * null when the touch is resumed from n8n's draft (due-ness was decided when
 * it was claimed).
 */
export type NurtureTouchItem = {
  organizationId: string;
  leadId: string;
  contactId: string | null;
  occurrence: 1 | 2;
  conversationId: string | null;
  /** `runNow`: the TEST-only Run now (runLeadNurtureNow) chose this touch before its cadence wait ended - the only check it skips. */
  schedule: { lostAtMs: number; config: LostLeadNurtureConfig; runNow?: true } | null;
};
type NurtureTouchFacts = { lead: Lead };

const nurtureSubject = ({ organizationId, leadId, contactId }: NurtureTouchItem): DerivedTouchSubject => ({ organizationId, contactId, leadId, entityType: "lead", entityId: leadId });

/**
 * P0-B B2.8c: lost-lead nurture on the shared n8n hand-off. Trackpr claims the
 * touch (key + B0, marked for a draft hand-off), n8n only drafts, and the
 * draft re-enters through resumeClaimedTouch: B1, this still-owed re-check
 * (the lead is still lost, A3), the organization's AI setting, the outbound
 * gate (lead still 'lost', automation enabled), the send and the record.
 * Trackpr never composes this message - the draft is the body.
 */
export const LOST_LEAD_NURTURE_ADAPTER: DerivedTouchAdapter<NurtureTouchItem, NurtureTouchFacts> = {
  identity: { automationId: LOST_LEAD_NURTURE_AUTOMATION_ID, eventType: LEAD_LOST_NURTURE_EVENT_TYPE, workflowName: LEAD_LOST_NURTURE_WORKFLOW },
  policy: {
    // No payment step before the claim, as before: the gate checks payment and live mode before any send.
    requiresActivePayment: false,
    // The producer applies the 48-hour rule (recorded followup_overdue) before the claim.
    stale: { mode: "none" },
    // A contact that is not the organization's: the claimed touch is recorded blocked, never dispatched.
    missingSubject: "record_blocked",
    gateChecksAutomationEnabled: true,
    senderType: "ai",
    auditRecord: { shape: "full" },
  },
  subject: nurtureSubject,
  idempotencyKey: ({ leadId, occurrence }) => `${LEAD_LOST_NURTURE_EVENT_TYPE}:${leadId}:${occurrence}`,
  isDue: ({ schedule, occurrence }, now) => schedule !== null && (schedule.runNow === true || computeNurtureOccurrence(now.getTime() - schedule.lostAtMs, schedule.config) === occurrence),
  dueAt: ({ schedule, occurrence }) => ({ anchorMs: schedule?.lostAtMs ?? 0, delayMs: schedule ? (occurrence === 2 ? schedule.config.touch_2_days : schedule.config.touch_1_days) * 24 * 60 * 60 * 1000 : 0 }),
  stillOwed: async (service, { organizationId, leadId, contactId }) => {
    const lead = await getLead(service, organizationId, leadId);
    if (!lead || lead.status !== "lost") return { owed: false, reason: "lead_not_lost" };
    const eligibility = await checkLifecycleEligibility(service, organizationId, "lead.lost_nurture", leadId, contactId);
    if (!eligibility.eligible) return { owed: false, reason: eligibility.reason };
    return { owed: true, facts: { lead } };
  },
  payload: ({ leadId, contactId, conversationId, occurrence }) => ({ lead_id: leadId, contact_id: contactId, conversation_id: conversationId, occurrence }),
  compose: () => {
    throw new Error("lost-lead nurture is drafted by n8n - Trackpr never composes it");
  },
  gateOptions: () => ({ leadEligibleStatuses: ["lost"] }),
  auditFields: ({ leadId, occurrence }) => ({ lead_id: leadId, occurrence }),
  // The organization's "Allow AI to represent this business" setting, read live once the draft is back.
  verifyClaimed: async (service, item, facts) => {
    const aiSettings = await getAiSettings(service, item.organizationId);
    if (!aiSettings.ai_enabled) return { verdict: "blocked", reason: "organization_ai_disabled" };
    return { verdict: "verified", facts, contactId: item.contactId, leadId: item.leadId };
  },
};

/** The touch a lead.lost_nurture execution was claimed for, rebuilt from Trackpr's stored event - never from the callback. */
export function nurtureTouchItemFromEvent(event: { organization_id: string; entity_id: string | null; payload: Record<string, unknown> | null }): NurtureTouchItem | null {
  const payload = event.payload ?? {};
  const occurrence = payload.occurrence;
  if (!event.entity_id || (occurrence !== 1 && occurrence !== 2)) return null;
  return {
    organizationId: event.organization_id,
    leadId: event.entity_id,
    contactId: typeof payload.contact_id === "string" ? payload.contact_id : null,
    occurrence,
    conversationId: typeof payload.conversation_id === "string" ? payload.conversation_id : null,
    schedule: null,
  };
}

function nurtureOutcomeOf(leadId: string, occurrence: 1 | 2, result: HandOffResult): NurtureOutcome {
  switch (result.status) {
    case "handed_off":
      return { leadId, outcome: "dispatched", occurrence, executionId: result.executionId };
    case "already_processed":
      return { leadId, outcome: "skipped_duplicate" };
    case "blocked":
      return { leadId, outcome: "blocked", reason: result.reason as "contact_not_found" };
    case "unavailable":
      if (result.reason === "skipped_disabled") return { leadId, outcome: "skipped_disabled" };
      if (result.reason === "not_due") return { leadId, outcome: "not_due" };
      if (result.reason === "not_owed" && result.detail === "lead_not_lost") return { leadId, outcome: "not_lost" };
      return { leadId, outcome: "not_owed", reason: result.detail ?? result.reason };
    case "failed":
      return { leadId, outcome: "failed", error: result.error };
  }
}

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
  | { leadId: string; outcome: "blocked"; reason: "followup_overdue" | LifecycleBlockReason | "contact_not_found" }
  /** P0-B B2.8c: the shared runtime's still-owed re-check refused the claim (a change since the producer's own checks); nothing recorded. */
  | { leadId: string; outcome: "not_owed"; reason: string }
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
 * for this. At most one touch per lead per call: if both configured
 * thresholds are already due (e.g. the cron was down for a while), the
 * more current one (touch 2) is preferred over dispatching a stale first
 * touch, mirroring the identical choice already made in
 * processEstimateFollowups.
 *
 * Automation Configuration V3: touch_1_days/touch_2_days are per-organization
 * (automation_settings.config), defaulting to 3/14 for any organization
 * that hasn't configured them - identical to the hardcoded behavior before
 * this setting existed. This query spans every organization at once (the
 * real cron path), so each candidate's own organization's configured
 * thresholds are applied via getAutomationConfigByOrganization's map,
 * mirroring the identical pattern processEstimateFollowups already uses.
 */
export async function processLeadNurture(supabase: SupabaseClient, now: Date = new Date()): Promise<NurtureRunResult> {
  const configByOrg = await getAutomationConfigByOrganization(supabase, "lost-lead-nurture");

  // Phase 3 (W2): every lead.lost event, paged in a stable order - the old single read was capped at 500
  // unordered rows across every organization. A failed page stops the run with nothing processed.
  const read = await readAllPages<LostEventRow>(() =>
    supabase.from("automation_events").select("id, organization_id, entity_id, created_at").eq("event_type", "lead.lost").order("id"),
  );
  if (read.failed) {
    throw new Error("Lost-lead nurture: the candidate read failed or reached the row limit - no lead was processed.");
  }

  const events = read.rows;
  const outcomes: NurtureOutcome[] = [];
  const isEnabled = enabledPerOrganization((organizationId) => getAutomationEnabled(supabase, organizationId, "lost-lead-nurture"));

  for (const event of events) {
    const config = readLostLeadNurtureConfig(configByOrg.get(event.organization_id) ?? null);
    outcomes.push(await processOneLead(supabase, event, now, config, isEnabled));
  }

  return { candidates: events.length, outcomes };
}

async function processOneLead(
  supabase: SupabaseClient,
  lostEvent: LostEventRow,
  now: Date,
  config: LostLeadNurtureConfig,
  isEnabled: (organizationId: string) => Promise<boolean>,
  options: { runNow?: boolean } = {},
): Promise<NurtureOutcome> {
  const leadId = lostEvent.entity_id;
  const organizationId = lostEvent.organization_id;

  // Phase C: checked first, before the getLead lookup below, so a disabled
  // organization pays no further query cost for this candidate.
  if (!(await isEnabled(organizationId))) {
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

  const due = computeNurtureOccurrence(elapsed, config);
  // P0-B B2.8f (TEST-only Run now): the touch the cadence says is due, else the next one (see
  // runNowOccurrence) - early. Only the cadence wait is skipped; every check below still runs.
  const runNow = options.runNow ? await runNowOccurrence(supabase, organizationId, leadId, due) : null;
  const occurrence = runNow?.occurrence ?? due;

  if (!occurrence) {
    return { leadId, outcome: "not_due" };
  }

  // Phase 3 (W2, K5 rule): more than 48 hours past due - recorded as not sent, never sent late. Checked
  // before any conversation is looked up or created.
  const lateHours = hoursPastDue(now.getTime(), lostAt, (occurrence === 2 ? config.touch_2_days : config.touch_1_days) * 24 * 60 * 60 * 1000);
  if (isTouchOverdue(lateHours)) {
    const overdue = await recordOverdueTouch(supabase, {
      organizationId,
      eventType: "lead.lost_nurture",
      entityType: "lead",
      entityId: leadId,
      payload: { lead_id: leadId, contact_id: lead.contact_id, occurrence },
      idempotencyKey: `lead.lost_nurture:${leadId}:${occurrence}`,
      workflowName: LEAD_LOST_NURTURE_WORKFLOW,
      lateHours,
    });
    return { leadId, ...overdue };
  }

  // P0 A3: a lost lead is only nurtured while it is still the contact's
  // relevant opportunity - not once the contact has an open lead (a newer
  // opportunity supersedes it) or an active appointment/estimate/job. The
  // touch is recorded as blocked (same idempotency key, so it is never
  // re-tried or sent later); nothing is dispatched.
  const eligibility = await checkLifecycleEligibility(supabase, organizationId, "lead.lost_nurture", leadId);
  if (!eligibility.eligible) {
    const blocked = await recordLifecycleBlockedTouch(supabase, {
      organizationId,
      eventType: "lead.lost_nurture",
      entityId: leadId,
      payload: { lead_id: leadId, contact_id: lead.contact_id, occurrence },
      idempotencyKey: `lead.lost_nurture:${leadId}:${occurrence}`,
      workflowName: LEAD_LOST_NURTURE_WORKFLOW,
      reason: eligibility.reason,
      detail: eligibility.detail,
    });
    return { leadId, ...blocked };
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

  // P0-B B2.8c: the claim and the hand-off run the shared touch runtime - kill switch (cached), due,
  // the key's soft claim, B1, still owed, then the key + B0 start marked for a draft hand-off. The
  // dispatch itself is deferred exactly as before; its failure fails the execution as before.
  const item: NurtureTouchItem = { organizationId, leadId, contactId: lead.contact_id, occurrence, conversationId, schedule: { lostAtMs: lostAt, config, ...(runNow?.early ? { runNow: true as const } : {}) } };
  const result = await claimAndHandOffTouch(supabase, LOST_LEAD_NURTURE_ADAPTER, item, now, { isEnabled }, async ({ eventId, executionId }) => {
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
        id: eventId,
        type: LEAD_LOST_NURTURE_EVENT_TYPE,
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
        // The claim always starts the first execution of a new event.
        attempt: 1,
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
        const failed = await failWorkflowExecutionAsService(supabase, executionId, dispatch.error, "n8n_dispatch_failed");
        if (!failed.ok) {
          console.error("[automation] failed to record lead.lost_nurture dispatch failure", {
            executionId,
            dispatchError: dispatch.error,
            recordError: failed.error,
          });
        }
      }
    });
    return { ok: true };
  });

  return nurtureOutcomeOf(leadId, occurrence, result);
}

/**
 * P0-B B2.8f: the touch a TEST-only Run now evaluates - the due one; else touch 1; touch 2 only once touch 1
 * has finished (completed or failed). While touch 1 is still in flight it stays touch 1, so a second click
 * meets touch 1's own key (already processed) instead of starting touch 2 at the same moment.
 */
async function runNowOccurrence(supabase: SupabaseClient, organizationId: string, leadId: string, due: 1 | 2 | null): Promise<{ occurrence: 1 | 2; early: boolean }> {
  if (due === 2) return { occurrence: 2, early: false };
  const { data: touch1 } = await supabase.from("automation_events").select("id, status").eq("organization_id", organizationId).eq("idempotency_key", `${LEAD_LOST_NURTURE_EVENT_TYPE}:${leadId}:1`).maybeSingle();
  if (!touch1 || (touch1.status !== "completed" && touch1.status !== "failed")) return { occurrence: 1, early: due === null };
  return { occurrence: 2, early: true };
}

/**
 * P0-B B2.8f: TEST-only Run now for ONE lead of ONE organization - never a
 * scan. The same per-lead step the scheduled scan runs (enabled, still lost,
 * the 48-hour rule, A3, the claim through claimAndHandOffTouch: kill switch,
 * B1, still owed, the key and B0, the n8n hand-off) - only the cadence wait
 * is skipped. Everything after the hand-off is the normal runtime: the
 * strict callback, resumeClaimedTouch and the outbound gate. Only the
 * TEST-only server action calls this (app/(app)/leads/actions.ts).
 */
export async function runLeadNurtureNow(supabase: SupabaseClient, organizationId: string, leadId: string, now: Date = new Date()): Promise<NurtureOutcome | { leadId: string; outcome: "not_found" }> {
  const lead = await getLead(supabase, organizationId, leadId);
  if (!lead) return { leadId, outcome: "not_found" };
  const { data: lostEvent } = await supabase
    .from("automation_events")
    .select("id, organization_id, entity_id, created_at")
    .eq("organization_id", organizationId)
    .eq("event_type", "lead.lost")
    .eq("entity_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!lostEvent) return { leadId, outcome: "not_lost" };
  const configByOrg = await getAutomationConfigByOrganization(supabase, LOST_LEAD_NURTURE_AUTOMATION_ID);
  const config = readLostLeadNurtureConfig(configByOrg.get(organizationId) ?? null);
  const isEnabled = enabledPerOrganization((id) => getAutomationEnabled(supabase, id, LOST_LEAD_NURTURE_AUTOMATION_ID));
  return processOneLead(supabase, lostEvent as LostEventRow, now, config, isEnabled, { runNow: true });
}
