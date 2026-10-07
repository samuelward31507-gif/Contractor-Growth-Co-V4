import type { SupabaseClient } from "@supabase/supabase-js";
import {
  auditFieldViolation,
  auditRecordViolation,
  blockedOutcome,
  claimTouch,
  executeTouch,
  recordBlockedTouch,
  verifyLifecycle,
  EVENT_EXECUTION_CONTEXT,
  type AuditFields,
  type AuditRecordPolicy,
  type BlockedRecord,
  type ExecutionContext,
  type KindGateOptions,
  type LifecycleVerification,
  type TouchIdentity,
  type TouchResult,
} from "@/lib/followups/engine";
import { SERVICE_EXECUTION_OPS, type ExecutionOps } from "./executions";
import { hoursPastDue, isTouchOverdue } from "./late-touch";
import type { SendSmsInput, SendSmsResult } from "./sms";

/**
 * P0-B B2.4 / B2.5a: the shared touch runtime's DERIVED driver - work that
 * is a pure function of facts + time (no followups row). The kind's existing
 * scan stays its producer; each candidate it selects is a work item that
 * runs this fixed pipeline:
 *
 *   1. kill switch (the catalog automation's enabled state)
 *   2. organization payment         - when the kind's policy requires it
 *   3. still due                    - the kind's cadence (pure)
 *   4. soft claim                   - the touch's idempotency key already used?
 *   5. subject + lifecycle          - B1 snapshot, derived. An UNKNOWN
 *      lifecycle (failed read) fails closed: nothing recorded, still
 *      eligible. A KNOWN missing subject (the contact is not the
 *      organization's) follows the kind's missingSubject policy.
 *   6. still owed                   - the kind's own checks
 *   7. stale policy                 - more than 48h late: recorded, never sent
 *   8. claim                        - idempotency key + B0 atomic execution start,
 *                                     under the run's trigger source
 *   9. claimed verification         - the kind's live re-check of the CLAIMED
 *      touch (B2.7a): blocked -> recorded as a blocked execution (the event
 *      and execution stand, the key stays used); unknown -> the execution
 *      fails, nothing is sent; verified -> its facts, contact and lead are
 *      what the rest of the pipeline uses
 *  10. compose -> gate -> send -> record (the shared executor in
 *      lib/followups/engine.ts, the same one A4's persisted dispatcher uses),
 *      recorded under the kind's audit-record policy
 *
 * A2 retries of a derived touch (retryDerivedTouch) run steps 5, 6, 9 and 10
 * on the execution A2 already started.
 *
 * Everything kind-specific arrives through DerivedTouchAdapter: pure
 * functions of the work item and policy VALUES. The runtime never branches
 * on which kind it is running and never runs adapter-supplied control flow
 * between its steps. Business hours are enforced by the outbound gate
 * through the kind's gate options - a derived touch has nowhere to keep a
 * deferral.
 */

export type DerivedTouchSubject = {
  organizationId: string;
  /** The customer the touch is about - the B1 snapshot key. Null: nothing to load; the gate denies it. */
  contactId: string | null;
  /** The gate's lead; null for a non-lead subject. */
  leadId: string | null;
  /** The automation event's entity. */
  entityType: string;
  entityId: string;
};

export type StillOwed<Facts> = { owed: true; facts: Facts } | { owed: false; reason: string };

/**
 * Step 7. "none": the kind has no lateness (window-based). "record_blocked":
 * a touch more than 48 hours late is recorded as blocked 'followup_overdue'
 * under its own key (a later touch is unaffected), its execution carrying
 * the kind's audit fields - or, for the kinds that always recorded it that
 * way, its event payload.
 */
export type StalePolicy = { mode: "none" } | { mode: "record_blocked"; audit: "audit_fields" | "payload" };

/**
 * Step 5, a KNOWN missing subject. "record_blocked": the touch's key is
 * claimed and its execution recorded as blocked 'contact_not_found' - no
 * conversation, message, gate or send. "skip": nothing is recorded.
 */
export type MissingSubjectPolicy = "record_blocked" | "skip";

export type DerivedTouchPolicy = {
  /** Step 2: an organization whose payment is not active is skipped before anything else is read. */
  requiresActivePayment: boolean;
  stale: StalePolicy;
  missingSubject: MissingSubjectPolicy;
  /** Step 10: whether the gate itself re-checks the automation's enabled state. */
  gateChecksAutomationEnabled: boolean;
  senderType: "ai" | "system";
  /** How much every execution record of this kind may hold (engine.ts AuditRecordPolicy). */
  auditRecord: AuditRecordPolicy;
};

