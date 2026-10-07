import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "./events";
import {
  startWorkflowExecutionAsService,
  completeWorkflowExecutionAsService,
  SESSION_EXECUTION_OPS,
  type ExecutionOps,
} from "./executions";
import { runDerivedTouch, retryDerivedTouch, unchangedAfterClaim, type DerivedTouchAdapter, type DerivedTouchSubject } from "./touch-runtime";
import type { ExecutionContext } from "@/lib/followups/engine";
import {
  getAutomationEnabled,
  getAutomationConfig,
  getAutomationConfigByOrganization,
  readEstimateFollowupConfig,
  type EstimateFollowupConfig,
} from "./settings";
import type { EstimateStatus } from "@/lib/estimates/queries";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";
import { readAllPages } from "@/lib/bi/revenue-attribution";

export const ESTIMATE_FOLLOWUP_WORKFLOW = "estimate_followup";
export const ESTIMATE_EXPIRED_WORKFLOW = "estimate_expired_lifecycle";

const ACTIVE_STATUSES: EstimateStatus[] = ["sent"];

/**
 * K5-3: a follow-up processed more than this many hours after it became due
 * is not sent - it is recorded as blocked ("followup_overdue") under its own
 * idempotency key, so no later run can send it either. Exactly 48 hours late
 * still sends normally. Exists because the paged read (K5-1) can surface
 * estimates the old 500-row cap starved for days or weeks; their customers
 * should not get a burst of obsolete check-ins.
 */
export const STALE_FOLLOWUP_GRACE_HOURS = 48;

/** K5-4: test seam only - limits a run to one organization. The scheduled route and the admin "Run now" action never pass it. */
export type FollowupTestScope = { organizationId: string };

const CANDIDATE_COLUMNS = "id, organization_id, contact_id, lead_id, title, status, sent_at, expires_at";

type CandidateEstimate = {
  id: string;
  organization_id: string;
  contact_id: string | null;
  lead_id: string | null;
  title: string;
  status: EstimateStatus;
  sent_at: string;
  expires_at: string | null;
};

export type FollowupOutcome =
  | { estimateId: string; outcome: "sent"; occurrence: 1 | 2; messageId: string }
  | { estimateId: string; outcome: "expired" }
  | { estimateId: string; outcome: "blocked"; reason: string }
  | { estimateId: string; outcome: "skipped_duplicate" }
  | { estimateId: string; outcome: "skipped_disabled" }
  | { estimateId: string; outcome: "not_due" }
  /** Final Batch 1: inside the quiet-hours floor; nothing recorded - a later run inside the window sends it. */
  | { estimateId: string; outcome: "quiet_hours" }
  | { estimateId: string; outcome: "failed"; error: string };

export type FollowupRunResult = {
  candidates: number;
  outcomes: FollowupOutcome[];
};

/**
 * The pure decision behind which follow-up (if any) is due, given how many
 * hours have elapsed since an estimate was sent - extracted so "an
 * organization's own configured follow-up timing is what decides
 * occurrence" can be unit tested directly, without a mocked Supabase
 * client. Shared by processOneEstimate and previewEstimateFollowups below.
 * At most one occurrence per call: if both thresholds have already been
 * crossed, the more current one (2) is preferred - see this module's own
 * top-level comment for why.
 */
export function computeFollowupOccurrence(hoursSinceSent: number, config: EstimateFollowupConfig): 1 | 2 | null {
  if (hoursSinceSent >= config.followup_2_hours) return 2;
  if (hoursSinceSent >= config.followup_1_hours) return 1;
  return null;
}

function composeFollowupBody(estimate: CandidateEstimate, occurrence: 1 | 2): string {
  if (occurrence === 1) {
    return `Just checking in on the estimate we sent for "${estimate.title}" - happy to answer any questions. Reply STOP to opt out of texts.`;
  }
  return `Following up one more time on the estimate for "${estimate.title}" - let us know if you'd like to move forward or have any questions. Reply STOP to opt out of texts.`;
}

const HOUR_MS = 60 * 60 * 1000;

/** How an estimate run was initiated: the cron tick ("event") or an admin's Run now ("manual"). A2 owns "retry". */
export type EstimateRunTriggerSource = ExecutionContext["triggerSource"];

