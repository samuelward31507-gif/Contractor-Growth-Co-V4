import type { SupabaseClient } from "@supabase/supabase-js";
import {
  auditFieldViolation,
  claimTouch,
  executeTouch,
  recordBlockedTouch,
  verifyLifecycle,
  EVENT_EXECUTION_CONTEXT,
  type AuditFields,
  type BlockedRecord,
  type ExecutionContext,
  type KindGateOptions,
  type LifecycleVerification,
  type TouchIdentity,
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
 *   9. compose -> gate -> send -> record (the shared executor in
 *      lib/followups/engine.ts, the same one A4's persisted dispatcher uses)
 *
 * A2 retries of a derived touch (retryDerivedTouch) run steps 5, 6 and 9 on
 * the execution A2 already started.
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
  /** Step 9: whether the gate itself re-checks the automation's enabled state. */
  gateChecksAutomationEnabled: boolean;
  senderType: "ai" | "system";
};

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
};

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

export async function runDerivedTouch<Item, Facts>(service: SupabaseClient, adapter: DerivedTouchAdapter<Item, Facts>, item: Item, now: Date, deps: DerivedTouchDeps): Promise<DerivedTouchResult> {
  const context = deps.context ?? EVENT_EXECUTION_CONTEXT;
  const subject = adapter.subject(item);
  const { organizationId } = subject;

  if (!(await deps.isEnabled(organizationId))) return { status: "skipped_disabled" };

  if (adapter.policy.requiresActivePayment) {
    const { data: organization } = await service.from("organizations").select("payment_status").eq("id", organizationId).maybeSingle();
    if (organization?.payment_status !== "active") return { status: "payment_inactive" };
  }

  if (!adapter.isDue(item, now)) return { status: "not_due" };

  const auditFields = adapter.auditFields(item);
  const violation = auditFieldViolation(auditFields);
  if (violation) return { status: "failed", error: `audit_field_rejected:${violation}` };

  // Soft claim - an optimization only; the race-proof guarantee is the key's unique index at step 8.
  const idempotencyKey = adapter.idempotencyKey(item);
  const { data: existingEvent } = await service.from("automation_events").select("id").eq("organization_id", organizationId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existingEvent) return { status: "skipped_duplicate" };

  const touch = (payload: Record<string, unknown>) => ({ entityType: subject.entityType, entityId: subject.entityId, payload, idempotencyKey });

  const resolution = await resolveSubject(service, subject, now);
  if (resolution.kind === "unknown") return { status: "lifecycle_failed", error: resolution.error };
  if (resolution.kind === "missing") {
    if (adapter.policy.missingSubject === "skip") return { status: "subject_missing" };
    return blockedResult(await recordBlockedTouch(service, adapter.identity, organizationId, touch(adapter.payload(item, null)), context, { reason: SUBJECT_MISSING_REASON, detail: null }, auditFields));
  }

  const owed = await adapter.stillOwed(service, item, resolution.lifecycle);
  if (!owed.owed) return { status: "not_owed", reason: owed.reason };
  const { facts } = owed;
  const payload = adapter.payload(item, facts);

  const stale = adapter.policy.stale;
  if (stale.mode === "record_blocked") {
    const { anchorMs, delayMs } = adapter.dueAt(item);
    const lateHours = hoursPastDue(now.getTime(), anchorMs, delayMs);
    if (isTouchOverdue(lateHours)) {
      const fields = stale.audit === "payload" ? payload : auditFields;
      return blockedResult(await recordBlockedTouch(service, adapter.identity, organizationId, touch(payload), context, { reason: "followup_overdue", detail: `${Math.floor(lateHours)} hours past due` }, fields));
    }
  }

  const recorded = await claimTouch(service, adapter.identity, organizationId, touch(payload), context);
  if (recorded.status === "error" || recorded.status === "start_failed") return { status: "failed", error: recorded.error };
  if (recorded.status === "duplicate") return { status: "skipped_duplicate" };
  if (recorded.status === "skipped") return { status: "skipped_disabled" };

  const result = await executeTouch(
    service,
    {
      organizationId,
      contactId: subject.contactId,
      leadId: subject.leadId,
      body: adapter.compose(item, facts),
      gateOptions: adapter.gateOptions(item, facts),
      gateAutomationId: adapter.policy.gateChecksAutomationEnabled ? adapter.identity.automationId : null,
      senderType: adapter.policy.senderType,
      auditFields,
    },
    recorded.executionId,
    SERVICE_EXECUTION_OPS,
    deps.sendSmsFn,
  );
  if (result.kind === "sent") return { status: "sent", messageId: result.messageId };
  if (result.kind === "blocked") return { status: "blocked", reason: result.reason };
  return { status: "failed", error: result.error };
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
  const subject = adapter.subject(item);
  const auditFields = adapter.auditFields(item);
  const violation = auditFieldViolation(auditFields);
  if (violation) {
    await ops.fail(supabase, executionId, `audit_field_rejected:${violation}`);
    return { ok: false, error: `audit_field_rejected:${violation}` };
  }

  const resolution = await resolveSubject(supabase, subject, now);
  if (resolution.kind === "unknown") {
    await ops.fail(supabase, executionId, `lifecycle_snapshot_failed: ${resolution.error}`);
    return { ok: false, error: "lifecycle_snapshot_failed" };
  }
  if (resolution.kind === "missing") {
    await ops.complete(supabase, executionId, { should_send: false, blocked_reason: SUBJECT_MISSING_REASON, blocked_detail: null, ...auditFields });
    return { ok: true };
  }

  const owed = await adapter.stillOwed(supabase, item, resolution.lifecycle);
  if (!owed.owed) {
    await ops.complete(supabase, executionId, { should_send: false, blocked_reason: owed.reason, blocked_detail: null, ...auditFields });
    return { ok: true };
  }

  const result = await executeTouch(
    supabase,
    {
      organizationId: subject.organizationId,
      contactId: subject.contactId,
      leadId: subject.leadId,
      body: adapter.compose(item, owed.facts),
      gateOptions: adapter.gateOptions(item, owed.facts),
      gateAutomationId: adapter.policy.gateChecksAutomationEnabled ? adapter.identity.automationId : null,
      senderType: adapter.policy.senderType,
      auditFields,
    },
    executionId,
    ops,
    sendSmsFn,
  );
  return result.kind === "failed" ? { ok: false, error: result.error } : { ok: true };
}
