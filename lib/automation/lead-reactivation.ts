import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { failWorkflowExecutionAsService } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { claimAndHandOffTouch, type DerivedTouchAdapter, type DerivedTouchSubject, type HandOffResult } from "./touch-runtime";
import { getAutomationEnabled, getAutomationConfigByOrganization, readLeadReactivationConfig, type LeadReactivationConfig } from "./settings";
import { getLead, type Lead, type LeadStatus } from "@/lib/leads/queries";
import { getContact } from "@/lib/contacts/queries";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";
import { readAllPages } from "@/lib/bi/revenue-attribution";
import { enabledPerOrganization, hoursPastDue, isTouchOverdue, recordOverdueTouch, recordLifecycleBlockedTouch } from "./late-touch";
import { checkLifecycleEligibility, type LifecycleBlockReason } from "./lifecycle-eligibility";

export const LEAD_REACTIVATION_WORKFLOW = "lead_reactivation_followup";
export const LEAD_REACTIVATION_AUTOMATION_ID = "lead-reactivation";
export const LEAD_REACTIVATION_EVENT_TYPE = "lead.reactivation";

/**
 * Automation Configuration V4: the pure decision behind which touch (if
 * any) is due, given elapsed time since the lead's last inbound message
 * and the organization's own configured thresholds - extracted so "the
 * configured cadence, not a hardcoded constant, drives occurrence" can be
 * unit tested directly. At most one touch per call: if both thresholds
 * have already been crossed, the more current one (2) is preferred over
 * dispatching a stale first touch - matching the identical choice already
 * made in lib/automation/lead-nurture.ts's computeNurtureOccurrence. Does
 * not affect idempotency: the idempotency key is derived from
 * `leadId:occurrence` only, never from elapsed time or configuration
 * values - see processOneLead below.
 */
export function computeReactivationOccurrence(elapsedMs: number, config: LeadReactivationConfig): 1 | 2 | null {
  const touch1Ms = config.touch_1_days * 24 * 60 * 60 * 1000;
  const touch2Ms = config.touch_2_days * 24 * 60 * 60 * 1000;
  if (elapsedMs >= touch2Ms) return 2;
  if (elapsedMs >= touch1Ms) return 1;
  return null;
}

// Only these statuses are reactivation candidates: 'appointment'/'estimate'
// already have their own dedicated follow-up automations (layering a
// generic inactivity message on top would be redundant/conflicting), and
// 'won'/'lost' are closed outcomes ('lost' already owned by Phase 4.8's
// nurture flow). See the Phase 4.9 audit report for the full reasoning.
const ELIGIBLE_LEAD_STATUSES: LeadStatus[] = ["new", "contacted", "qualified"];

const ACTIVE_APPOINTMENT_STATUSES = ["scheduled", "confirmed"];
const ACTIVE_ESTIMATE_STATUSES = ["sent", "accepted"];
const ACTIVE_JOB_STATUSES = ["scheduled", "in_progress"];


/**
 * P0-B B2.8c: one lead reactivation touch, as the shared touch runtime sees
 * it. The producer below still owns discovery (open conversation, inbound
 * history, cadence on the last inbound message), the active-engagement and
 * status checks, the 48-hour rule and the recorded A3 block; `schedule` is
 * null when the touch is resumed from n8n's draft.
 */
export type ReactivationTouchItem = {
  organizationId: string;
  leadId: string;
  contactId: string | null;
  occurrence: 1 | 2;
  conversationId: string | null;
  /** `runNow`: the TEST-only Run now (runLeadReactivationNow) chose this touch before its cadence wait ended - the only check it skips. */
  schedule: { lastInboundAtMs: number; config: LeadReactivationConfig; runNow?: true } | null;
};
type ReactivationTouchFacts = { lead: Lead };

const reactivationSubject = ({ organizationId, leadId, contactId }: ReactivationTouchItem): DerivedTouchSubject => ({ organizationId, contactId, leadId, entityType: "lead", entityId: leadId });

/**
 * P0-B B2.8c: lead reactivation on the shared n8n hand-off. Trackpr claims
 * the touch (key + B0, marked for a draft hand-off), n8n only drafts, and the
 * draft re-enters through resumeClaimedTouch: B1, this still-owed re-check
 * (an eligible status, this lead's own open SMS conversation - never created
 * for a reactivation - and A3), the organization's AI setting, the outbound
 * gate (eligible status, no active appointment/estimate/job, automation
 * enabled), the send and the record. Trackpr never composes this message.
 */
