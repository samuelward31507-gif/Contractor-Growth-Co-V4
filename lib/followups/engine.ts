import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "@/lib/automation/events";
import { startWorkflowExecutionAsService, SERVICE_EXECUTION_OPS, type ExecutionOps } from "@/lib/automation/executions";
import { evaluateOutboundGate, isWithinBusinessHours, type OutboundGateDenialReason, type OutboundGateInput } from "@/lib/automation/outbound-gate";
import { checkLifecycleEligibility } from "@/lib/automation/lifecycle-eligibility";
import { hoursPastDue, isTouchOverdue } from "@/lib/automation/late-touch";
import { getAutomationEnabled } from "@/lib/automation/settings";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getBusinessHours, getOrganizationTimezone, type BusinessHour } from "@/lib/settings/queries";
import { isWithinQuietHoursFloor, nextAllowedSendTime, sendTimeZone } from "@/lib/automation/send-window";
import type { LeadStatus } from "@/lib/leads/queries";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";
import { loadLifecycleSnapshot, SNAPSHOT_MESSAGE_LIMIT } from "@/lib/lifecycle/snapshot-loader";
import { deriveLifecycleStage, type LifecycleResult } from "@/lib/lifecycle/derive";
import type { LifecycleSnapshot } from "@/lib/lifecycle/snapshot";
import { FOLLOWUP_DISPATCH_BATCH, FOLLOWUP_LEASE_MINUTES, touchCount, touchDueAt } from "./config";
import type { FollowupState } from "./state";
import { FOLLOWUP_COLUMNS, transitionFollowup, type FollowupRow, type Fields } from "./store";
import { FOLLOWUP_EVENT_TYPE, LEAD_NO_REPLY, getObligationKindDescriptor, type ObligationKindDescriptor } from "./kinds";

export { FOLLOWUP_AUTOMATION_ID } from "./store";
export { FOLLOWUP_EVENT_TYPE, FOLLOWUP_WORKFLOW } from "./kinds";

/**
 * P0 A4 -> P0-B B2.1: the obligation engine. A followups row is an
 * OBLIGATION; its `stage` names its KIND (lib/followups/kinds.ts descriptor
 * + the handler below). The dispatcher is kind-agnostic; everything
 * kind-specific comes from the kind. Producers (producer.ts) only record
 * intent; the dispatcher is the only thing that acts. Per obligation it:
 *   1. claims it with a lease (conditional update - one winner); a row of
 *      an unregistered kind is never claimed;
 *   2. loads the kind's subject (lead), then the contact's B1 lifecycle
 *      snapshot (lib/lifecycle) and derives the lifecycle - a failed read
 *      releases the obligation unconsumed, never acts on it;
 *   3. asks the kind whether it is still owed (lead_no_reply: customer
 *      replied, from the snapshot; A3's lifecycle rule);
 *   4. pauses a touch more than 48 hours late (dormant), never sends it late;
 *   5. defers a touch due outside business hours, unconsumed;
 *   6. records the touch through the existing execution machinery under the
 *      kind's idempotency key (automation enabled + organization pause are
 *      enforced there; B0's atomic start claims the execution), then the
 *      outbound gate, then the send; a send failure is a failed execution
 *      that A2 retries (retryFollowupTouch);
 *   7. advances to the next touch (config.ts cadence) or completes/exits.
 *
 * Every lead_no_reply value - states, waiting_on/next_action, cadence,
 * touch numbering, touch key, reasons, gate options, terminal reasons - is
 * A4's, unchanged. Writes use the service-role client.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// ------------------------------------------------------------------- kinds

/** What a kind's subject resolves to at dispatch time. */
export type ObligationSubject = { id: string; contactId: string | null };

export type StillOwedContext = {
  service: SupabaseClient;
  row: FollowupRow;
  subject: ObligationSubject;
  /** The subject contact's B1 lifecycle facts; null only when the subject has no contact. */
  snapshot: LifecycleSnapshot | null;
  /** deriveLifecycleStage(snapshot); null with the snapshot. */
  lifecycle: LifecycleResult | null;
};

export type StillOwedVerdict = { to: "completed" | "exited"; reason: string } | null;