/** One estimate follow-up touch. `config` is null only on an A2 retry, which never re-evaluates cadence or lateness. */
type EstimateTouchItem = { estimate: CandidateEstimate; config: EstimateFollowupConfig | null; occurrence: 1 | 2 | null };

const estimateTouchSubject = ({ estimate }: EstimateTouchItem): DerivedTouchSubject => ({ organizationId: estimate.organization_id, contactId: estimate.contact_id, leadId: estimate.lead_id, entityType: "estimate", entityId: estimate.id });

/**
 * P0-B B2.5: estimate follow-up's kind adapter for the shared touch runtime
 * (lib/automation/touch-runtime.ts). Every value is this automation's
 * existing behavior: anchored on sent_at; the organization's
 * followup_1_hours / followup_2_hours; the occurrence chosen by
 * computeFollowupOccurrence (the more current one when both are due); the
 * legacy key estimate.followup:<id>:<occurrence>; the K5-3 overdue rule
 * (more than 48 hours late is recorded as blocked followup_overdue with
 * {estimate_id, occurrence}); no engagement check (still owed is always
 * true - the gate re-checks the estimate is still 'sent'); no payment or
 * business-hours rule and no enabled re-check at the gate; the deterministic
 * message, sender "ai"; {estimate_id, occurrence} on every execution. A
 * contact that is not the organization's is recorded as blocked
 * contact_not_found (B2.5a). Expiry is NOT here - it is the producer's.
 */
export const ESTIMATE_FOLLOWUP_ADAPTER: DerivedTouchAdapter<EstimateTouchItem, CandidateEstimate> = {
  identity: { automationId: "estimate-followup", eventType: "estimate.followup", workflowName: ESTIMATE_FOLLOWUP_WORKFLOW },
  policy: { requiresActivePayment: false, stale: { mode: "record_blocked", audit: "audit_fields" }, missingSubject: "record_blocked", gateChecksAutomationEnabled: false, senderType: "ai", auditRecord: { shape: "full" } },
  subject: estimateTouchSubject,
  idempotencyKey: ({ estimate, occurrence }) => `estimate.followup:${estimate.id}:${occurrence}`,
  isDue: ({ estimate, config, occurrence }, now) =>
    config !== null && occurrence !== null && computeFollowupOccurrence((now.getTime() - new Date(estimate.sent_at).getTime()) / HOUR_MS, config) === occurrence,
  dueAt: ({ estimate, config, occurrence }) => {
    if (!config || !occurrence) throw new Error("estimate follow-up: no cadence for this touch");
    return { anchorMs: new Date(estimate.sent_at).getTime(), delayMs: (occurrence === 2 ? config.followup_2_hours : config.followup_1_hours) * HOUR_MS };
  },
  stillOwed: async (_service, { estimate }) => ({ owed: true, facts: estimate }),
  payload: ({ estimate, occurrence }) => ({ estimate_id: estimate.id, contact_id: estimate.contact_id, lead_id: estimate.lead_id, occurrence }),
  compose: ({ occurrence }, estimate) => composeFollowupBody(estimate, occurrence!),
  gateOptions: ({ estimate }) => ({ estimateId: estimate.id, estimateEligibleStatuses: ACTIVE_STATUSES }),
  auditFields: ({ estimate, occurrence }) => ({ estimate_id: estimate.id, occurrence }),
  // Nothing to re-check after the claim (B2.7a): the pre-claim facts, contact and lead stand.
  verifyClaimed: unchangedAfterClaim(estimateTouchSubject),
};

/**
 * Finds `sent` estimates due for auto-expiration or their next follow-up,
 * and processes each one: expiration transitions the estimate and records
 * estimate.expired (lifecycle-only, no message, blocks all future
 * follow-ups by leaving 'sent'); a due follow-up sends through the exact
 * same safe outbound gate + sendOutboundMessage path every other automated
 * message uses. Designed to be called repeatedly on a schedule (see
 * app/api/automation/estimate-followups/route.ts) - every step is
 * idempotent, so calling this twice in the same window is always safe.
 *
 * At most one follow-up per estimate per call: if both the 24h and 72h
 * thresholds are already crossed (e.g. the cron was down for a while), the
 * more current one (72h) is preferred over sending an outdated first
 * touchpoint - the 24h one simply never fires in that case, rather than
 * bursting both in the same tick.
 */
