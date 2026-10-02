import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages } from "@/lib/bi/revenue-attribution";
import { getOpenOpportunitiesResult, summarizeOpportunities, type OpportunityType } from "@/lib/opportunities/queries";
import { getOrganizationHealth } from "@/lib/automation-health/health";
import { getNotificationSettings } from "@/lib/settings/queries";
import { createAutomationEventAsService } from "@/lib/automation/events";
import { startWorkflowExecutionAsService, completeWorkflowExecutionAsService, failWorkflowExecutionAsService } from "@/lib/automation/executions";
import { formatCurrency } from "@/lib/dashboard/format";
import { calendarDateInTimeZone } from "@/lib/invoices/domain";
import { notifyFounder, type FounderNotificationInput, type FounderNotificationResult } from "./founder";

/**
 * Phase 3G-1: the weekly owner digest - one short SMS to an organization's
 * own notification contact every Monday morning (organization's local time)
 * with what is worth acting on: open opportunities and their value, overdue
 * invoices, open automation issues and conversations waiting for a person.
 *
 * Owner-facing only. Delivery goes through notifyFounder (SMS-only here),
 * the same path as every other owner alert - never sendOutboundMessage or
 * the customer outbound gate, and nothing here ever messages a customer.
 *
 * Built only from reads that already run in Production and already report
 * their own failure: getOpenOpportunitiesResult (paged, Phase 3A-4; kept
 * current by the scheduled opportunity sync, Phase 3D), getOrganizationHealth
 * (incidentsUnavailable, Phase 3E) and the open-escalation count. It does not
 * use dashboard_briefing. A failed read is never reported as zero: its line
 * is dropped and the message says some figures couldn't be loaded.
 *
 * Idempotency is the existing automation_events key, one per organization
 * per local Monday (owner.digest:<organization_id>:<YYYY-MM-DD>), with a
 * workflow execution recording the outcome (sent / quiet / failed). A
 * duplicate key never sends twice, and a failed delivery is not retried.
 */

export const OWNER_DIGEST_EVENT_TYPE = "owner.digest";
export const OWNER_DIGEST_WORKFLOW = "owner_weekly_digest";
/** The digest goes out at the first scheduler tick from 7:00 local on Monday; later ticks before noon catch a missed 7:00 run. */
export const OWNER_DIGEST_LOCAL_HOUR = 7;
const OWNER_DIGEST_WINDOW_END_HOUR = 12;
const TOP_OPPORTUNITY_TYPES = 3;
const PARTIAL_LINE = "Some figures couldn't be loaded - check Today.";
const UNAVAILABLE_SUMMARY = "This week's summary couldn't be loaded - check Today.";