/**
 * Step 9's answer. "verified": the claimed touch still stands; `facts`,
 * `contactId` and `leadId` replace the pre-claim ones downstream. "blocked":
 * it must not be sent and is recorded as a blocked execution with `reason`
 * (and the kind's audit fields, or `auditFields` when given). "unknown": the
 * check could not establish the truth - the execution fails, nothing is sent.
 */
export type ClaimedVerification<Facts> =
  | { verdict: "verified"; facts: Facts; contactId: string | null; leadId: string | null }
  | { verdict: "blocked"; reason: string; auditFields?: AuditFields }
  | { verdict: "unknown"; error: string };

export type DerivedTouchAdapter<Item, Facts> = {
  identity: TouchIdentity;
  policy: DerivedTouchPolicy;
  subject: (item: Item) => DerivedTouchSubject;
  /** The kind's legacy idempotency key format. */
  idempotencyKey: (item: Item) => string;
  /** The kind's cadence: is this touch due at `now`. */
  isDue: (item: Item, now: Date) => boolean;
  /** When the touch became due: anchor + delay. */
  dueAt: (item: Item) => { anchorMs: number; delayMs: number };
  /** The kind's still-owed checks, after lifecycle verification; returns the live facts the message is composed from. */
  stillOwed: (service: SupabaseClient, item: Item, lifecycle: Extract<LifecycleVerification, { failed: false }>) => Promise<StillOwed<Facts>>;
  /** The touch's automation-event payload. `facts` is null only when the touch is recorded before still-owed ran (a known missing subject). */
  payload: (item: Item, facts: Facts | null) => Record<string, unknown>;
  compose: (item: Item, facts: Facts) => string;
  gateOptions: (item: Item, facts: Facts) => KindGateOptions;
  /** The ids recorded on every execution of this touch (flat scalars; never a runtime outcome field). */
  auditFields: (item: Item) => AuditFields;
  /** Step 9: the kind's live re-check of the already-claimed touch. It never sends and never authorizes - the gate still decides. */
  verifyClaimed: (service: SupabaseClient, item: Item, facts: Facts) => Promise<ClaimedVerification<Facts>>;
};

/** The verifyClaimed of a kind with nothing to re-check after the claim: the pre-claim facts and the subject's contact and lead stand. */
export function unchangedAfterClaim<Item, Facts>(subject: (item: Item) => DerivedTouchSubject): DerivedTouchAdapter<Item, Facts>["verifyClaimed"] {
  return async (_service, item, facts) => {
    const { contactId, leadId } = subject(item);
    return { verdict: "verified", facts, contactId, leadId };
  };
}

