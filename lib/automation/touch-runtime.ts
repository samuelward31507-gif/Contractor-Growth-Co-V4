import type { SupabaseClient } from "@supabase/supabase-js";
import { claimTouch, executeTouch, verifyLifecycle, type KindGateOptions, type LifecycleVerification, type TouchIdentity } from "@/lib/followups/engine";
import { SERVICE_EXECUTION_OPS } from "./executions";
import { hoursPastDue, isTouchOverdue, recordOverdueTouch } from "./late-touch";
import type { SendSmsInput, SendSmsResult } from "./sms";

/**
 * P0-B B2.4: the shared touch runtime's DERIVED driver - work that is a
 * pure function of facts + time (no followups row). The kind's existing
 * scan stays its producer; each candidate it selects is a work item that
 * runs this fixed pipeline:
 *
 *   1. kill switch (the catalog automation's enabled state)
 *   2. organization payment         - when the kind's policy requires it
 *   3. still due                    - the kind's cadence (pure)
 *   4. soft claim                   - the touch's idempotency key already used?
 *   5. lifecycle verification       - B1 snapshot, derived; FAILS CLOSED
 *   6. still owed                   - the kind's own checks
 *   7. stale policy                 - more than 48h late: recorded, never sent
 *   8. claim                        - idempotency key + B0 atomic execution start
 *   9. compose -> gate -> send -> record (the shared executor in
 *      lib/followups/engine.ts, the same one A4's persisted dispatcher uses)
 *
 * Everything kind-specific arrives through DerivedTouchAdapter: pure
 * functions of the work item and policy VALUES. The runtime never branches
 * on which kind it is running and never runs adapter-supplied control flow
 * between its steps. Retry stays A2's (by workflow name); business hours
 * are enforced by the outbound gate through the kind's gate options - a
 * derived touch has nowhere to keep a deferral.
 */

export type DerivedTouchSubject = {
  organizationId: string;
  /** The customer the touch is about - the B1 snapshot key. */
  contactId: string;
  /** The gate's lead; null for a non-lead subject. */
  leadId: string | null;
  /** The automation event's entity. */
  entityType: string;
  entityId: string;
};

export type StillOwed<Facts> = { owed: true; facts: Facts } | { owed: false; reason: string };

export type DerivedTouchPolicy = {
  /** Step 2: an organization whose payment is not active is skipped before anything else is read. */
  requiresActivePayment: boolean;
  /** Step 7: a touch more than 48 hours late is recorded as blocked 'followup_overdue' (its key is used; a later touch is unaffected). */
  stale: "record_overdue";
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
  payload: (item: Item, facts: Facts) => Record<string, unknown>;
  compose: (item: Item, facts: Facts) => string;
  gateOptions: (item: Item, facts: Facts) => KindGateOptions;
  resultMetadata: (item: Item, facts: Facts) => Record<string, unknown>;
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
  /** Test seam only - production callers never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>;
};

export async function runDerivedTouch<Item, Facts>(service: SupabaseClient, adapter: DerivedTouchAdapter<Item, Facts>, item: Item, now: Date, deps: DerivedTouchDeps): Promise<DerivedTouchResult> {
  const subject = adapter.subject(item);
  const { organizationId } = subject;

  if (!(await deps.isEnabled(organizationId))) return { status: "skipped_disabled" };

  if (adapter.policy.requiresActivePayment) {
    const { data: organization } = await service.from("organizations").select("payment_status").eq("id", organizationId).maybeSingle();
    if (organization?.payment_status !== "active") return { status: "payment_inactive" };
  }

  if (!adapter.isDue(item, now)) return { status: "not_due" };

  // Soft claim - an optimization only; the race-proof guarantee is the key's unique index at step 8.
  const idempotencyKey = adapter.idempotencyKey(item);
  const { data: existingEvent } = await service.from("automation_events").select("id").eq("organization_id", organizationId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existingEvent) return { status: "skipped_duplicate" };

  // Never act on a failed read. A missing contact is a missing subject, reported as such.
  const lifecycle = await verifyLifecycle(service, organizationId, subject.contactId, now);
  if (lifecycle.failed) return lifecycle.error === "contact_not_found" ? { status: "subject_missing" } : { status: "lifecycle_failed", error: lifecycle.error };

  const owed = await adapter.stillOwed(service, item, lifecycle);
  if (!owed.owed) return { status: "not_owed", reason: owed.reason };
  const { facts } = owed;
  const payload = adapter.payload(item, facts);

  if (adapter.policy.stale === "record_overdue") {
    const { anchorMs, delayMs } = adapter.dueAt(item);
    const lateHours = hoursPastDue(now.getTime(), anchorMs, delayMs);
    if (isTouchOverdue(lateHours)) {
      const overdue = await recordOverdueTouch(service, {
        organizationId,
        eventType: adapter.identity.eventType,
        entityType: subject.entityType,
        entityId: subject.entityId,
        payload,
        idempotencyKey,
        workflowName: adapter.identity.workflowName,
        lateHours,
      });
      if (overdue.outcome === "blocked") return { status: "blocked", reason: overdue.reason };
      if (overdue.outcome === "failed") return { status: "failed", error: overdue.error };
      return { status: overdue.outcome };
    }
  }

  const recorded = await claimTouch(service, adapter.identity, organizationId, { entityType: subject.entityType, entityId: subject.entityId, payload, idempotencyKey });
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
      resultMetadata: adapter.resultMetadata(item, facts),
    },
    recorded.executionId,
    SERVICE_EXECUTION_OPS,
    deps.sendSmsFn,
  );
  if (result.kind === "sent") return { status: "sent", messageId: result.messageId };
  if (result.kind === "blocked") return { status: "blocked", reason: result.reason };
  return { status: "failed", error: result.error };
}