export async function processEstimateFollowups(
  supabase: SupabaseClient,
  now: Date = new Date(),
  /** Test seam only - production callers must never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
  /** Phase D: "manual" when triggered by an org admin's "Run now" action; every real cron tick omits this and keeps the column's own 'event' default. */
  triggerSource: EstimateRunTriggerSource = "event",
  /** K5-4: test seam only - never passed by the scheduled route or the "Run now" action. */
  testScope?: FollowupTestScope,
): Promise<FollowupRunResult> {
  const configByOrg = await getAutomationConfigByOrganization(supabase, "estimate-followup");

  // K5-1: every sent estimate, paged in a stable order - the old single read
  // was capped at 500 unordered rows across every organization, so past 500
  // the same arbitrary rows won each tick and the rest were never followed
  // up or expired. Everything is read before anything is processed: a failed
  // page or the row limit stops the run with nothing processed, never a
  // partial run reported as complete.
  const read = await readAllPages<CandidateEstimate>(() => {
    let query = supabase.from("estimates").select(CANDIDATE_COLUMNS).in("status", ACTIVE_STATUSES).not("sent_at", "is", null);
    if (testScope) query = query.eq("organization_id", testScope.organizationId);
    return query.order("id");
  });
  if (read.failed) {
    throw new Error("Estimate follow-ups: the candidate read failed or reached the row limit - no estimate was processed.");
  }

  // K5-5 (R-b): the automation's enabled state, read once per organization per run.
  const enabledByOrg = new Map<string, Promise<boolean>>();
  const isEnabled = (organizationId: string) => {
    let enabled = enabledByOrg.get(organizationId);
    if (!enabled) {
      enabled = getAutomationEnabled(supabase, organizationId, "estimate-followup");
      enabledByOrg.set(organizationId, enabled);
    }
    return enabled;
  };

  const outcomes: FollowupOutcome[] = [];
  for (const estimate of read.rows) {
    const config = readEstimateFollowupConfig(configByOrg.get(estimate.organization_id) ?? null);
    outcomes.push(await processOneEstimate(supabase, estimate, now, config, isEnabled, sendSmsFn, triggerSource));
  }

  return { candidates: read.rows.length, outcomes };
}

/** K5-3: how many hours past its due time the occurrence is. */
function hoursLate(hoursSinceSent: number, occurrence: 1 | 2, config: EstimateFollowupConfig): number {
  return hoursSinceSent - (occurrence === 2 ? config.followup_2_hours : config.followup_1_hours);
}

async function processOneEstimate(
  supabase: SupabaseClient,
  estimate: CandidateEstimate,
  now: Date,
  config: EstimateFollowupConfig,
  isEnabled: (organizationId: string) => Promise<boolean>,
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
  triggerSource: EstimateRunTriggerSource = "event",
): Promise<FollowupOutcome> {
  // K5-2: expiry is a lifecycle fact, not an outbound action - it runs
  // whatever the automation's state. It sends nothing; expireEstimate still
  // records the estimate.expired event only when the existing event rules
  // allow it (automation enabled, organization not paused). It stays here,
  // in the producer: the shared touch runtime only ever runs the touch.
  if (estimate.expires_at && new Date(estimate.expires_at).getTime() <= now.getTime()) {
    return expireEstimate(supabase, estimate, triggerSource);
  }

  // P0-B B2.5: the touch itself runs the shared derived touch runtime - kill
  // switch, still due, B1 verification, K5-3 overdue rule, claim (the legacy
  // key + B0), compose, gate, send, record.
  const hoursSinceSent = (now.getTime() - new Date(estimate.sent_at).getTime()) / HOUR_MS;
  const occurrence = computeFollowupOccurrence(hoursSinceSent, config);
  const result = await runDerivedTouch(supabase, ESTIMATE_FOLLOWUP_ADAPTER, { estimate, config, occurrence }, now, { isEnabled, context: { triggerSource }, sendSmsFn });
  const estimateId = estimate.id;
  switch (result.status) {
    case "sent":
      return { estimateId, outcome: "sent", occurrence: occurrence!, messageId: result.messageId };
    case "blocked":
      return { estimateId, outcome: "blocked", reason: result.reason };
    case "failed":
      return { estimateId, outcome: "failed", error: result.error };
    case "lifecycle_failed":
      return { estimateId, outcome: "failed", error: `lifecycle_snapshot_failed: ${result.error}` };
    case "skipped_duplicate":
    case "skipped_disabled":
    case "not_due":
    case "quiet_hours":
      return { estimateId, outcome: result.status };
    default:
      // Unreachable under this kind's policy (no payment check, record_blocked missing subject, always owed); never a success.
      return { estimateId, outcome: "failed", error: `unexpected_touch_status:${result.status}` };
  }
}