/** The runtime half of an obligation kind. */
export type ObligationKindHandler = {
  stage: ObligationKindDescriptor["stage"];
  /** Reads the live subject; null = gone. */
  loadSubject: (service: SupabaseClient, row: FollowupRow) => Promise<ObligationSubject | null>;
  /** exit_reason when the subject is gone. */
  subjectMissingReason: string;
  /** Re-checked before every touch (and every retry). Null = still owed. */
  stillOwed: (context: StillOwedContext) => Promise<StillOwedVerdict>;
  /** The message for touch n. */
  compose: (touch: number) => string;
  /** The kind's own outbound gate options (the gate's semantics are never changed). */
  gateOptions: Pick<OutboundGateInput, "leadEligibleStatuses" | "leadMustHaveNoActiveEngagement" | "respectBusinessHours">;
  /** Gate denials after which the obligation can never apply again - it exits. Every other block consumes the touch. */
  terminalGateReasons: ReadonlySet<OutboundGateDenialReason>;
};

export type ObligationKind = ObligationKindDescriptor & ObligationKindHandler;

// ----------------------------------------------------- kind: lead_no_reply (A4)

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

export function composeFollowupTouchBody(touch: number): string {
  if (touch === 1) return "Just following up on your request - do you have any questions, or would you like to set up a time to talk? Reply STOP to opt out of texts.";
  if (touch === 2) return "Checking in again on your request - we'd be glad to help whenever you're ready. Reply STOP to opt out of texts.";
  return "One last check-in on your request - just reply here if you'd still like our help. Reply STOP to opt out of texts.";
}

/** Postgres timestamps carry microseconds; compare at that precision (a JS Date stops at milliseconds). */
function timestampMicros(iso: string): number {
  const fraction = /\.(\d+)/.exec(iso)?.[1] ?? "";
  return Date.parse(iso) * 1000 + Number(fraction.padEnd(6, "0").slice(3, 6));
}

/**
 * A4's "the customer texted after the follow-up began", answered from the
 * snapshot's message timeline (newest first, SNAPSHOT_MESSAGE_LIMIT rows).
 * Only when that window is full and every message in it is newer than the
 * anchor could an older reply sit outside it - then, and only then, A4's
 * own targeted read answers instead, so the verdict is always A4's.
 */
async function customerRepliedSince(service: SupabaseClient, row: FollowupRow, subject: ObligationSubject, snapshot: LifecycleSnapshot): Promise<boolean> {
  const began = timestampMicros(row.created_at);
  const messages = snapshot.messages;
  if (messages.some((message) => message.direction === "inbound" && timestampMicros(message.createdAt) > began)) return true;
  const windowMayHideReply = messages.length >= SNAPSHOT_MESSAGE_LIMIT && messages.every((message) => timestampMicros(message.createdAt) > began);
  if (!windowMayHideReply || !subject.contactId) return false;
  const { data: conversations } = await service.from("conversations").select("id").eq("organization_id", row.organization_id).eq("contact_id", subject.contactId);
  const ids = (conversations ?? []).map((c) => c.id as string);
  if (ids.length === 0) return false;
  const { data: reply } = await service.from("messages").select("id").eq("organization_id", row.organization_id).in("conversation_id", ids).eq("direction", "inbound").gt("created_at", row.created_at).limit(1).maybeSingle();
  return Boolean(reply);
}

const LEAD_NO_REPLY_HANDLER: ObligationKindHandler = {
  stage: "lead_no_reply",
  loadSubject: async (service, row) => {
    const { data } = await service.from("leads").select("id, contact_id, status").eq("id", row.lead_id).eq("organization_id", row.organization_id).maybeSingle();
    return data ? { id: data.id as string, contactId: (data.contact_id as string | null) ?? null } : null;
  },
  subjectMissingReason: "lead_not_found",
  /**
   * A4's exit conditions, unchanged: the customer texted after the
   * follow-up began (now read from the B1 snapshot's message timeline - the
   * same contact, the same conversations, the same organization), then A3's
   * shared lifecycle rule (lead closed / superseded / contact-level active
   * engagement / no contact). A3 keeps its own reads in B2.1 so its decision
   * is byte-for-byte the same; moving it onto the snapshot is a later step.
   */
  stillOwed: async ({ service, row, subject, snapshot }) => {
    if (snapshot && (await customerRepliedSince(service, row, subject, snapshot))) return { to: "completed", reason: "customer_replied" };
    const lifecycle = await checkLifecycleEligibility(service, row.organization_id, FOLLOWUP_EVENT_TYPE, row.lead_id);
    if (!lifecycle.eligible) return { to: "exited", reason: lifecycle.reason };
    return null;
  },
  compose: composeFollowupTouchBody,
  gateOptions: { leadEligibleStatuses: FOLLOWUP_LEAD_STATUSES, leadMustHaveNoActiveEngagement: true, respectBusinessHours: true },
  terminalGateReasons: TERMINAL_GATE_REASONS,
};

