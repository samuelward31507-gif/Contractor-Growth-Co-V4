import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "@/lib/automation/events";
import { startWorkflowExecutionAsService, SERVICE_EXECUTION_OPS, type ExecutionOps } from "@/lib/automation/executions";
import { evaluateOutboundGate, isWithinBusinessHours, type OutboundGateDenialReason } from "@/lib/automation/outbound-gate";
import { checkLifecycleEligibility } from "@/lib/automation/lifecycle-eligibility";
import { hoursPastDue, isTouchOverdue } from "@/lib/automation/late-touch";
import { getAutomationEnabled } from "@/lib/automation/settings";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getBusinessHours, getOrganizationTimezone, type BusinessHour } from "@/lib/settings/queries";
import type { LeadStatus } from "@/lib/leads/queries";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";
import { FOLLOWUP_DISPATCH_BATCH, FOLLOWUP_LEASE_MINUTES, touchCount, touchDueAt } from "./config";
import type { FollowupState } from "./state";
import { FOLLOWUP_AUTOMATION_ID, FOLLOWUP_COLUMNS, transitionFollowup, type FollowupRow, type Fields } from "./store";

export { FOLLOWUP_AUTOMATION_ID } from "./store";

/**
 * P0 A4: the Follow-Up Engine.
 *
 *   Producers (ensureLeadFollowup, reactivateLeadFollowup) only record
 *   INTENT in public.followups - they never send.
 *
 *   The dispatcher (dispatchDueFollowups / dispatchFollowup) is the only
 *   thing that acts. Per follow-up it:
 *     1. claims it with a lease (a conditional update - one winner);
 *     2. re-checks exit conditions: customer replied, the A3 lifecycle
 *        rule (lead closed / superseded / active engagement);
 *     3. pauses a touch that went stale (more than 48 hours late, the
 *        shared late-touch rule) instead of sending it late;
 *     4. defers a touch due outside business hours to the next opening,
 *        without consuming it;
 *     5. records the touch through the existing execution machinery under
 *        an idempotency key (followup.touch:<id>:<touch>) - automation
 *        enabled + organization automation pause are enforced there - then
 *        the outbound gate, then the send; a send failure is a failed
 *        execution that A2 retries (retryFollowupTouch);
 *     6. advances to the next touch, or completes/exits.
 *
 * Writes use the service-role client: members can only read follow-ups.
 */

export const FOLLOWUP_EVENT_TYPE = "followup.touch";
export const FOLLOWUP_WORKFLOW = "lead_followup_touch";

/** Lead statuses a no-reply follow-up may still message (the gate re-checks live). */
const FOLLOWUP_LEAD_STATUSES: LeadStatus[] = ["new", "contacted", "qualified"];

/** Gate denials after which this follow-up can never apply again - the follow-up exits. */
const TERMINAL_GATE_REASONS = new Set<OutboundGateDenialReason>([
  "contact_opted_out",
  "contact_not_found",
  "invalid_destination",
  "conversation_ai_disabled",
  "lead_not_found",
  "lead_wrong_organization",
  "lead_conversation_mismatch",
  "lead_status_ineligible",
  "lead_has_active_engagement",
]);

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// --------------------------------------------------------------- dispatcher

/** The first moment at or after `from` inside business hours (15-minute steps, up to 8 days), or null if the week has no opening. */
export function nextBusinessOpening(from: Date, timeZone: string, hours: BusinessHour[]): Date | null {
  if (isWithinBusinessHours(from, timeZone, hours)) return from;
  const step = 15 * MINUTE_MS;
  let t = Math.ceil(from.getTime() / step) * step;
  const limit = from.getTime() + 8 * 24 * HOUR_MS;
  for (; t <= limit; t += step) {
    if (isWithinBusinessHours(new Date(t), timeZone, hours)) return new Date(t);
  }
  return null;
}