export const LEAD_REACTIVATION_ADAPTER: DerivedTouchAdapter<ReactivationTouchItem, ReactivationTouchFacts> = {
  identity: { automationId: LEAD_REACTIVATION_AUTOMATION_ID, eventType: LEAD_REACTIVATION_EVENT_TYPE, workflowName: LEAD_REACTIVATION_WORKFLOW },
  policy: {
    requiresActivePayment: false,
    stale: { mode: "none" },
    missingSubject: "record_blocked",
    gateChecksAutomationEnabled: true,
    senderType: "ai",
    auditRecord: { shape: "full" },
  },
  subject: reactivationSubject,
  idempotencyKey: ({ leadId, occurrence }) => `${LEAD_REACTIVATION_EVENT_TYPE}:${leadId}:${occurrence}`,
  isDue: ({ schedule, occurrence }, now) => schedule !== null && (schedule.runNow === true || computeReactivationOccurrence(now.getTime() - schedule.lastInboundAtMs, schedule.config) === occurrence),
  dueAt: ({ schedule, occurrence }) => ({ anchorMs: schedule?.lastInboundAtMs ?? 0, delayMs: schedule ? (occurrence === 2 ? schedule.config.touch_2_days : schedule.config.touch_1_days) * 24 * 60 * 60 * 1000 : 0 }),
  stillOwed: async (service, { organizationId, leadId, contactId }) => {
    const lead = await getLead(service, organizationId, leadId);
    if (!lead || !ELIGIBLE_LEAD_STATUSES.includes(lead.status)) return { owed: false, reason: "not_eligible_status" };
    if (!contactId) return { owed: false, reason: "no_contact" };
    const { data: openConversation } = await service.from("conversations").select("id, lead_id").eq("organization_id", organizationId).eq("contact_id", contactId).eq("channel", "sms").eq("status", "open").maybeSingle();
    if (!openConversation || openConversation.lead_id !== leadId) return { owed: false, reason: "no_open_conversation" };
    const eligibility = await checkLifecycleEligibility(service, organizationId, "lead.reactivation", leadId, contactId);
    if (!eligibility.eligible) return { owed: false, reason: eligibility.reason };
    return { owed: true, facts: { lead } };
  },
  payload: ({ leadId, contactId, conversationId, occurrence }) => ({ lead_id: leadId, contact_id: contactId, conversation_id: conversationId, occurrence }),
  compose: () => {
    throw new Error("lead reactivation is drafted by n8n - Trackpr never composes it");
  },
  gateOptions: () => ({ leadEligibleStatuses: ELIGIBLE_LEAD_STATUSES, leadMustHaveNoActiveEngagement: true }),
  auditFields: ({ leadId, occurrence }) => ({ lead_id: leadId, occurrence }),
  verifyClaimed: async (service, item, facts) => {
    const aiSettings = await getAiSettings(service, item.organizationId);
    if (!aiSettings.ai_enabled) return { verdict: "blocked", reason: "organization_ai_disabled" };
    return { verdict: "verified", facts, contactId: item.contactId, leadId: item.leadId };
  },
};

/** The touch a lead.reactivation execution was claimed for, rebuilt from Trackpr's stored event - never from the callback. */
export function reactivationTouchItemFromEvent(event: { organization_id: string; entity_id: string | null; payload: Record<string, unknown> | null }): ReactivationTouchItem | null {
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

function reactivationOutcomeOf(leadId: string, occurrence: 1 | 2, result: HandOffResult): ReactivationOutcome {
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
      if (result.reason === "quiet_hours") return { leadId, outcome: "quiet_hours" };
      if (result.reason === "not_owed" && (result.detail === "not_eligible_status" || result.detail === "no_open_conversation" || result.detail === "no_contact")) return { leadId, outcome: result.detail };
      return { leadId, outcome: "not_owed", reason: result.detail ?? result.reason };
    case "failed":
      return { leadId, outcome: "failed", error: result.error };
  }
}

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
  /** Final Batch 1: inside the quiet-hours floor; nothing recorded - a later run inside the window hands it off. */
  | { leadId: string; outcome: "quiet_hours" }
  | { leadId: string; outcome: "skipped_duplicate" }
  | { leadId: string; outcome: "skipped_disabled" }
  | { leadId: string; outcome: "active_engagement" }
  | { leadId: string; outcome: "not_eligible_status" }
  | { leadId: string; outcome: "blocked"; reason: "followup_overdue" | LifecycleBlockReason | "contact_not_found" }
  /** P0-B B2.8c: the shared runtime's still-owed re-check refused the claim (a change since the producer's own checks); nothing recorded. */
  | { leadId: string; outcome: "not_owed"; reason: string }
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
 * eligibility back out to the organization's configured touch_2_days after
 * that NEW reply, with no special "cancel" logic required. Candidates are
 * scanned directly from `leads` (there is no prior lifecycle event to scan,
 * unlike processLeadNurture).
 *
 * Automation Configuration V4: touch_1_days/touch_2_days are per-organization
 * (automation_settings.config), defaulting to 7/21 for any organization
 * that hasn't configured them - identical to the hardcoded behavior before
 * this setting existed. Resolved once per batch via
 * getAutomationConfigByOrganization (one query for every organization that
 * has ever configured this automation), then reused per candidate below -
 * mirroring the identical pattern processLeadNurture already uses, and
 * avoiding a separate config fetch per lead.
 */