/** Step 9, with a thrown check treated as unknown (fail closed), never as verified. */
async function verifyClaimedTouch<Item, Facts>(service: SupabaseClient, adapter: DerivedTouchAdapter<Item, Facts>, item: Item, facts: Facts): Promise<ClaimedVerification<Facts>> {
  try {
    const verification = await adapter.verifyClaimed(service, item, facts);
    if (verification.verdict === "verified" || verification.verdict === "blocked" || verification.verdict === "unknown") return verification;
    return { verdict: "unknown", error: "claimed_verification_unrecognised" };
  } catch (error) {
    return { verdict: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
}

export const CLAIMED_VERIFICATION_FAILED = "claimed_verification_failed";

export type DerivedTouchResult =
  | { status: "skipped_disabled" }
  | { status: "payment_inactive" }
  | { status: "not_due" }
  | { status: "skipped_duplicate" }
  | { status: "subject_missing" }
  | { status: "lifecycle_failed"; error: string }
  | { status: "not_owed"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "failed"; error: string }
  | { status: "sent"; messageId: string };

export type DerivedTouchDeps = {
  isEnabled: (organizationId: string) => Promise<boolean>;
  /** How the run was initiated; the cron/event path when omitted. */
  context?: ExecutionContext;
  /** Test seam only - production callers never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>;
};

/** The reason a known-missing subject is recorded under - the outbound gate's own reason for the same fact. */
export const SUBJECT_MISSING_REASON = "contact_not_found";

/**
 * Step 5's classification. B1's loader reports a contact that is not the
 * organization's with the stable code "contact_not_found" (its only
 * non-read-failure failure); every other failure is an unknown lifecycle.
 * Anything unrecognised is treated as unknown - the fail-closed direction.
 */
export type SubjectResolution = { kind: "verified"; lifecycle: Extract<LifecycleVerification, { failed: false }> } | { kind: "unknown"; error: string } | { kind: "missing" };

export async function resolveSubject(service: SupabaseClient, subject: DerivedTouchSubject, now: Date): Promise<SubjectResolution> {
  const lifecycle = await verifyLifecycle(service, subject.organizationId, subject.contactId, now);
  if (!lifecycle.failed) return { kind: "verified", lifecycle };
  return lifecycle.error === SUBJECT_MISSING_REASON ? { kind: "missing" } : { kind: "unknown", error: lifecycle.error };
}

function blockedResult(recorded: BlockedRecord): DerivedTouchResult {
  if (recorded.status === "blocked") return { status: "blocked", reason: recorded.reason };
  if (recorded.status === "duplicate") return { status: "skipped_duplicate" };
  if (recorded.status === "skipped") return { status: "skipped_disabled" };
  return { status: "failed", error: recorded.error };
}

async function claimDerivedTouch<Item, Facts>(
  service: SupabaseClient,
  adapter: DerivedTouchAdapter<Item, Facts>,
  item: Item,
  now: Date,
  deps: DerivedTouchDeps,
  startMetadata: Record<string, unknown>,
): Promise<DerivedTouchClaim<Facts>> {
  const context = deps.context ?? EVENT_EXECUTION_CONTEXT;
  const subject = adapter.subject(item);
  const { organizationId } = subject;

  if (!(await deps.isEnabled(organizationId))) return { claimed: false, result: { status: "skipped_disabled" } };

  if (adapter.policy.requiresActivePayment) {
    const { data: organization } = await service.from("organizations").select("payment_status").eq("id", organizationId).maybeSingle();
    if (organization?.payment_status !== "active") return { claimed: false, result: { status: "payment_inactive" } };
  }

  if (!adapter.isDue(item, now)) return { claimed: false, result: { status: "not_due" } };

  const auditFields = adapter.auditFields(item);
  const violation = auditFieldViolation(auditFields);
  if (violation) return { claimed: false, result: { status: "failed", error: `audit_field_rejected:${violation}` } };
  const record = adapter.policy.auditRecord;
  const policyViolation = auditRecordViolation(record);
  if (policyViolation) return { claimed: false, result: { status: "failed", error: policyViolation } };

  // Soft claim - an optimization only; the race-proof guarantee is the key's unique index at step 8.
  const idempotencyKey = adapter.idempotencyKey(item);
  const { data: existingEvent } = await service.from("automation_events").select("id").eq("organization_id", organizationId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existingEvent) return { claimed: false, result: { status: "skipped_duplicate" } };

  const touch = (payload: Record<string, unknown>) => ({ entityType: subject.entityType, entityId: subject.entityId, payload, idempotencyKey });

  const resolution = await resolveSubject(service, subject, now);
  if (resolution.kind === "unknown") return { claimed: false, result: { status: "lifecycle_failed", error: resolution.error } };
  if (resolution.kind === "missing") {
    if (adapter.policy.missingSubject === "skip") return { claimed: false, result: { status: "subject_missing" } };
    return { claimed: false, result: blockedResult(await recordBlockedTouch(service, adapter.identity, organizationId, touch(adapter.payload(item, null)), context, { reason: SUBJECT_MISSING_REASON, detail: null }, auditFields, record)) };
  }

  const owed = await adapter.stillOwed(service, item, resolution.lifecycle);
  if (!owed.owed) return { claimed: false, result: { status: "not_owed", reason: owed.reason } };
  const { facts } = owed;
  const payload = adapter.payload(item, facts);

  const stale = adapter.policy.stale;
  if (stale.mode === "record_blocked") {
    const { anchorMs, delayMs } = adapter.dueAt(item);
    const lateHours = hoursPastDue(now.getTime(), anchorMs, delayMs);
    if (isTouchOverdue(lateHours)) {
      const fields = stale.audit === "payload" ? payload : auditFields;
      return { claimed: false, result: blockedResult(await recordBlockedTouch(service, adapter.identity, organizationId, touch(payload), context, { reason: "followup_overdue", detail: `${Math.floor(lateHours)} hours past due` }, fields, record)) };
    }
  }

  const recorded = await claimTouch(service, adapter.identity, organizationId, touch(payload), context, startMetadata);
  if (recorded.status === "error" || recorded.status === "start_failed") return { claimed: false, result: { status: "failed", error: recorded.error } };
  if (recorded.status === "duplicate") return { claimed: false, result: { status: "skipped_duplicate" } };
  if (recorded.status === "skipped") return { claimed: false, result: { status: "skipped_disabled" } };

  return { claimed: true, touch: { organizationId, subject, facts, auditFields, record, executionId: recorded.executionId, eventId: recorded.eventId } };
}

/** Steps 1-8's outcome: the touch's final result, or the touch claimed by this run (its key used, its execution started). */
type ClaimedDerivedTouch<Facts> = {
  organizationId: string;
  subject: DerivedTouchSubject;
  facts: Facts;
  auditFields: AuditFields;
  record: AuditRecordPolicy;
  executionId: string;
  eventId: string;
};
type DerivedTouchClaim<Facts> = { claimed: false; result: DerivedTouchResult } | { claimed: true; touch: ClaimedDerivedTouch<Facts> };

/**
 * The post-claim spine every claimed touch runs - on its first run, on A2's
 * retry and when resumed with a draft: step 9 (claimed verification), then
 * step 10 (the shared executor: gate -> send -> record). `bodyFor` is the
 * only thing that differs: the kind's own composition, or a resumed draft.
 */
type ClaimedOutcome =
  | { kind: "verification_unknown"; error: string }
  | { kind: "audit_rejected"; error: string }
  | { kind: "claimed_blocked"; reason: string }
  /** P0-B B2.8c: the subject is gone or the touch is no longer owed - recorded blocked. */
  | { kind: "lifecycle_blocked"; reason: string }
  /** P0-B B2.8c: a resumed draft that declines or asks for a person - recorded blocked after lifecycle and verification. */
  | { kind: "draft_blocked"; reason: string }
  | TouchResult;

async function finishClaimedTouch<Item, Facts>(
  supabase: SupabaseClient,
  adapter: DerivedTouchAdapter<Item, Facts>,
  item: Item,
  facts: Facts,
  claim: {
    organizationId: string;
    executionId: string;
    ops: ExecutionOps;
    auditFields: AuditFields;
    record: AuditRecordPolicy;
    bodyFor: (facts: Facts) => string;
    /** A resumed draft's own decision not to send (declined / needs a person), applied once the touch is verified - never before. */
    draftBlock?: string | null;
    sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>;
  },
): Promise<ClaimedOutcome> {
  const { executionId, ops, auditFields, record } = claim;
  const claimed = await verifyClaimedTouch(supabase, adapter, item, facts);
  if (claimed.verdict === "unknown") {
    const error = `${CLAIMED_VERIFICATION_FAILED}: ${claimed.error}`;
    await ops.fail(supabase, executionId, error);
    return { kind: "verification_unknown", error };
  }
  if (claimed.verdict === "blocked") {
    const blockedFields = claimed.auditFields ?? auditFields;
    const blockedViolation = auditFieldViolation(blockedFields);
    if (blockedViolation) {
      const error = `audit_field_rejected:${blockedViolation}`;
      await ops.fail(supabase, executionId, error);
      return { kind: "audit_rejected", error };
    }
    await ops.complete(supabase, executionId, { ...blockedOutcome(record, claimed.reason, null), ...blockedFields });
    return { kind: "claimed_blocked", reason: claimed.reason };
  }
  if (claim.draftBlock) {
    await ops.complete(supabase, executionId, { ...blockedOutcome(record, claim.draftBlock, null), ...auditFields });
    return { kind: "draft_blocked", reason: claim.draftBlock };
  }

  return executeTouch(
    supabase,
    {
      organizationId: claim.organizationId,
      contactId: claimed.contactId,
      leadId: claimed.leadId,
      body: claim.bodyFor(claimed.facts),
      gateOptions: adapter.gateOptions(item, claimed.facts),
      gateAutomationId: adapter.policy.gateChecksAutomationEnabled ? adapter.identity.automationId : null,
      senderType: adapter.policy.senderType,
      auditFields,
      auditRecord: record,
    },
    executionId,
    ops,
    claim.sendSmsFn,
  );
}

export async function runDerivedTouch<Item, Facts>(service: SupabaseClient, adapter: DerivedTouchAdapter<Item, Facts>, item: Item, now: Date, deps: DerivedTouchDeps): Promise<DerivedTouchResult> {
  const claim = await claimDerivedTouch(service, adapter, item, now, deps, {});
  if (!claim.claimed) return claim.result;
  const { organizationId, facts, auditFields, record, executionId } = claim.touch;

  // Steps 9-10: only now - the touch is claimed, its key used, its execution started.
  const result = await finishClaimedTouch(service, adapter, item, facts, {
    organizationId,
    executionId,
    ops: SERVICE_EXECUTION_OPS,
    auditFields,
    record,
    bodyFor: (verified) => adapter.compose(item, verified),
    sendSmsFn: deps.sendSmsFn,
  });
  if (result.kind === "verification_unknown" || result.kind === "audit_rejected") return { status: "failed", error: result.error };
  if (result.kind === "claimed_blocked") return { status: "blocked", reason: result.reason };
  // Unreachable on a first run: lifecycle and draft blocks come only from a resumed/retried execution's spine.
  if (result.kind === "lifecycle_blocked" || result.kind === "draft_blocked") return { status: "blocked", reason: result.reason };
  if (result.kind === "sent") return { status: "sent", messageId: result.messageId };
  if (result.kind === "blocked") return { status: "blocked", reason: result.reason };
  // Unreachable: this run claimed the execution alone (B0).
  if (result.kind === "duplicate_in_progress") return { status: "skipped_duplicate" };
  return { status: "failed", error: result.error };
}

/**
 * Steps 5-6 then 9-10 on an execution that already exists (A2's retry
 * execution, or a handed-off execution resumed with a draft): subject + B1
 * (an unknown lifecycle fails the execution - never a send on a failed
 * read; a known-missing subject is closed as blocked), still owed (closed
 * as blocked when no longer owed), then the post-claim spine.
 */
async function runClaimedSpine<Item, Facts>(
  supabase: SupabaseClient,
  adapter: DerivedTouchAdapter<Item, Facts>,
  item: Item,
  now: Date,
  claim: { executionId: string; ops: ExecutionOps; auditFields: AuditFields; record: AuditRecordPolicy; bodyFor: (facts: Facts) => string; draftBlock?: string | null; sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult> },
): Promise<ClaimedOutcome | { kind: "lifecycle_failed" }> {
  const { executionId, ops, auditFields, record } = claim;
  const subject = adapter.subject(item);

  const resolution = await resolveSubject(supabase, subject, now);
  if (resolution.kind === "unknown") {
    await ops.fail(supabase, executionId, `lifecycle_snapshot_failed: ${resolution.error}`);
    return { kind: "lifecycle_failed" };
  }
  if (resolution.kind === "missing") {
    await ops.complete(supabase, executionId, { ...blockedOutcome(record, SUBJECT_MISSING_REASON, null), ...auditFields });
    return { kind: "lifecycle_blocked", reason: SUBJECT_MISSING_REASON };
  }

  const owed = await adapter.stillOwed(supabase, item, resolution.lifecycle);
  if (!owed.owed) {
    await ops.complete(supabase, executionId, { ...blockedOutcome(record, owed.reason, null), ...auditFields });
    return { kind: "lifecycle_blocked", reason: owed.reason };
  }

  // The existing execution is the claim: the same claimed verification applies.
  return finishClaimedTouch(supabase, adapter, item, owed.facts, { organizationId: subject.organizationId, ...claim });
}

/**
 * The shared A2 retry of a derived touch. A2 has already decided the retry
 * is allowed, accounted the attempt and started the new execution
 * (trigger_source 'retry') on the touch's original event - so the key,
 * occurrence and B0 claim are A2's, untouched. The kind's retry wrapper
 * rebuilds the work item from that event; this runs, on `executionId`:
 * subject + lifecycle (an unknown lifecycle fails the execution - never a
 * resend on a failed read), still owed, then the shared executor - with
 * A2's `ops` (session pair for a manual retry, service pair for the
 * automatic one). No stale check: a retry re-attempts the touch A2 chose.
 * The execution already exists, so a known-missing subject or a touch no
 * longer owed is always closed as blocked, whatever the kind's
 * missingSubject policy (that policy only decides whether a NEW record is
 * made).
 */
export async function retryDerivedTouch<Item, Facts>(
  supabase: SupabaseClient,
  adapter: DerivedTouchAdapter<Item, Facts>,
  item: Item,
  executionId: string,
  ops: ExecutionOps,
  now: Date = new Date(),
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auditFields = adapter.auditFields(item);
  const violation = auditFieldViolation(auditFields) ?? auditRecordViolation(adapter.policy.auditRecord);
  if (violation) {
    const error = violation.startsWith("audit_record") ? violation : `audit_field_rejected:${violation}`;
    await ops.fail(supabase, executionId, error);
    return { ok: false, error };
  }
  const record = adapter.policy.auditRecord;

  const result = await runClaimedSpine(supabase, adapter, item, now, { executionId, ops, auditFields, record, bodyFor: (facts) => adapter.compose(item, facts), sendSmsFn });
  if (result.kind === "lifecycle_failed") return { ok: false, error: "lifecycle_snapshot_failed" };
  if (result.kind === "verification_unknown") return { ok: false, error: CLAIMED_VERIFICATION_FAILED };
  if (result.kind === "audit_rejected" || result.kind === "failed") return { ok: false, error: result.error };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// P0-B B2.8a: the draft hand-off contract (the n8n executor's foundation).
//
// A kind whose message is drafted outside Trackpr (n8n) runs the SAME
// pipeline split at the claim:
//
//   claimAndHandOffTouch  steps 1-8 (kill switch, payment, due, soft claim,
//                         B1, still owed, stale, claim = key + B0 start), the
//                         execution started with DRAFT_HANDOFF_METADATA, then
//                         the kind's hand-off (the n8n dispatch).
//   resumeClaimedTouch    when the draft returns: the execution, its event
//                         and the kind's subject are re-validated against
//                         Trackpr's own rows, then steps 5-6 and 9-10 run
//                         again on that execution - B1, still owed, claimed
//                         verification, the outbound gate, the send, the
//                         record - with the draft as the body.
//
// The draft is never an authorization: it carries only a body and a
// needs-human signal. Recipient, organization, lifecycle, payment,
// automation state, gate result and retry stay Trackpr's - there is no field
// for any of them. No existing kind uses this yet.
// ---------------------------------------------------------------------------

/** Marks an execution started for a draft hand-off. Only such an execution can be resumed with a draft. */
export const DRAFT_HANDOFF_METADATA: Readonly<{ handoff: "n8n_draft" }> = { handoff: "n8n_draft" };

/** What the kind's hand-off receives: identifiers only - everything else it needs is Trackpr's to read. */
export type DraftRequest = { organizationId: string; automationId: string; workflowName: string; eventId: string; executionId: string };
export type DraftHandOff = (request: DraftRequest) => Promise<{ ok: true } | { ok: false; error: string }>;

export type HandOffResult =
  /** Claimed by this run; drafting is now the drafter's - the execution stays running until resumed (or timed out). */
  | { status: "handed_off"; executionId: string; eventId: string }
  /** The touch's key was already used: nothing new was claimed. */
  | { status: "already_processed" }
  /** A business decision, recorded (stale, known-missing subject). */
  | { status: "blocked"; reason: string }
  /** Not this run's to claim; nothing recorded. */
  | { status: "unavailable"; reason: "skipped_disabled" | "payment_inactive" | "not_due" | "subject_missing" | "not_owed"; detail: string | null }
  /** A technical failure. `recorded`: the claimed execution was failed (the hand-off itself failed). */
  | { status: "failed"; error: string; recorded: boolean };

export const DRAFT_HANDOFF_FAILED = "draft_handoff_failed";

function handOffResultOf(result: DerivedTouchResult): HandOffResult {
  switch (result.status) {
    case "skipped_duplicate":
      return { status: "already_processed" };
    case "blocked":
      return { status: "blocked", reason: result.reason };
    case "skipped_disabled":
    case "payment_inactive":
    case "not_due":
    case "subject_missing":
      return { status: "unavailable", reason: result.status, detail: null };
    case "not_owed":
      return { status: "unavailable", reason: "not_owed", detail: result.reason };
    case "lifecycle_failed":
      return { status: "failed", error: `lifecycle_snapshot_failed: ${result.error}`, recorded: false };
    case "failed":
      return { status: "failed", error: result.error, recorded: false };
    case "sent":
      // Unreachable: nothing is composed or sent before the claim.
      return { status: "failed", error: "unexpected_send_before_draft", recorded: false };
  }
}

export async function claimAndHandOffTouch<Item, Facts>(
  service: SupabaseClient,
  adapter: DerivedTouchAdapter<Item, Facts>,
  item: Item,
  now: Date,
  deps: DerivedTouchDeps,
  handOff: DraftHandOff,
): Promise<HandOffResult> {
  const claim = await claimDerivedTouch(service, adapter, item, now, deps, { ...DRAFT_HANDOFF_METADATA });
  if (!claim.claimed) return handOffResultOf(claim.result);
  const { organizationId, executionId, eventId } = claim.touch;

  let handed: { ok: true } | { ok: false; error: string };
  try {
    handed = await handOff({ organizationId, automationId: adapter.identity.automationId, workflowName: adapter.identity.workflowName, eventId, executionId });
  } catch (error) {
    handed = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!handed.ok) {
    const error = `${DRAFT_HANDOFF_FAILED}: ${handed.error}`;
    await SERVICE_EXECUTION_OPS.fail(service, executionId, error, "n8n_dispatch_failed");
    return { status: "failed", error, recorded: true };
  }
  return { status: "handed_off", executionId, eventId };
}

/** The runtime's view of a returned draft: advisory only. A body to compose from, and whether the drafter asks for a person. */
export type TouchDraft = { body: string | null; needsHuman: boolean };
export const DRAFT_MAX_LENGTH = 1600;

export type ResumeInput<Item> = {
  executionId: string;
  eventId: string;
  organizationId: string;
  automationId: string;
  /** The kind's work item, rebuilt by the kind from Trackpr's own rows - its subject and key must be the claimed execution's. */
  item: Item;
  draft: TouchDraft;
};

export type ResumeRejection = "automation_mismatch" | "organization_mismatch" | "execution_not_found" | "event_mismatch" | "workflow_mismatch" | "subject_mismatch" | "not_handed_off";

/**
 * Where a resumed touch was blocked (P0-B B2.8c): the subject or the touch
 * no longer stands ("lifecycle"), the kind's claimed verification ("verification"),
 * the draft itself ("draft") or the outbound gate ("gate").
 */
export type ResumeBlockStage = "lifecycle" | "verification" | "draft" | "gate";

export type ResumeResult =
  | { status: "sent"; messageId: string }
  /** A business decision, recorded on the execution (gate, lifecycle, still-owed, verification, a declined or needs-human draft). */
  | { status: "blocked"; reason: string; stage: ResumeBlockStage }
  /** The execution is no longer running, or another request already owns its send - nothing done. */
  | { status: "already_processed" }
  /** The request does not match a handed-off execution Trackpr owns - nothing read beyond it, nothing recorded. */
  | { status: "rejected"; reason: ResumeRejection }
  /** A technical failure, recorded on the execution. */
  | { status: "failed"; error: string };

export const DRAFT_DECLINED = "draft_declined";
export const DRAFT_NEEDS_HUMAN = "needs_human";
export const DRAFT_INVALID = "draft_invalid";

/** Why a draft is unusable, or null. The body is checked for shape only - its content is the gate's to judge. */
export function draftViolation(draft: unknown): string | null {
  if (!draft || typeof draft !== "object") return "draft_missing";
  const { body, needsHuman } = draft as { body?: unknown; needsHuman?: unknown };
  if (typeof needsHuman !== "boolean") return "needs_human_not_boolean";
  if (body === null) return null;
  if (typeof body !== "string" || body.trim().length === 0) return "body_not_text";
  if (body.length > DRAFT_MAX_LENGTH) return "body_too_long";
  return null;
}

/**
 * Re-validates a resume (or failure) request against Trackpr's own rows: the
 * kind, the organization, the execution and its event, the workflow, the
 * subject's key and the hand-off marker. Null when the execution is a
 * running, handed-off execution of this kind and subject.
 */
async function handedOffExecutionMismatch<Item, Facts>(service: SupabaseClient, adapter: DerivedTouchAdapter<Item, Facts>, input: Omit<ResumeInput<Item>, "draft">): Promise<ResumeResult | null> {
  const rejected = (reason: ResumeRejection): ResumeResult => ({ status: "rejected", reason });
  const { identity } = adapter;
  if (input.automationId !== identity.automationId) return rejected("automation_mismatch");
  if (adapter.subject(input.item).organizationId !== input.organizationId) return rejected("organization_mismatch");

  // The execution and its event, as Trackpr recorded them - never as the request describes them.
  const { data: execution } = await service.from("workflow_executions").select("id, organization_id, automation_event_id, workflow_name, status, metadata").eq("id", input.executionId).maybeSingle();
  if (!execution) return rejected("execution_not_found");
  if (execution.organization_id !== input.organizationId) return rejected("organization_mismatch");
  if (execution.automation_event_id !== input.eventId) return rejected("event_mismatch");
  if (execution.workflow_name !== identity.workflowName) return rejected("workflow_mismatch");
  const { data: event } = await service.from("automation_events").select("id, organization_id, event_type, idempotency_key").eq("id", input.eventId).maybeSingle();
  if (!event || event.organization_id !== input.organizationId) return rejected("event_mismatch");
  if (event.event_type !== identity.eventType) return rejected("automation_mismatch");
  if (event.idempotency_key !== adapter.idempotencyKey(input.item)) return rejected("subject_mismatch");
  if (execution.status !== "running") return { status: "already_processed" };
  if ((execution.metadata as { handoff?: unknown } | null)?.handoff !== DRAFT_HANDOFF_METADATA.handoff) return rejected("not_handed_off");
  return null;
}

export async function resumeClaimedTouch<Item, Facts>(
  service: SupabaseClient,
  adapter: DerivedTouchAdapter<Item, Facts>,
  input: ResumeInput<Item>,
  now: Date = new Date(),
  /** Test seam only - production callers never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<ResumeResult> {
  const mismatch = await handedOffExecutionMismatch(service, adapter, input);
  if (mismatch) return mismatch;

  const ops = SERVICE_EXECUTION_OPS;
  const executionId = input.executionId;
  const auditFields = adapter.auditFields(input.item);
  const violation = auditFieldViolation(auditFields) ?? auditRecordViolation(adapter.policy.auditRecord);
  if (violation) {
    const error = violation.startsWith("audit_record") ? violation : `audit_field_rejected:${violation}`;
    await ops.fail(service, executionId, error);
    return { status: "failed", error };
  }
  const record = adapter.policy.auditRecord;

  const draftError = draftViolation(input.draft);
  if (draftError) {
    const error = `${DRAFT_INVALID}: ${draftError}`;
    await ops.fail(service, executionId, error);
    return { status: "failed", error };
  }
  // P0-B B2.8c: the draft's own decision not to send is applied after lifecycle and verification
  // (the touch's truth first), never instead of them.
  const draftBlock = input.draft.needsHuman ? DRAFT_NEEDS_HUMAN : input.draft.body === null ? DRAFT_DECLINED : null;
  const body = input.draft.body ?? "";

  const result = await runClaimedSpine(service, adapter, input.item, now, { executionId, ops, auditFields, record, bodyFor: () => body, draftBlock, sendSmsFn });
  switch (result.kind) {
    case "sent":
      return { status: "sent", messageId: result.messageId };
    case "blocked":
      return { status: "blocked", reason: result.reason, stage: "gate" };
    case "lifecycle_blocked":
      return { status: "blocked", reason: result.reason, stage: "lifecycle" };
    case "claimed_blocked":
      return { status: "blocked", reason: result.reason, stage: "verification" };
    case "draft_blocked":
      return { status: "blocked", reason: result.reason, stage: "draft" };
    case "duplicate_in_progress":
      return { status: "already_processed" };
    case "lifecycle_failed":
      return { status: "failed", error: "lifecycle_snapshot_failed" };
    case "verification_unknown":
    case "audit_rejected":
    case "failed":
      return { status: "failed", error: result.error };
  }
}

/**
 * P0-B B2.8c: the drafter could not produce a usable draft (an AI failure,
 * or a callback that fails the strict draft contract) for a handed-off
 * execution. After the same re-validation as resumeClaimedTouch, the
 * execution FAILS with `error` - an AI failure is never recorded as a
 * human-required or declined decision, and nothing is sent.
 */
export async function failHandedOffTouch<Item, Facts>(service: SupabaseClient, adapter: DerivedTouchAdapter<Item, Facts>, input: Omit<ResumeInput<Item>, "draft">, error: string): Promise<ResumeResult> {
  const mismatch = await handedOffExecutionMismatch(service, adapter, input);
  if (mismatch) return mismatch;
  await SERVICE_EXECUTION_OPS.fail(service, input.executionId, error);
  return { status: "failed", error };
}