export type DispatchOutcome =
  | { followupId: string; outcome: "not_claimed" }
  | { followupId: string; outcome: "skipped_disabled" }
  | { followupId: string; outcome: "deferred"; until: string }
  | { followupId: string; outcome: "paused"; reason: string }
  | { followupId: string; outcome: "completed"; reason: string }
  | { followupId: string; outcome: "exited"; reason: string }
  | { followupId: string; outcome: "sent"; touch: number; messageId: string }
  | { followupId: string; outcome: "blocked"; touch: number; reason: string }
  | { followupId: string; outcome: "failed"; touch: number; error: string }
  | { followupId: string; outcome: "error"; error: string };

export type DispatchOptions = {
  /** TEST-only "Run now": dispatch a scheduled follow-up before its due time. Every check still runs. */
  runNow?: boolean;
  /** Test seam only - production callers never pass this. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>;
};

/** One tick: every due scheduled follow-up plus any whose lease expired (crash recovery). */
export async function dispatchDueFollowups(service: SupabaseClient, now: Date = new Date(), options: DispatchOptions = {}): Promise<DispatchOutcome[]> {
  const nowIso = now.toISOString();
  const [due, stale] = await Promise.all([
    service.from("followups").select("id").eq("state", "scheduled").lte("next_action_at", nowIso).order("next_action_at", { ascending: true }).limit(FOLLOWUP_DISPATCH_BATCH),
    service.from("followups").select("id").eq("state", "processing").lt("lease_until", nowIso).limit(FOLLOWUP_DISPATCH_BATCH),
  ]);
  if (due.error || stale.error) {
    // A database without the followups table: the tick does nothing.
    console.error("[followups] due scan failed", { error: due.error?.message ?? stale.error?.message });
    return [];
  }
  const ids = [...new Set([...(due.data ?? []), ...(stale.data ?? [])].map((row) => row.id as string))];
  const outcomes: DispatchOutcome[] = [];
  for (const id of ids) {
    try {
      outcomes.push(await dispatchFollowup(service, id, now, { sendSmsFn: options.sendSmsFn }));
    } catch (error) {
      outcomes.push({ followupId: id, outcome: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

/** Claim: scheduled and due (or Run now), or processing with an expired lease. Exactly one caller wins. */
async function claimFollowup(service: SupabaseClient, id: string, now: Date, runNow: boolean): Promise<FollowupRow | null> {
  const { data } = await service.from("followups").select(FOLLOWUP_COLUMNS).eq("id", id).maybeSingle();
  if (!data) return null;
  const row = data as FollowupRow;
  const lease = new Date(now.getTime() + FOLLOWUP_LEASE_MINUTES * MINUTE_MS).toISOString();
  let query = service.from("followups").update({ state: "processing", lease_until: lease }).eq("id", id).eq("state", row.state);
  if (row.state === "scheduled") {
    if (!runNow && (!row.next_action_at || new Date(row.next_action_at).getTime() > now.getTime())) return null;
    query = query.eq("next_action_at", row.next_action_at!);
  } else if (row.state === "processing") {
    if (!row.lease_until || new Date(row.lease_until).getTime() >= now.getTime()) return null;
    query = query.eq("lease_until", row.lease_until);
  } else {
    return null;
  }
  const { data: claimed } = await query.select(FOLLOWUP_COLUMNS);
  return ((claimed ?? []) as FollowupRow[])[0] ?? null;
}

export async function dispatchFollowup(service: SupabaseClient, id: string, now: Date = new Date(), options: DispatchOptions = {}): Promise<DispatchOutcome> {
  const claimed = await claimFollowup(service, id, now, options.runNow === true);
  if (!claimed) return { followupId: id, outcome: "not_claimed" };
  let row = claimed;
  const release = async (to: FollowupState, fields: Fields) => {
    const next = await transitionFollowup(service, row, to, { lease_until: null, ...fields });
    if (next) row = next;
    return next;
  };

  const lead = await loadLead(service, row);
  if (!lead) {
    await release("exited", { exit_reason: "lead_not_found", waiting_on: "none", next_action: "none", next_action_at: null });
    return { followupId: id, outcome: "exited", reason: "lead_not_found" };
  }

  const preCheck = await checkStillOwed(service, row, lead);
  if (preCheck) {
    await release(preCheck.to, { exit_reason: preCheck.reason, waiting_on: "none", next_action: "none", next_action_at: null });
    return { followupId: id, outcome: preCheck.to, reason: preCheck.reason };
  }

  // Dormancy: never send a touch more than 48 hours after it was due.
  const dueAt = new Date(row.next_action_at ?? row.created_at);
  if (isTouchOverdue(hoursPastDue(now.getTime(), dueAt.getTime(), 0))) {
    await release("paused", { paused_reason: "dormant", waiting_on: "none", next_action: "none" });
    return { followupId: id, outcome: "paused", reason: "dormant" };
  }

  // Business hours: defer to the next opening; the touch is not consumed.
  const [hours, timeZone] = await Promise.all([getBusinessHours(service, row.organization_id), getOrganizationTimezone(service, row.organization_id)]);
  const opening = nextBusinessOpening(now, timeZone ?? "UTC", hours);
  if (!opening) {
    await release("paused", { paused_reason: "no_business_hours", waiting_on: "business", next_action: "human_review" });
    return { followupId: id, outcome: "paused", reason: "no_business_hours" };
  }
  if (opening.getTime() > now.getTime()) {
    await release("scheduled", { next_action_at: opening.toISOString() });
    return { followupId: id, outcome: "deferred", until: opening.toISOString() };
  }

  const touch = row.attempt_count + 1;
  const eventResult = await createAutomationEventAsService(service, row.organization_id, {
    eventType: FOLLOWUP_EVENT_TYPE,
    entityType: "lead",
    entityId: row.lead_id,
    payload: { followup_id: row.id, lead_id: row.lead_id, contact_id: lead.contact_id, stage: row.stage, touch },
    idempotencyKey: `${FOLLOWUP_EVENT_TYPE}:${row.id}:${touch}`,
  });
  if (!eventResult.ok) {
    await release("scheduled", { next_action_at: row.next_action_at ?? now.toISOString() });
    return { followupId: id, outcome: "error", error: eventResult.error };
  }
  if (eventResult.skipped) {
    // Automation disabled or organization automation paused since it was scheduled: hold, unconsumed.
    await release("scheduled", { next_action_at: row.next_action_at ?? now.toISOString() });
    return { followupId: id, outcome: "skipped_disabled" };
  }
  if (eventResult.duplicate) {
    // This touch was already recorded (an earlier claim crashed after recording it) - never send it twice.
    await advance(service, row, touch, null, now, release);
    return { followupId: id, outcome: "blocked", touch, reason: "duplicate_touch" };
  }

  const execution = await startWorkflowExecutionAsService(service, eventResult.event.id, FOLLOWUP_WORKFLOW);
  if (!execution.ok) {
    await release("failed", { waiting_on: "none", next_action: "human_review" });
    return { followupId: id, outcome: "failed", touch, error: execution.error };
  }

  const result = await sendTouch(service, { organizationId: row.organization_id, leadId: row.lead_id, contactId: lead.contact_id, followupId: row.id, touch }, execution.execution.id, SERVICE_EXECUTION_OPS, options.sendSmsFn);
  return recordTouchResult(service, row, touch, execution.execution.id, result, now, release);
}

type LeadFacts = { id: string; contact_id: string | null; status: LeadStatus };

async function loadLead(service: SupabaseClient, row: Pick<FollowupRow, "organization_id" | "lead_id">): Promise<LeadFacts | null> {
  const { data } = await service.from("leads").select("id, contact_id, status").eq("id", row.lead_id).eq("organization_id", row.organization_id).maybeSingle();
  return (data as LeadFacts | null) ?? null;
}

/** Exit conditions, re-checked live before every touch. Null = still owed. */
async function checkStillOwed(service: SupabaseClient, row: FollowupRow, lead: LeadFacts): Promise<{ to: "completed" | "exited"; reason: string } | null> {
  if (lead.contact_id) {
    const { data: conversations } = await service.from("conversations").select("id").eq("organization_id", row.organization_id).eq("contact_id", lead.contact_id);
    const ids = (conversations ?? []).map((c) => c.id as string);
    if (ids.length > 0) {
      const { data: reply } = await service.from("messages").select("id").eq("organization_id", row.organization_id).in("conversation_id", ids).eq("direction", "inbound").gt("created_at", row.created_at).limit(1).maybeSingle();
      if (reply) return { to: "completed", reason: "customer_replied" };
    }
  }
  const lifecycle = await checkLifecycleEligibility(service, row.organization_id, FOLLOWUP_EVENT_TYPE, row.lead_id);
  if (!lifecycle.eligible) return { to: "exited", reason: lifecycle.reason };
  return null;
}

export type TouchResult = { kind: "sent"; messageId: string } | { kind: "blocked"; reason: OutboundGateDenialReason } | { kind: "failed"; error: string };

export function composeFollowupTouchBody(touch: number): string {
  if (touch === 1) return "Just following up on your request - do you have any questions, or would you like to set up a time to talk? Reply STOP to opt out of texts.";
  if (touch === 2) return "Checking in again on your request - we'd be glad to help whenever you're ready. Reply STOP to opt out of texts.";
  return "One last check-in on your request - just reply here if you'd still like our help. Reply STOP to opt out of texts.";
}

/** The touch itself: outbound gate, then send, recorded on the execution via `ops` (the A2 contract). */
async function sendTouch(
  supabase: SupabaseClient,
  input: { organizationId: string; leadId: string; contactId: string | null; followupId: string; touch: number },
  executionId: string,
  ops: ExecutionOps,
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<TouchResult> {
  const conversation = input.contactId ? await findOrCreateOpenConversation(supabase, input.organizationId, input.contactId, "sms", input.leadId) : null;
  const body = composeFollowupTouchBody(input.touch);
  const automationEnabled = await getAutomationEnabled(supabase, input.organizationId, FOLLOWUP_AUTOMATION_ID);
  const gate = await evaluateOutboundGate(supabase, {
    organizationId: input.organizationId,
    executionId,
    contactId: input.contactId,
    conversationId: conversation?.id ?? null,
    leadId: input.leadId,
    aiResult: { should_send: true, response_message: body, needs_human: false },
    leadEligibleStatuses: FOLLOWUP_LEAD_STATUSES,
    leadMustHaveNoActiveEngagement: true,
    respectBusinessHours: true,
    automationEnabled,
  });
  const meta = { followup_id: input.followupId, lead_id: input.leadId, touch: input.touch };
  if (!gate.allowed) {
    await ops.complete(supabase, executionId, { should_send: false, blocked_reason: gate.reason, blocked_detail: gate.detail ?? null, ...meta });
    return { kind: "blocked", reason: gate.reason };
  }
  const sent = await sendOutboundMessage(supabase, {
    organizationId: input.organizationId,
    contactId: gate.contactId,
    conversationId: gate.conversationId,
    channel: "sms",
    body: gate.body,
    senderType: "ai",
    workflowExecutionId: executionId,
    sendSmsFn,
  });
  if (!sent.ok) {
    await ops.fail(supabase, executionId, sent.error, "sms_send_failed");
    return { kind: "failed", error: sent.error };
  }
  await ops.complete(supabase, executionId, { should_send: true, message_id: sent.messageId, conversation_id: sent.conversationId, provider_message_id: sent.providerMessageId, ...meta });
  return { kind: "sent", messageId: sent.messageId };
}

type Release = (to: FollowupState, fields: Fields) => Promise<FollowupRow | null>;

async function recordTouchResult(service: SupabaseClient, row: FollowupRow, touch: number, executionId: string, result: TouchResult, now: Date, release: Release): Promise<DispatchOutcome> {
  if (result.kind === "failed") {
    // A2 owns the retry of the failed execution (retryFollowupTouch advances us).
    await release("failed", { last_execution_id: executionId, waiting_on: "none", next_action: "retry" });
    return { followupId: row.id, outcome: "failed", touch, error: result.error };
  }
  if (result.kind === "blocked" && TERMINAL_GATE_REASONS.has(result.reason)) {
    await release("exited", { last_execution_id: executionId, attempt_count: touch, exit_reason: result.reason, waiting_on: "none", next_action: "none", next_action_at: null });
    return { followupId: row.id, outcome: "exited", reason: result.reason };
  }
  await advance(service, row, touch, executionId, now, release);
  return result.kind === "sent" ? { followupId: row.id, outcome: "sent", touch, messageId: result.messageId } : { followupId: row.id, outcome: "blocked", touch, reason: result.reason };
}

/** After touch `touch` was used: schedule the next one, or complete the cadence. */
async function advance(_service: SupabaseClient, row: FollowupRow, touch: number, executionId: string | null, now: Date, release: Release): Promise<void> {
  const fields: Fields = { attempt_count: touch, ...(executionId ? { last_execution_id: executionId } : {}) };
  if (touch >= touchCount(row.stage)) {
    await release("completed", { ...fields, exit_reason: "cadence_complete", waiting_on: "none", next_action: "none", next_action_at: null });
    return;
  }
  const anchor = new Date(row.reactivated_at ?? row.created_at);
  const due = touchDueAt(anchor, row.stage, touch + 1)!;
  await release("scheduled", { ...fields, next_action_at: new Date(Math.max(due.getTime(), now.getTime())).toISOString(), waiting_on: "customer", next_action: "send_followup" });
}

// -------------------------------------------------------------------- A2 retry

/**
 * P0 A2 integration: the retry of a failed follow-up touch. retry.ts has
 * already created the new attempt (start_workflow_execution, trigger_source
 * 'retry'); this re-runs the exit checks, the outbound gate and the send for
 * the SAME touch, recorded with `ops`, then advances the follow-up from
 * 'failed'. Follow-up writes always use the service-role client.
 */
export async function retryFollowupTouch(
  supabase: SupabaseClient,
  event: { organizationId: string; payload: Record<string, unknown> },
  executionId: string,
  ops: ExecutionOps,
  service: SupabaseClient,
  now: Date = new Date(),
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const followupId = typeof event.payload?.followup_id === "string" ? event.payload.followup_id : null;
  const touch = typeof event.payload?.touch === "number" ? event.payload.touch : null;
  if (!followupId || !touch) {
    await ops.fail(supabase, executionId, "Missing follow-up reference.");
    return { ok: false, error: "Missing follow-up reference." };
  }
  const { data } = await service.from("followups").select(FOLLOWUP_COLUMNS).eq("id", followupId).eq("organization_id", event.organizationId).maybeSingle();
  let row = data as FollowupRow | null;
  if (!row || row.state !== "failed" || row.attempt_count + 1 !== touch) {
    // The follow-up moved on (completed, exited, or already advanced): nothing to resend.
    await ops.complete(supabase, executionId, { should_send: false, blocked_reason: "followup_not_pending", followup_id: followupId, touch });
    return { ok: true };
  }
  const release: Release = async (to, fields) => {
    const next = await transitionFollowup(service, row!, to, fields);
    if (next) row = next;
    return next;
  };

  const lead = await loadLead(service, row);
  const preCheck = lead ? await checkStillOwed(service, row, lead) : { to: "exited" as const, reason: "lead_not_found" };
  if (preCheck) {
    await ops.complete(supabase, executionId, { should_send: false, blocked_reason: preCheck.reason, followup_id: followupId, touch });
    await release(preCheck.to, { exit_reason: preCheck.reason, waiting_on: "none", next_action: "none", next_action_at: null, last_execution_id: executionId });
    return { ok: true };
  }

  const result = await sendTouch(supabase, { organizationId: row.organization_id, leadId: row.lead_id, contactId: lead!.contact_id, followupId, touch }, executionId, ops, sendSmsFn);
  if (result.kind === "failed") {
    await service.from("followups").update({ last_execution_id: executionId }).eq("id", followupId).eq("state", "failed");
    return { ok: false, error: result.error };
  }
  await recordTouchResult(service, row, touch, executionId, result, now, release);
  return { ok: true };
}