async function expireEstimate(
  supabase: SupabaseClient,
  estimate: CandidateEstimate,
  triggerSource: EstimateRunTriggerSource = "event",
): Promise<FollowupOutcome> {
  const idempotencyKey = `estimate.expired:${estimate.id}`;

  const eventResult = await createAutomationEventAsService(supabase, estimate.organization_id, {
    eventType: "estimate.expired",
    entityType: "estimate",
    entityId: estimate.id,
    payload: { estimate_id: estimate.id },
    idempotencyKey,
  });

  if (!eventResult.ok) {
    return { estimateId: estimate.id, outcome: "failed", error: eventResult.error };
  }

  // Transition the estimate regardless of duplicate - if a prior tick
  // already recorded the event but crashed before the status update landed,
  // this still needs to happen; the update itself is naturally idempotent
  // (WHERE status = 'sent' guards against re-expiring an estimate a human
  // has since accepted/declined).
  await supabase
    .from("estimates")
    .update({ status: "expired" })
    .eq("id", estimate.id)
    .eq("status", "sent");

  if (eventResult.duplicate) {
    return { estimateId: estimate.id, outcome: "skipped_duplicate" };
  }
  // K5-2: the estimate has expired (the status update above ran); the
  // event was skipped because the automation is disabled or the
  // organization is paused, so there is no execution to log.
  if (eventResult.skipped) {
    return { estimateId: estimate.id, outcome: "expired" };
  }

  const executionResult = await startWorkflowExecutionAsService(
    supabase,
    eventResult.event.id,
    ESTIMATE_EXPIRED_WORKFLOW,
    {},
    triggerSource,
  );
  if (executionResult.ok) {
    await completeWorkflowExecutionAsService(supabase, executionResult.execution.id, {
      lifecycle_only: true,
      estimate_id: estimate.id,
    });
  }

  return { estimateId: estimate.id, outcome: "expired" };
}

export type FollowupPreview =
  | { outcome: "would_send"; estimateId: string; occurrence: 1 | 2; body: string }
  | { outcome: "would_expire"; estimateId: string }
  | { outcome: "no_candidates" }
  | { outcome: "no_contact"; estimateId: string }
  | { outcome: "contact_opted_out"; estimateId: string };

/**
 * Phase D dry run: a read-only preview, never a fake execution - see
 * previewAppointmentReminders in appointment-reminders.ts for the same
 * rationale. Mirrors processOneEstimate's per-candidate eligibility logic
 * (expiration check, then follow-up occurrence timing) but never creates an
 * automation_events/workflow_executions row, never updates estimates.status,
 * and never calls sendOutboundMessage, evaluateOutboundGate, or any
 * provider/n8n code path - this function does not import any of them.
 */