const OBLIGATION_KIND_HANDLERS: Readonly<Record<ObligationKindDescriptor["stage"], ObligationKindHandler>> = {
  lead_no_reply: LEAD_NO_REPLY_HANDLER,
};

/** The registered kind for a stage (descriptor + handler) - exact key only; unregistered is null, never a default. */
export function getObligationKind(stage: string): ObligationKind | null {
  const descriptor = getObligationKindDescriptor(stage);
  const handler = descriptor ? OBLIGATION_KIND_HANDLERS[descriptor.stage] : undefined;
  return descriptor && handler ? { ...descriptor, ...handler } : null;
}

/** Every registered kind (tests / documentation). */
export function registeredObligationKinds(): ObligationKind[] {
  return [getObligationKind(LEAD_NO_REPLY.stage)!];
}

// ----------------------------------------------------- shared touch runtime
//
// P0-B B2.4: the universal steps of every touch - a persisted obligation
// (the dispatcher below) or derived work (lib/automation/touch-runtime.ts).
// They take a kind's identity and policy VALUES only and never branch on
// which kind is running. The one outbound send site lives here.

/** The catalog identity a touch is recorded under. */
export type TouchIdentity = { automationId: string; eventType: string; workflowName: string };

/**
 * HOW a run was initiated - never what kind it is. The cron/event path is
 * "event"; an admin "Run now" is "manual". "retry" is A2's alone: A2 starts
 * the retry execution itself, so it never passes through here.
 */
export type ExecutionContext = { triggerSource: "event" | "manual" };
export const EVENT_EXECUTION_CONTEXT: ExecutionContext = { triggerSource: "event" };

/**
 * A kind's audit fields: the ids that identify the touch on every execution
 * record it produces. Flat scalars only - never a free-form blob - and never
 * one of the runtime's own outcome fields.
 */
export type AuditFields = Readonly<Record<string, string | number | null>>;
export const RUNTIME_OUTCOME_FIELDS: readonly string[] = ["should_send", "blocked_reason", "blocked_detail", "message_id", "conversation_id", "provider_message_id", "sent"];

/** The first audit field that is not a flat scalar or that would overwrite a runtime outcome field, or null. Deterministic: fields are checked in sorted order. */
export function auditFieldViolation(fields: Record<string, unknown>): string | null {
  for (const key of Object.keys(fields).sort()) {
    if (RUNTIME_OUTCOME_FIELDS.includes(key)) return key;
    const value = fields[key];
    if (value !== null && typeof value !== "string" && typeof value !== "number") return key;
  }
  return null;
}

export type LifecycleVerification = { failed: false; snapshot: LifecycleSnapshot | null; lifecycle: LifecycleResult | null } | { failed: true; error: string };

/**
 * Universal lifecycle verification: the subject contact's B1 snapshot
 * (scoped to organization + contact, as of now), derived. `failed` = the
 * read failed and nothing may act on it. No contact = nothing to load.
 */
export async function verifyLifecycle(service: SupabaseClient, organizationId: string, contactId: string | null, now: Date): Promise<LifecycleVerification> {
  if (!contactId) return { failed: false, snapshot: null, lifecycle: null };
  const loaded = await loadLifecycleSnapshot(service, organizationId, contactId, { asOf: now });
  if (loaded.failed) return { failed: true, error: loaded.error };
  return { failed: false, snapshot: loaded.snapshot, lifecycle: deriveLifecycleStage(loaded.snapshot) };
}

