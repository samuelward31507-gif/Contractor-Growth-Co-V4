import type { OrganizationHealthSummary } from "@/lib/automation-health/types";
import type { StatusDotTone } from "@/lib/ui/status-dot";

/**
 * Trackpr 2.0 (step 2D): turns the existing organization health summary
 * (lib/automation-health/health.ts - request-cached, no new reads) into what
 * the top bar says. Business language only: the contractor learns what it
 * means for their customers, never which piece of infrastructure failed.
 * Pure and JSX-free so it runs under plain node:test.
 *
 * The summary carries per-category counts for late tasks, undelivered
 * messages and stale scheduled tasks; every other incident is counted with
 * a neutral "needs a look" line rather than a guessed cause - incidents can
 * come from outside automations too (e.g. a payment that needs
 * reconciling), so even "automated task" would be a guess.
 */
export type SystemStatusView = {
  tone: StatusDotTone;
  /** The indicator text on desktop - also the start of its accessible name. */
  label: string;
  /** A shorter indicator for narrow screens. */
  shortLabel: string;
  headline: string;
  body: string;
  /** One plain sentence per distinct issue, most specific first. */
  issues: string[];
  /** Where the full picture lives. */
  detailsHref: string;
};

type HealthInput = Pick<
  OrganizationHealthSummary,
  "status" | "activeIncidentCount" | "stuckExecutionCount" | "smsDeliveryFailureCount" | "staleScheduledAutomationCount"
>;

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many.replace("{n}", String(count)));

export function describeIssues(health: HealthInput): string[] {
  const issues: string[] = [];
  const undelivered = health.smsDeliveryFailureCount;
  const late = health.stuckExecutionCount;
  const stale = health.staleScheduledAutomationCount;
  const other = Math.max(0, health.activeIncidentCount - undelivered - late);

  if (undelivered > 0) issues.push(plural(undelivered, "A customer message couldn't be delivered.", "{n} customer messages couldn't be delivered."));
  if (late > 0) issues.push(plural(late, "An automated task is running late.", "{n} automated tasks are running late."));
  if (stale > 0) issues.push(plural(stale, "A scheduled task may not have run on time.", "{n} scheduled tasks may not have run on time."));
  if (other > 0) {
    issues.push(
      issues.length > 0
        ? plural(other, "1 other item needs a look.", "{n} other items need a look.")
        : plural(other, "1 item needs a look.", "{n} items need a look."),
    );
  }
  return issues;
}

/** How many things the indicator counts - incidents plus stale scheduled tasks, exactly what drives the degraded/unhealthy status. */
export function issueCount(health: HealthInput): number {
  return health.activeIncidentCount + health.staleScheduledAutomationCount;
}

export function describeSystemStatus(health: HealthInput): SystemStatusView {
  const detailsHref = "/automations";

  if (health.status === "payment_blocked") {
    return {
      tone: "critical",
      label: "Payment needed",
      shortLabel: "Payment",
      headline: "Automations are paused",
      body: "Automated messages are paused until payment is resolved.",
      issues: [],
      detailsHref,
    };
  }

  if (health.status === "paused") {
    return {
      tone: "neutral",
      label: "Automations paused",
      shortLabel: "Paused",
      headline: "Automations are paused",
      body: "Automation has been paused for this account. Contact Contractor Growth Co. to resume it.",
      issues: [],
      detailsHref,
    };
  }

  if (health.status === "degraded" || health.status === "unhealthy") {
    // A degraded/unhealthy status always has at least one counted issue;
    // the floor of 1 only guards against a summary that disagrees with it.
    const count = Math.max(1, issueCount(health));
    const issues = describeIssues(health);
    return {
      tone: health.status === "unhealthy" ? "critical" : "attention",
      label: plural(count, "1 issue needs attention", "{n} issues need attention"),
      shortLabel: plural(count, "1 issue", "{n} issues"),
      headline: plural(count, "1 issue needs attention", "{n} issues need attention"),
      body: "The details show exactly what's affected.",
      issues: issues.length > 0 ? issues : ["1 item needs a look."],
      detailsHref,
    };
  }

  return {
    tone: "healthy",
    label: "All systems operational",
    shortLabel: "Operational",
    headline: "Everything is running normally",
    body: "Your automated follow-ups, reminders and customer messages are running without issues.",
    issues: [],
    detailsHref,
  };
}