export async function previewEstimateFollowups(
  supabase: SupabaseClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<FollowupPreview> {
  const rawConfig = await getAutomationConfig(supabase, organizationId, "estimate-followup");
  const config = readEstimateFollowupConfig(rawConfig);

  // K5-5 (R-c): the organization's sent estimates, paged in a stable order -
  // no arbitrary 500-row cap. A failed read previews as "no candidates", as
  // the unpaged read always did.
  const read = await readAllPages<CandidateEstimate>(() =>
    supabase.from("estimates").select(CANDIDATE_COLUMNS).eq("organization_id", organizationId).in("status", ACTIVE_STATUSES).not("sent_at", "is", null).order("id"),
  );
  const candidates = read.failed ? [] : read.rows;

  for (const estimate of candidates) {
    if (estimate.expires_at && new Date(estimate.expires_at).getTime() <= now.getTime()) {
      return { outcome: "would_expire", estimateId: estimate.id };
    }

    const hoursSinceSent = (now.getTime() - new Date(estimate.sent_at).getTime()) / (60 * 60 * 1000);
    const occurrence = computeFollowupOccurrence(hoursSinceSent, config);

    if (!occurrence) continue;
    // K5-3: the run would skip a check-in more than 48 hours past due, so the preview does too.
    if (hoursLate(hoursSinceSent, occurrence, config) > STALE_FOLLOWUP_GRACE_HOURS) continue;

    if (!estimate.contact_id) {
      return { outcome: "no_contact", estimateId: estimate.id };
    }

    const { data: contact } = await supabase
      .from("contacts")
      .select("sms_opt_out")
      .eq("id", estimate.contact_id)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (contact?.sms_opt_out) {
      return { outcome: "contact_opted_out", estimateId: estimate.id };
    }

    return { outcome: "would_send", estimateId: estimate.id, occurrence, body: composeFollowupBody(estimate, occurrence) };
  }

  return { outcome: "no_candidates" };
}

/**
 * Phase E retry redispatch for a failed estimate_followup or
 * estimate_expired_lifecycle execution. Deliberately duplicates
 * sendFollowup/expireEstimate's post-event-creation tails rather than
 * refactoring those already-shipped functions to share code, to guarantee
 * zero behavior change to the existing cron path - see the Phase E report.
 * Uses the session-scoped completeWorkflowExecution/failWorkflowExecution
 * (not the AsService variants), since retry always runs with a real admin
 * session.
 *
 * Returns whether the retry handoff itself was successfully initiated -
 * NOT whether the underlying automation "eventually completed". A message
 * correctly BLOCKED by the outbound gate, or a normal lifecycle-only
 * expiration, is `{ ok: true }`: the retry mechanism did exactly what it
 * should. Only a genuine failure of the retry itself (missing reference,
 * entity no longer exists, missing occurrence, the send call failing) is
 * `{ ok: false }`.
 */
export async function retryEstimateWorkflow(
  supabase: SupabaseClient,
  event: { organizationId: string; entityType: string | null; entityId: string | null; payload: Record<string, unknown> },
  executionId: string,
  workflowName: "estimate_followup" | "estimate_expired_lifecycle",
  /** P0 A2: SERVICE_EXECUTION_OPS for the automatic retry; the session pair otherwise. */
  ops: ExecutionOps = SESSION_EXECUTION_OPS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const estimateId =
    event.entityType === "estimate"
      ? event.entityId
      : typeof event.payload?.estimate_id === "string"
        ? (event.payload.estimate_id as string)
        : null;

  if (!estimateId) {
    await ops.fail(supabase, executionId, "Missing estimate reference.");
    return { ok: false, error: "Missing estimate reference." };
  }

  const { data: estimate } = await supabase
    .from("estimates")
    .select("id, organization_id, contact_id, lead_id, title, status, sent_at, expires_at")
    .eq("id", estimateId)
    .eq("organization_id", event.organizationId)
    .maybeSingle();

  if (!estimate) {
    await ops.fail(supabase, executionId, "The estimate no longer exists.");
    return { ok: false, error: "The estimate no longer exists." };
  }

  if (workflowName === "estimate_expired_lifecycle") {
    await supabase.from("estimates").update({ status: "expired" }).eq("id", estimate.id).eq("status", "sent");
    await ops.complete(supabase, executionId, { lifecycle_only: true, estimate_id: estimate.id });
    return { ok: true };
  }

  // estimate_followup: reuse the occurrence already recorded on the
  // original event's payload (set once, at whichever check-in was actually
  // due) rather than recomputing it from elapsed time again, which could
  // have moved on to occurrence 2 by now and would then retry a different
  // message than the one that actually failed.
  const occurrence = event.payload?.occurrence === 1 || event.payload?.occurrence === 2 ? (event.payload.occurrence as 1 | 2) : null;
  if (!occurrence) {
    await ops.fail(supabase, executionId, "Missing follow-up occurrence.");
    return { ok: false, error: "Missing follow-up occurrence." };
  }

  // P0-B B2.5: the touch's retry runs the shared retry entry - subject +
  // B1 verification (an unknown lifecycle fails this execution), still owed,
  // then the shared gate/send spine with A2's ops. Cadence and lateness are
  // never re-evaluated on a retry.
  return retryDerivedTouch(supabase, ESTIMATE_FOLLOWUP_ADAPTER, { estimate: estimate as CandidateEstimate, config: null, occurrence }, executionId, ops);
}