export type TouchClaim = { status: "claimed"; executionId: string; eventId: string } | { status: "error"; error: string } | { status: "skipped" } | { status: "duplicate" } | { status: "start_failed"; error: string };

/**
 * The touch's claim: its idempotency key (the automation event - automation
 * enabled + organization pause are enforced there), then B0's atomic
 * execution start. A duplicate key means the touch was already used.
 */
export async function claimTouch(
  service: SupabaseClient,
  kind: TouchIdentity,
  organizationId: string,
  touch: { entityType: string; entityId: string; payload: Record<string, unknown>; idempotencyKey: string },
  context: ExecutionContext = EVENT_EXECUTION_CONTEXT,
  /** P0-B B2.8a: the started execution's metadata - only a draft hand-off marks it (DRAFT_HANDOFF_METADATA); every other claim starts with {}. */
  startMetadata: Record<string, unknown> = {},
): Promise<TouchClaim> {
  const eventResult = await createAutomationEventAsService(service, organizationId, {
    eventType: kind.eventType,
    entityType: touch.entityType,
    entityId: touch.entityId,
    payload: touch.payload,
    idempotencyKey: touch.idempotencyKey,
  });
  if (!eventResult.ok) return { status: "error", error: eventResult.error };
  if (eventResult.skipped) return { status: "skipped" };
  if (eventResult.duplicate) return { status: "duplicate" };
  const execution = await startWorkflowExecutionAsService(service, eventResult.event.id, kind.workflowName, startMetadata, context.triggerSource);
  if (!execution.ok) return { status: "start_failed", error: execution.error };
  return { status: "claimed", executionId: execution.execution.id, eventId: eventResult.event.id };
}

/**
 * P0-B B2.7a: how much an execution record of a touch may hold. "full" is
 * the record every kind has always written (blocked_detail on a block;
 * message, conversation and provider ids on a send; the provider's error on
 * a failure). "minimal" keeps ids and numbers only: no blocked_detail, a send
 * is { should_send: true, sent: true }, and a send failure records the
 * kind's fixed failureMessage instead of the provider's error text.
 */
export type AuditRecordPolicy = { shape: "full" } | { shape: "minimal"; failureMessage: string };
export const FULL_AUDIT_RECORD: AuditRecordPolicy = { shape: "full" };

/** Why a policy value is unusable, or null. Never falls back to another shape. */
export function auditRecordViolation(policy: unknown): string | null {
  if (!policy || typeof policy !== "object") return "audit_record_policy_missing";
  const shape = (policy as { shape?: unknown }).shape;
  if (shape === "full") return null;
  if (shape === "minimal") {
    const message = (policy as { failureMessage?: unknown }).failureMessage;
    return typeof message === "string" && message.trim().length > 0 ? null : "audit_record_minimal_needs_failure_message";
  }
  return "audit_record_shape_unknown";
}

/** A blocked touch's outcome fields under the policy (then the kind's audit fields). */
export function blockedOutcome(policy: AuditRecordPolicy, reason: string, detail: string | null): Record<string, unknown> {
  return policy.shape === "full" ? { should_send: false, blocked_reason: reason, blocked_detail: detail } : { should_send: false, blocked_reason: reason };
}

export type BlockedRecord = { status: "blocked"; reason: string } | { status: "error"; error: string } | { status: "skipped" } | { status: "duplicate" } | { status: "start_failed"; error: string };

/**
 * A touch that is decided before any message exists (overdue, known-missing
 * subject): its key is claimed under the run's trigger source and the
 * execution is completed as blocked - never composed, never gated, never
 * sent. `fields` are recorded after the runtime's outcome fields and may not
 * overwrite them.
 */
export async function recordBlockedTouch(
  service: SupabaseClient,
  kind: TouchIdentity,
  organizationId: string,
  touch: { entityType: string; entityId: string; payload: Record<string, unknown>; idempotencyKey: string },
  context: ExecutionContext,
  outcome: { reason: string; detail: string | null },
  fields: Record<string, unknown>,
  record: AuditRecordPolicy,
): Promise<BlockedRecord> {
  const violation = auditFieldViolation(fields);
  if (violation) return { status: "error", error: `audit_field_rejected:${violation}` };
  const policyViolation = auditRecordViolation(record);
  if (policyViolation) return { status: "error", error: policyViolation };
  const recorded = await claimTouch(service, kind, organizationId, touch, context);
  if (recorded.status !== "claimed") return recorded;
  await SERVICE_EXECUTION_OPS.complete(service, recorded.executionId, { ...blockedOutcome(record, outcome.reason, outcome.detail), ...fields });
  return { status: "blocked", reason: outcome.reason };
}