export async function processLeadReactivation(supabase: SupabaseClient, now: Date = new Date()): Promise<ReactivationRunResult> {
  const configByOrg = await getAutomationConfigByOrganization(supabase, "lead-reactivation");

  // Phase 3 (W2): every eligible lead, paged in a stable order - the old single read was capped at 500
  // unordered rows across every organization. A failed page stops the run with nothing processed.
  const read = await readAllPages<CandidateLead>(() =>
    supabase.from("leads").select("id, organization_id, contact_id, service, source, ai_summary, status").in("status", ELIGIBLE_LEAD_STATUSES).order("id"),
  );
  if (read.failed) {
    throw new Error("Lead reactivation: the candidate read failed or reached the row limit - no lead was processed.");
  }

  const candidates = read.rows;
  const outcomes: ReactivationOutcome[] = [];
  const isEnabled = enabledPerOrganization((organizationId) => getAutomationEnabled(supabase, organizationId, "lead-reactivation"));

  for (const lead of candidates) {
    const config = readLeadReactivationConfig(configByOrg.get(lead.organization_id) ?? null);
    outcomes.push(await processOneLead(supabase, lead, now, config, isEnabled));
  }

  return { candidates: candidates.length, outcomes };
}

async function processOneLead(
  supabase: SupabaseClient,
  lead: CandidateLead,
  now: Date,
  config: LeadReactivationConfig,
  isEnabled: (organizationId: string) => Promise<boolean>,
  options: { runNow?: boolean } = {},
): Promise<ReactivationOutcome> {
  const leadId = lead.id;
  const organizationId = lead.organization_id;

  // Phase C: checked first, before any of the conversation/message/
  // engagement queries below, so a disabled organization pays no further
  // query cost for this candidate.
  if (!(await isEnabled(organizationId))) {
    return { leadId, outcome: "skipped_disabled" };
  }

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
  // touch_2_days from that new reply rather than firing on the original
  // clock.
  const due = computeReactivationOccurrence(elapsed, config);
  // P0-B B2.8f (TEST-only Run now): the touch the cadence says is due, else the next one (see
  // runNowOccurrence) - early. Only the cadence wait is skipped; every check below still runs.
  const runNow = options.runNow ? await runNowOccurrence(supabase, organizationId, leadId, due) : null;
  const occurrence = runNow?.occurrence ?? due;

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

  // Phase 3 (W2, K5 rule): more than 48 hours past due - recorded as not sent, never sent late.
  const lateHours = hoursPastDue(now.getTime(), new Date(lastInbound.created_at).getTime(), (occurrence === 2 ? config.touch_2_days : config.touch_1_days) * 24 * 60 * 60 * 1000);
  if (isTouchOverdue(lateHours)) {
    const overdue = await recordOverdueTouch(supabase, {
      organizationId,
      eventType: "lead.reactivation",
      entityType: "lead",
      entityId: leadId,
      payload: { lead_id: leadId, contact_id: lead.contact_id, conversation_id: openConversation.id, occurrence },
      idempotencyKey,
      workflowName: LEAD_REACTIVATION_WORKFLOW,
      lateHours,
    });
    return { leadId, ...overdue };
  }

  // P0 A3: the shared lifecycle rule (lib/automation/lifecycle-eligibility.ts)
  // on top of the lead-level checks above - no touch while another open lead
  // is the contact's current opportunity, while the contact (on any lead)
  // has an active appointment/estimate/job, or for an automatic sms_inbound
  // lead nobody has qualified yet. Recorded as a blocked touch under the
  // same idempotency key; nothing is dispatched.
  const eligibility = await checkLifecycleEligibility(supabase, organizationId, "lead.reactivation", leadId);
  if (!eligibility.eligible) {
    const blocked = await recordLifecycleBlockedTouch(supabase, {
      organizationId,
      eventType: "lead.reactivation",
      entityId: leadId,
      payload: { lead_id: leadId, contact_id: lead.contact_id, conversation_id: openConversation.id, occurrence },
      idempotencyKey,
      workflowName: LEAD_REACTIVATION_WORKFLOW,
      reason: eligibility.reason,
      detail: eligibility.detail,
    });
    return { leadId, ...blocked };
  }

  // P0-B B2.8c: the claim and the hand-off run the shared touch runtime - kill switch (cached), due,
  // the key's soft claim, B1, still owed, then the key + B0 start marked for a draft hand-off. The
  // dispatch itself is deferred exactly as before; its failure fails the execution as before.
  const contactId = lead.contact_id;
  const item: ReactivationTouchItem = { organizationId, leadId, contactId, occurrence, conversationId: openConversation.id, schedule: { lastInboundAtMs: new Date(lastInbound.created_at).getTime(), config, ...(runNow?.early ? { runNow: true as const } : {}) } };
  const result = await claimAndHandOffTouch(supabase, LEAD_REACTIVATION_ADAPTER, item, now, { isEnabled }, async ({ eventId, executionId }) => {
    const [aiSettings, businessProfile, contact] = await Promise.all([
      getAiSettings(supabase, organizationId),
      getBusinessProfile(supabase, organizationId),
      getContact(supabase, organizationId, contactId),
    ]);

    // Only real, stored facts are ever passed into the contract - service,
    // source, and the lead's own prior AI summary (if any). No prior
    // conversation transcript, no pricing, no availability - the n8n prompt
    // is instructed never to invent anything beyond what's given here.
    const contract: N8nWorkflowContract = {
      version: 1,
      event: {
        id: eventId,
        type: LEAD_REACTIVATION_EVENT_TYPE,
        organization_id: organizationId,
        entity_type: "lead",
        entity_id: leadId,
        payload: {
          lead_id: leadId,
          contact_id: contactId,
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
        const failed = await failWorkflowExecutionAsService(supabase, executionId, dispatch.error, "n8n_dispatch_failed");
        if (!failed.ok) {
          console.error("[automation] failed to record lead.reactivation dispatch failure", {
            executionId,
            dispatchError: dispatch.error,
            recordError: failed.error,
          });
        }
      }
    });
    return { ok: true };
  });

  return reactivationOutcomeOf(leadId, occurrence, result);
}