const TYPE_LABEL: Record<OpportunityType, [one: string, many: string]> = {
  qualified_lead_unbooked: ["qualified lead not booked", "qualified leads not booked"],
  stale_estimate: ["stale estimate", "stale estimates"],
  completed_appointment_no_estimate: ["visit with no estimate", "visits with no estimate"],
  dormant_customer: ["past customer to re-engage", "past customers to re-engage"],
  no_show: ["no-show", "no-shows"],
  completed_job_no_referral_request: ["job with no referral ask", "jobs with no referral ask"],
  completed_job_no_review_request: ["job with no review ask", "jobs with no review ask"],
  cancelled_appointment_no_rebooking: ["cancellation not rebooked", "cancellations not rebooked"],
  uncontacted_lead: ["lead not contacted", "leads not contacted"],
  accepted_estimate_no_job: ["accepted estimate with no job", "accepted estimates with no job"],
  active_lead_signal: ["hot lead", "hot leads"],
  pending_estimate: ["estimate awaiting a reply", "estimates awaiting a reply"],
  completed_job_not_invoiced: ["job not invoiced", "jobs not invoiced"],
  invoice_overdue: ["overdue invoice", "overdue invoices"],
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Local-time eligibility
// ---------------------------------------------------------------------------

export type OwnerDigestWindow = { due: false } | { due: true; weekOf: string };

/** Due on Monday from 7:00 until noon in `timeZone`; `weekOf` is that Monday's local date. Throws RangeError on an invalid time zone. */
export function ownerDigestWindow(now: Date, timeZone: string): OwnerDigestWindow {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  if (weekday !== "Monday" || hour < OWNER_DIGEST_LOCAL_HOUR || hour >= OWNER_DIGEST_WINDOW_END_HOUR) return { due: false };
  return { due: true, weekOf: calendarDateInTimeZone(now, timeZone) };
}

export function ownerDigestIdempotencyKey(organizationId: string, weekOf: string): string {
  return `${OWNER_DIGEST_EVENT_TYPE}:${organizationId}:${weekOf}`;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export type OwnerDigestSignals = {
  opportunities:
    | { failed: true }
    | { failed: false; count: number; knownValue: number; topTypes: { type: OpportunityType; count: number }[]; overdueInvoiceCount: number; overdueInvoiceValue: number };
  health: { failed: true } | { failed: false; automationIssues: number; staleScheduledAutomations: number };
  escalations: { failed: true } | { failed: false; count: number };
};

export async function loadOwnerDigestSignals(service: SupabaseClient, organizationId: string): Promise<OwnerDigestSignals> {
  const [openOpportunities, health, escalations] = await Promise.all([
    getOpenOpportunitiesResult(service, organizationId),
    getOrganizationHealth(service, organizationId),
    service.from("conversations").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "open").eq("ai_enabled", false),
  ]);

  let opportunities: OwnerDigestSignals["opportunities"] = { failed: true };
  if (!openOpportunities.failed) {
    const summary = summarizeOpportunities(openOpportunities.data);
    const overdue = openOpportunities.data.filter((opportunity) => opportunity.type === "invoice_overdue");
    const topTypes = (Object.entries(summary.byType) as [OpportunityType, number][])
      .filter(([type, count]) => count > 0 && type !== "invoice_overdue")
      .sort(([, a], [, b]) => b - a)
      .slice(0, TOP_OPPORTUNITY_TYPES)
      .map(([type, count]) => ({ type, count }));
    opportunities = {
      failed: false,
      count: summary.count,
      knownValue: summary.knownEstimatedValue,
      topTypes,
      overdueInvoiceCount: overdue.length,
      overdueInvoiceValue: overdue.reduce((sum, opportunity) => sum + (opportunity.estimatedValue ?? 0), 0),
    };
  }

  return {
    opportunities,
    health: health.incidentsUnavailable ? { failed: true } : { failed: false, automationIssues: health.activeIncidentCount, staleScheduledAutomations: health.staleScheduledAutomationCount },
    escalations: escalations.error || escalations.count == null ? { failed: true } : { failed: false, count: escalations.count },
  };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export type ComposedOwnerDigest = { kind: "quiet" } | { kind: "send"; summary: string; partial: boolean };

/**
 * Pure. Quiet (nothing sent) only when every read succeeded and none of them
 * found anything to act on. A failed read is never described - its line is
 * left out and the partial line is added; if no read succeeded at all, the
 * message only says the summary couldn't be loaded.
 */
export function composeOwnerDigest(signals: OwnerDigestSignals): ComposedOwnerDigest {
  const { opportunities, health, escalations } = signals;
  const failedReads = [opportunities, health, escalations].filter((signal) => signal.failed).length;
  if (failedReads === 3) return { kind: "send", summary: UNAVAILABLE_SUMMARY, partial: true };

  const parts: string[] = [];
  if (!opportunities.failed && opportunities.count > 0) {
    const worth = opportunities.knownValue > 0 ? ` worth ${formatCurrency(opportunities.knownValue)}` : "";
    parts.push(`${plural(opportunities.count, "open opportunity", "open opportunities")}${worth}.`);
    if (opportunities.topTypes.length > 0) {
      parts.push(`Top: ${opportunities.topTypes.map(({ type, count }) => plural(count, ...TYPE_LABEL[type])).join(", ")}.`);
    }
    if (opportunities.overdueInvoiceCount > 0) {
      const amount = opportunities.overdueInvoiceValue > 0 ? ` (${formatCurrency(opportunities.overdueInvoiceValue)})` : "";
      parts.push(`${plural(opportunities.overdueInvoiceCount, "overdue invoice", "overdue invoices")}${amount}.`);
    }
  }
  if (!health.failed && health.automationIssues > 0) parts.push(`${plural(health.automationIssues, "automation issue", "automation issues")} open.`);
  if (!health.failed && health.staleScheduledAutomations > 0) parts.push(`${plural(health.staleScheduledAutomations, "scheduled automation", "scheduled automations")} not running.`);
  if (!escalations.failed && escalations.count > 0) parts.push(`${plural(escalations.count, "conversation waiting", "conversations waiting")} for your team.`);

  if (parts.length === 0) return failedReads > 0 ? { kind: "send", summary: PARTIAL_LINE, partial: true } : { kind: "quiet" };
  if (failedReads > 0) parts.push(PARTIAL_LINE);
  return { kind: "send", summary: parts.join(" "), partial: failedReads > 0 };
}

// ---------------------------------------------------------------------------
// Run (called by app/api/automation/owner-digest)
// ---------------------------------------------------------------------------

export type OwnerDigestOutcome = {
  organizationId: string;
  outcome: "not_due" | "disabled" | "no_recipient" | "duplicate" | "quiet" | "sent" | "failed";
};

export type OwnerDigestRunResult = {
  candidates: number;
  sent: number;
  quiet: number;
  skipped: number;
  failed: number;
  /** The eligible-organization scan failed - nothing was evaluated. */
  scanFailed: boolean;
  outcomes: OwnerDigestOutcome[];
};

export type OwnerDigestDeps = {
  loadSignals?: (service: SupabaseClient, organizationId: string) => Promise<OwnerDigestSignals>;
  notify?: (service: SupabaseClient, input: FounderNotificationInput) => Promise<FounderNotificationResult>;
  log?: (message: string, context: Record<string, unknown>) => void;
};

type EligibleOrganization = { id: string; timezone: string | null };

async function processOrganization(service: SupabaseClient, organization: EligibleOrganization, now: Date, deps: Required<OwnerDigestDeps>): Promise<OwnerDigestOutcome["outcome"]> {
  const window = ownerDigestWindow(now, organization.timezone || "UTC");
  if (!window.due) return "not_due";

  // The owner's own setting first - nothing is read or recorded for an owner who opted out.
  const settings = await getNotificationSettings(service, organization.id);
  if (!settings.notify_on_owner_digest) return "disabled";
  if (!settings.notification_phone) return "no_recipient";

  const idempotencyKey = ownerDigestIdempotencyKey(organization.id, window.weekOf);
  // Fast path only - the unique (organization_id, idempotency_key) index behind createAutomationEventAsService is the real guarantee.
  const { data: existing } = await service.from("automation_events").select("id").eq("organization_id", organization.id).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existing) return "duplicate";

  const signals = await deps.loadSignals(service, organization.id);
  const digest = composeOwnerDigest(signals);

  const event = await createAutomationEventAsService(service, organization.id, {
    eventType: OWNER_DIGEST_EVENT_TYPE,
    entityType: "organization",
    entityId: organization.id,
    idempotencyKey,
    // Counts only - never names, numbers or message text. null = the read failed.
    payload: {
      week_of: window.weekOf,
      planned: digest.kind,
      partial: digest.kind === "send" && digest.partial,
      open_opportunities: signals.opportunities.failed ? null : signals.opportunities.count,
      overdue_invoices: signals.opportunities.failed ? null : signals.opportunities.overdueInvoiceCount,
      automation_issues: signals.health.failed ? null : signals.health.automationIssues,
      escalations: signals.escalations.failed ? null : signals.escalations.count,
    },
  });
  if (!event.ok) return "failed";
  if (event.skipped || event.duplicate) return "duplicate";

  const execution = await startWorkflowExecutionAsService(service, event.event.id, OWNER_DIGEST_WORKFLOW, { week_of: window.weekOf });
  if (!execution.ok) return "failed";
  const executionId = execution.execution.id;

  if (digest.kind === "quiet") {
    await completeWorkflowExecutionAsService(service, executionId, { outcome: "quiet" });
    return "quiet";
  }

  const delivery = await deps.notify(service, { organizationId: organization.id, kind: "owner_digest", summary: digest.summary, detailPath: "/today", smsOnly: true });
  if (delivery.outcome === "delivered") {
    await completeWorkflowExecutionAsService(service, executionId, { outcome: "sent", partial: digest.partial });
    return "sent";
  }
  if (delivery.outcome === "disabled" || delivery.outcome === "no_recipient") {
    // The setting or number changed between the check above and delivery.
    await completeWorkflowExecutionAsService(service, executionId, { outcome: delivery.outcome });
    return delivery.outcome;
  }
  await failWorkflowExecutionAsService(service, executionId, "The weekly owner summary SMS could not be delivered.", "sms_send_failed");
  return "failed";
}

/**
 * Evaluates every organization the existing scheduled owner alert notifies
 * (live, payment active, not paused - lib/automation-health/scheduled-
 * automation-alert.ts), one at a time. Organizations outside their Monday
 * morning window return immediately with no further reads. One
 * organization's failure never stops the others.
 */
export async function runOwnerDigest(service: SupabaseClient, now: Date = new Date(), deps: OwnerDigestDeps = {}): Promise<OwnerDigestRunResult> {
  const resolved: Required<OwnerDigestDeps> = {
    loadSignals: deps.loadSignals ?? loadOwnerDigestSignals,
    notify: deps.notify ?? notifyFounder,
    log: deps.log ?? ((message, context) => console.error(message, context)),
  };

  const organizations = await readAllPages<EligibleOrganization>(() =>
    service.from("organizations").select("id, timezone").eq("automation_mode", "live").eq("payment_status", "active").eq("automation_paused", false).order("id"),
  );
  if (organizations.failed) {
    resolved.log("[owner-digest] eligible organization scan failed", {});
    return { candidates: 0, sent: 0, quiet: 0, skipped: 0, failed: 0, scanFailed: true, outcomes: [] };
  }

  const outcomes: OwnerDigestOutcome[] = [];
  for (const organization of organizations.rows) {
    try {
      outcomes.push({ organizationId: organization.id, outcome: await processOrganization(service, organization, now, resolved) });
    } catch (error) {
      resolved.log("[owner-digest] digest failed for an organization", { organizationId: organization.id, error: error instanceof Error ? error.name : "unknown" });
      outcomes.push({ organizationId: organization.id, outcome: "failed" });
    }
  }

  const count = (...kinds: OwnerDigestOutcome["outcome"][]) => outcomes.filter((o) => kinds.includes(o.outcome)).length;
  return {
    candidates: organizations.rows.length,
    sent: count("sent"),
    quiet: count("quiet"),
    skipped: count("not_due", "disabled", "no_recipient", "duplicate"),
    failed: count("failed"),
    scanFailed: false,
    outcomes,
  };
}