/** The gate inputs a kind may supply; the runtime owns the rest (organization, execution, contact, conversation, lead, message). */
export type KindGateOptions = Omit<OutboundGateInput, "organizationId" | "executionId" | "contactId" | "conversationId" | "leadId" | "aiResult" | "automationEnabled">;

/** One Trackpr-composed send, already composed by the kind. */
export type TouchSend = {
  organizationId: string;
  contactId: string | null;
  /** The gate's lead and the conversation's lead link; null for a non-lead subject. */
  leadId: string | null;
  body: string;
  gateOptions: KindGateOptions;
  /** Policy value: the automation whose enabled state the gate re-checks, or null for a kind whose gate call never carried it. */
  gateAutomationId: string | null;
  senderType: "ai" | "system";
  /** The kind's ids, recorded on the execution's result after the runtime's outcome fields. */
  auditFields: AuditFields;
  /** How much the execution record may hold. */
  auditRecord: AuditRecordPolicy;
};

/**
 * "duplicate_in_progress" (P0-B B2.8a): the outbound unique index refused this
 * send because another request for the SAME execution already owns it. Not a
 * failure and nothing is recorded here - the owner records the outcome.
 * Unreachable for a touch whose execution this run claimed alone; reachable
 * only when two requests resume one handed-off execution.
 */
export type TouchResult = { kind: "sent"; messageId: string } | { kind: "blocked"; reason: OutboundGateDenialReason } | { kind: "failed"; error: string } | { kind: "duplicate_in_progress" };