/**
 * P0-B B2.8f: the touch a TEST-only Run now evaluates - the due one; else touch 1; touch 2 only once touch 1
 * has finished (completed or failed). While touch 1 is still in flight it stays touch 1, so a second click
 * meets touch 1's own key (already processed) instead of starting touch 2 at the same moment.
 */
async function runNowOccurrence(supabase: SupabaseClient, organizationId: string, leadId: string, due: 1 | 2 | null): Promise<{ occurrence: 1 | 2; early: boolean }> {
  if (due === 2) return { occurrence: 2, early: false };
  const { data: touch1 } = await supabase.from("automation_events").select("id, status").eq("organization_id", organizationId).eq("idempotency_key", `${LEAD_REACTIVATION_EVENT_TYPE}:${leadId}:1`).maybeSingle();
  if (!touch1 || (touch1.status !== "completed" && touch1.status !== "failed")) return { occurrence: 1, early: due === null };
  return { occurrence: 2, early: true };
}

/**
 * P0-B B2.8f: TEST-only Run now for ONE lead of ONE organization - never a
 * scan. The same per-lead step the scheduled scan runs (enabled, a contact,
 * this lead's own open SMS conversation, inbound history, the key's
 * fast-path duplicate check, active engagement, an eligible status, the
 * 48-hour rule, A3, the claim through claimAndHandOffTouch: kill switch, B1,
 * still owed, the key and B0, the n8n hand-off) - only the wait since the
 * last inbound reply is skipped. Everything after the hand-off is the normal
 * runtime. Only the TEST-only server action calls this (app/(app)/leads/actions.ts).
 */
export async function runLeadReactivationNow(supabase: SupabaseClient, organizationId: string, leadId: string, now: Date = new Date()): Promise<ReactivationOutcome | { leadId: string; outcome: "not_found" }> {
  const { data: lead } = await supabase.from("leads").select("id, organization_id, contact_id, service, source, ai_summary, status").eq("organization_id", organizationId).eq("id", leadId).maybeSingle();
  if (!lead) return { leadId, outcome: "not_found" };
  if (!ELIGIBLE_LEAD_STATUSES.includes(lead.status as LeadStatus)) return { leadId, outcome: "not_eligible_status" };
  const configByOrg = await getAutomationConfigByOrganization(supabase, LEAD_REACTIVATION_AUTOMATION_ID);
  const config = readLeadReactivationConfig(configByOrg.get(organizationId) ?? null);
  const isEnabled = enabledPerOrganization((id) => getAutomationEnabled(supabase, id, LEAD_REACTIVATION_AUTOMATION_ID));
  return processOneLead(supabase, lead as CandidateLead, now, config, isEnabled, { runNow: true });
}