/** The shared Trackpr-composed executor: outbound gate, then send, recorded on the execution via `ops` (the A2 contract). */
export async function executeTouch(
  supabase: SupabaseClient,
  input: TouchSend,
  executionId: string,
  ops: ExecutionOps,
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<TouchResult> {
  // Checked before anything is read or written; a kind can never overwrite an outcome field.
  const violation = auditFieldViolation(input.auditFields);
  if (violation) throw new Error(`audit_field_rejected:${violation}`);
  const policyViolation = auditRecordViolation(input.auditRecord);
  if (policyViolation) throw new Error(policyViolation);
  const record = input.auditRecord;
  const conversation = input.contactId ? await findOrCreateOpenConversation(supabase, input.organizationId, input.contactId, "sms", input.leadId) : null;
  const automationEnabled = input.gateAutomationId ? await getAutomationEnabled(supabase, input.organizationId, input.gateAutomationId) : null;
  const gate = await evaluateOutboundGate(supabase, {
    organizationId: input.organizationId,
    executionId,
    contactId: input.contactId,
    conversationId: conversation?.id ?? null,
    leadId: input.leadId,
    aiResult: { should_send: true, response_message: input.body, needs_human: false },
    ...input.gateOptions,
    ...(automationEnabled === null ? {} : { automationEnabled }),
  });
  if (!gate.allowed) {
    await ops.complete(supabase, executionId, { ...blockedOutcome(record, gate.reason, gate.detail ?? null), ...input.auditFields });
    return { kind: "blocked", reason: gate.reason };
  }
  const sent = await sendOutboundMessage(supabase, {
    organizationId: input.organizationId,
    contactId: gate.contactId,
    conversationId: gate.conversationId,
    channel: "sms",
    body: gate.body,
    senderType: input.senderType,
    workflowExecutionId: executionId,
    sendSmsFn,
  });
  // The owner of this execution's send records it - never fail the execution from here (P0-B B2.8a, HIGH-1).
  if (!sent.ok && sent.duplicateInProgress) return { kind: "duplicate_in_progress" };
  // Final Batch 2: the provider reported the recipient opted out (Twilio 21610) - a business block, recorded
  // like the gate's own contact_opted_out, never a failed (and so retryable) execution.
  if (!sent.ok && sent.recipientOptedOut) {
    await ops.complete(supabase, executionId, { ...blockedOutcome(record, "contact_opted_out", "provider_opt_out"), ...input.auditFields });
    return { kind: "blocked", reason: "contact_opted_out" };
  }
  if (!sent.ok) {
    // A minimal record never carries the provider's error text - not on the execution, not in the result.
    const error = record.shape === "full" ? sent.error : record.failureMessage;
    await ops.fail(supabase, executionId, error, "sms_send_failed");
    return { kind: "failed", error };
  }
  const sentOutcome = record.shape === "full" ? { should_send: true, message_id: sent.messageId, conversation_id: sent.conversationId, provider_message_id: sent.providerMessageId } : { should_send: true, sent: true };
  await ops.complete(supabase, executionId, { ...sentOutcome, ...input.auditFields });
  return { kind: "sent", messageId: sent.messageId };
}

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

/** One tick: every due scheduled obligation plus any whose lease expired (crash recovery). */
export async function dispatchDueObligations(service: SupabaseClient, now: Date = new Date(), options: DispatchOptions = {}): Promise<DispatchOutcome[]> {
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
      outcomes.push(await dispatchObligation(service, id, now, { sendSmsFn: options.sendSmsFn }));
    } catch (error) {
      outcomes.push({ followupId: id, outcome: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

type ClaimResult = { claimed: FollowupRow; kind: ObligationKind } | { claimed: null; unregisteredStage?: string };

/** Claim: scheduled and due (or Run now), or processing with an expired lease. Exactly one caller wins. An unregistered kind is never claimed. */
async function claimObligation(service: SupabaseClient, id: string, now: Date, runNow: boolean): Promise<ClaimResult> {
  const { data } = await service.from("followups").select(FOLLOWUP_COLUMNS).eq("id", id).maybeSingle();
  if (!data) return { claimed: null };
  const row = data as FollowupRow;
  const kind = getObligationKind(row.stage);
  if (!kind) return { claimed: null, unregisteredStage: row.stage };
  const lease = new Date(now.getTime() + FOLLOWUP_LEASE_MINUTES * MINUTE_MS).toISOString();
  let query = service.from("followups").update({ state: "processing", lease_until: lease }).eq("id", id).eq("state", row.state);
  if (row.state === "scheduled") {
    if (!runNow && (!row.next_action_at || new Date(row.next_action_at).getTime() > now.getTime())) return { claimed: null };
    query = query.eq("next_action_at", row.next_action_at!);
  } else if (row.state === "processing") {
    if (!row.lease_until || new Date(row.lease_until).getTime() >= now.getTime()) return { claimed: null };
    query = query.eq("lease_until", row.lease_until);
  } else {
    return { claimed: null };
  }
  const { data: claimed } = await query.select(FOLLOWUP_COLUMNS);
  const won = ((claimed ?? []) as FollowupRow[])[0] ?? null;
  return won ? { claimed: won, kind } : { claimed: null };
}

/** The subject contact's B1 lifecycle facts for a persisted obligation (the shared verifyLifecycle). */
async function loadLifecycle(service: SupabaseClient, row: FollowupRow, subject: ObligationSubject, now: Date): Promise<LifecycleVerification> {
  return verifyLifecycle(service, row.organization_id, subject.contactId, now);
}

export async function dispatchObligation(service: SupabaseClient, id: string, now: Date = new Date(), options: DispatchOptions = {}): Promise<DispatchOutcome> {
  const claim = await claimObligation(service, id, now, options.runNow === true);
  if (!claim.claimed) {
    return claim.unregisteredStage ? { followupId: id, outcome: "error", error: `unregistered_obligation_kind:${claim.unregisteredStage}` } : { followupId: id, outcome: "not_claimed" };
  }
  const { kind } = claim;
  let row = claim.claimed;
  const release = async (to: FollowupState, fields: Fields) => {
    const next = await transitionFollowup(service, row, to, { lease_until: null, ...fields });
    if (next) row = next;
    return next;
  };

  const subject = await kind.loadSubject(service, row);
  if (!subject) {
    await release("exited", { exit_reason: kind.subjectMissingReason, waiting_on: "none", next_action: "none", next_action_at: null });
    return { followupId: id, outcome: "exited", reason: kind.subjectMissingReason };
  }

  const facts = await loadLifecycle(service, row, subject, now);
  if (facts.failed) {
    // Unknown lifecycle: release unconsumed, exactly like an event-creation error. Never act on a failed read.
    await release("scheduled", { next_action_at: row.next_action_at ?? now.toISOString() });
    return { followupId: id, outcome: "error", error: `lifecycle_snapshot_failed: ${facts.error}` };
  }

  const preCheck = await kind.stillOwed({ service, row, subject, snapshot: facts.snapshot, lifecycle: facts.lifecycle });
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

  // Business hours and the quiet-hours floor (lib/automation/send-window.ts): defer to the next moment both
  // allow; the touch is not consumed.
  const [hours, timeZone] = await Promise.all([getBusinessHours(service, row.organization_id), getOrganizationTimezone(service, row.organization_id)]);
  const zone = sendTimeZone(timeZone);
  const opening = nextAllowedSendTime(now, (at) => isWithinQuietHoursFloor(at, zone) && isWithinBusinessHours(at, zone, hours));
  if (!opening) {
    await release("paused", { paused_reason: "no_business_hours", waiting_on: "business", next_action: "human_review" });
    return { followupId: id, outcome: "paused", reason: "no_business_hours" };
  }
  if (opening.getTime() > now.getTime()) {
    await release("scheduled", { next_action_at: opening.toISOString() });
    return { followupId: id, outcome: "deferred", until: opening.toISOString() };
  }

  const touch = row.attempt_count + 1;
  const recorded = await claimTouch(service, kind, row.organization_id, {
    entityType: kind.subjectType,
    entityId: row.lead_id,
    payload: { followup_id: row.id, lead_id: row.lead_id, contact_id: subject.contactId, stage: row.stage, touch },
    idempotencyKey: kind.touchKey(row.id, touch),
  });
  if (recorded.status === "error") {
    await release("scheduled", { next_action_at: row.next_action_at ?? now.toISOString() });
    return { followupId: id, outcome: "error", error: recorded.error };
  }
  if (recorded.status === "skipped") {
    // Automation disabled or organization automation paused since it was scheduled: hold, unconsumed.
    await release("scheduled", { next_action_at: row.next_action_at ?? now.toISOString() });
    return { followupId: id, outcome: "skipped_disabled" };
  }
  if (recorded.status === "duplicate") {
    // This touch was already recorded (an earlier claim crashed after recording it) - never send it twice.
    await advance(row, touch, null, now, release);
    return { followupId: id, outcome: "blocked", touch, reason: "duplicate_touch" };
  }
  if (recorded.status === "start_failed") {
    await release("failed", { waiting_on: "none", next_action: "human_review" });
    return { followupId: id, outcome: "failed", touch, error: recorded.error };
  }

  const result = await executeTouch(service, obligationTouchSend(kind, { organizationId: row.organization_id, leadId: row.lead_id, contactId: subject.contactId, followupId: row.id, touch }), recorded.executionId, SERVICE_EXECUTION_OPS, options.sendSmsFn);
  return recordTouchResult(kind, row, touch, recorded.executionId, result, now, release);
}

/** A persisted obligation's touch, in the shared executor's terms: the kind's message, gate options and result ids. */
function obligationTouchSend(kind: ObligationKind, input: { organizationId: string; leadId: string; contactId: string | null; followupId: string; touch: number }): TouchSend {
  return {
    organizationId: input.organizationId,
    contactId: input.contactId,
    leadId: input.leadId,
    body: kind.compose(input.touch),
    gateOptions: kind.gateOptions,
    gateAutomationId: kind.automationId,
    senderType: "ai",
    auditFields: { followup_id: input.followupId, lead_id: input.leadId, touch: input.touch },
    auditRecord: FULL_AUDIT_RECORD,
  };
}

type Release = (to: FollowupState, fields: Fields) => Promise<FollowupRow | null>;

async function recordTouchResult(kind: ObligationKind, row: FollowupRow, touch: number, executionId: string, result: TouchResult, now: Date, release: Release): Promise<DispatchOutcome> {
  if (result.kind === "duplicate_in_progress") {
    // P0-B B2.8a: unreachable here (this run claimed the execution alone). Were it reached, another request owns the
    // touch's send: the touch is used, exactly like an already-recorded touch - never sent twice.
    await advance(row, touch, executionId, now, release);
    return { followupId: row.id, outcome: "blocked", touch, reason: "duplicate_touch" };
  }
  if (result.kind === "failed") {
    // A2 owns the retry of the failed execution (retryFollowupTouch advances us).
    await release("failed", { last_execution_id: executionId, waiting_on: "none", next_action: "retry" });
    return { followupId: row.id, outcome: "failed", touch, error: result.error };
  }
  if (result.kind === "blocked" && kind.terminalGateReasons.has(result.reason)) {
    await release("exited", { last_execution_id: executionId, attempt_count: touch, exit_reason: result.reason, waiting_on: "none", next_action: "none", next_action_at: null });
    return { followupId: row.id, outcome: "exited", reason: result.reason };
  }
  await advance(row, touch, executionId, now, release);
  return result.kind === "sent" ? { followupId: row.id, outcome: "sent", touch, messageId: result.messageId } : { followupId: row.id, outcome: "blocked", touch, reason: result.reason };
}

/** After touch `touch` was used: schedule the next one (config.ts cadence), or complete the cadence. */
async function advance(row: FollowupRow, touch: number, executionId: string | null, now: Date, release: Release): Promise<void> {
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
 * P0 A2 integration: the retry of a failed obligation touch. retry.ts has
 * already created the new attempt (start_workflow_execution, trigger_source
 * 'retry'); this re-runs the kind's exit checks (with a fresh lifecycle
 * snapshot), the outbound gate and the send for the SAME touch, recorded
 * with `ops`, then advances the obligation from 'failed'. Obligation writes
 * always use the service-role client.
 */
export async function retryObligationTouch(
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
  const kind = getObligationKind(row.stage);
  if (!kind) {
    await ops.fail(supabase, executionId, `Unregistered obligation kind: ${row.stage}`);
    return { ok: false, error: `unregistered_obligation_kind:${row.stage}` };
  }
  const release: Release = async (to, fields) => {
    const next = await transitionFollowup(service, row!, to, fields);
    if (next) row = next;
    return next;
  };

  const subject = await kind.loadSubject(service, row);
  let preCheck: StillOwedVerdict;
  if (!subject) {
    preCheck = { to: "exited", reason: kind.subjectMissingReason };
  } else {
    const facts = await loadLifecycle(service, row, subject, now);
    if (facts.failed) {
      // Unknown lifecycle: never resend on a failed read - the retry fails and A2 decides again.
      await ops.fail(supabase, executionId, `lifecycle_snapshot_failed: ${facts.error}`);
      return { ok: false, error: "lifecycle_snapshot_failed" };
    }
    preCheck = await kind.stillOwed({ service, row, subject, snapshot: facts.snapshot, lifecycle: facts.lifecycle });
  }
  if (preCheck) {
    await ops.complete(supabase, executionId, { should_send: false, blocked_reason: preCheck.reason, followup_id: followupId, touch });
    await release(preCheck.to, { exit_reason: preCheck.reason, waiting_on: "none", next_action: "none", next_action_at: null, last_execution_id: executionId });
    return { ok: true };
  }

  const result = await executeTouch(supabase, obligationTouchSend(kind, { organizationId: row.organization_id, leadId: row.lead_id, contactId: subject!.contactId, followupId, touch }), executionId, ops, sendSmsFn);
  if (result.kind === "failed") {
    await service.from("followups").update({ last_execution_id: executionId }).eq("id", followupId).eq("state", "failed");
    return { ok: false, error: result.error };
  }
  await recordTouchResult(kind, row, touch, executionId, result, now, release);
  return { ok: true };
}

// ----------------------------------------------- A4 names (unchanged API)

/** A4 name: the health tick's dispatcher. */
export const dispatchDueFollowups = dispatchDueObligations;
/** A4 name: dispatch one follow-up (Run now uses it). */
export const dispatchFollowup = dispatchObligation;
/** A4 name: the A2 retry of a follow-up touch (lib/automation/retry.ts). */
export const retryFollowupTouch = retryObligationTouch;
