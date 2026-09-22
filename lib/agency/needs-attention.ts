import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAgencyOrganizations, type AgencyAuthFailure } from "./queries";
import { getAgencyHealth } from "./health";
import { getAgencyOnboardingStages } from "./operations";
import { getAgencyEscalatedConversations } from "./communication";
import { getOrganizationHealth } from "@/lib/automation-health/health";

/** How long an organization can sit short of "live" before onboarding counts as stalled, not just "in progress." A brand-new client is expected to take some time - this only flags a client that has been in that state for a meaningfully long stretch. */
const ONBOARDING_STALLED_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

export type NeedsAttentionSeverity = "critical" | "warning";

export type NeedsAttentionItem = {
  id: string;
  severity: NeedsAttentionSeverity;
  organizationId: string;
  organizationName: string;
  problem: string;
  why: string;
  timestamp: string;
  actionHref: string;
  actionLabel: string;
};

export type NeedsAttentionResult = { ok: true; items: NeedsAttentionItem[] } | AgencyAuthFailure;

/**
 * Agency Command Center 2.0 - the richer "Needs Attention" feed Section 5.C
 * asks for: one row per concrete, derivable issue (not one blob per
 * organization), each with a severity, a real timestamp, and a direct
 * action. Every item here is read from data another agency function already
 * computes deterministically (lib/automation-health/health.ts's
 * getOrganizationHealth, the existing stuck-execution list, the escalated-
 * conversation read, and onboarding stage) - nothing is scored, ranked, or
 * invented. Severity follows the same CRITICAL/ATTENTION model
 * getOrganizationHealth already uses: a critical incident makes the item
 * critical, everything else recoverable is a warning.
 */
export async function getAgencyNeedsAttentionItems(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
): Promise<NeedsAttentionResult> {
  const resolved = await resolveAgencyOrganizations(sessionSupabase, serviceSupabase);
  if (!resolved.ok) return resolved;

  const [health, stages, escalations, perOrgHealth] = await Promise.all([
    getAgencyHealth(sessionSupabase, serviceSupabase),
    getAgencyOnboardingStages(sessionSupabase, serviceSupabase),
    getAgencyEscalatedConversations(sessionSupabase, serviceSupabase),
    Promise.all(resolved.organizations.map((org) => getOrganizationHealth(serviceSupabase, org.organizationId))),
  ]);

  if (!health.ok) return health;
  if (!stages.ok) return stages;
  if (!escalations.ok) return escalations;

  const orgById = new Map(resolved.organizations.map((org) => [org.organizationId, org]));
  const healthByOrg = new Map(perOrgHealth.map((detail) => [detail.organizationId, detail]));
  const now = Date.now();
  const items: NeedsAttentionItem[] = [];

  for (const org of resolved.organizations) {
    const detail = healthByOrg.get(org.organizationId);
    if (!detail) continue;
    const actionHref = `/agency/organizations/${org.organizationId}`;

    if (detail.criticalIncidentCount > 0) {
      items.push({
        id: `incident-critical-${org.organizationId}`,
        severity: "critical",
        organizationId: org.organizationId,
        organizationName: org.organizationName,
        problem: detail.failedWorkflowExecutions > 0 ? "Automation execution failing" : "Critical operational incident",
        why: `${detail.criticalIncidentCount} critical incident${detail.criticalIncidentCount === 1 ? "" : "s"} open`,
        timestamp: detail.lastFailureAt ?? detail.generatedAt,
        actionHref,
        actionLabel: "View client",
      });
    } else if (detail.warningIncidentCount > 0) {
      items.push({
        id: `incident-warning-${org.organizationId}`,
        severity: "warning",
        organizationId: org.organizationId,
        organizationName: org.organizationName,
        problem: "Automation incident open",
        why: `${detail.warningIncidentCount} warning incident${detail.warningIncidentCount === 1 ? "" : "s"} open`,
        timestamp: detail.lastFailureAt ?? detail.generatedAt,
        actionHref,
        actionLabel: "View client",
      });
    }

    // Growth System Completion Pass 1: surfaces lib/agency/health.ts's own
    // calendarStatus (safe metadata only, never a credential) - the audit's
    // own finding that a broken client calendar connection was previously
    // invisible anywhere in the Agency Command Center.
    const orgHealthSummary = health.organizations.find((o) => o.organizationId === org.organizationId);
    if (orgHealthSummary?.calendarStatus === "error") {
      items.push({
        id: `calendar-${org.organizationId}`,
        severity: "warning",
        organizationId: org.organizationId,
        organizationName: org.organizationName,
        problem: "Google Calendar connection broken",
        why: orgHealthSummary.calendarLastError ?? "The calendar connection needs to be reconnected.",
        timestamp: detail.generatedAt,
        actionHref,
        actionLabel: "View client",
      });
    }

    if (detail.smsDeliveryFailureCount > 0) {
      items.push({
        id: `sms-${org.organizationId}`,
        severity: "warning",
        organizationId: org.organizationId,
        organizationName: org.organizationName,
        problem: "SMS delivery failing",
        why: `${detail.smsDeliveryFailureCount} delivery failure${detail.smsDeliveryFailureCount === 1 ? "" : "s"}`,
        timestamp: detail.lastFailureAt ?? detail.generatedAt,
        actionHref,
        actionLabel: "View client",
      });
    }

    const stageInfo = stages.stageByOrg.get(org.organizationId);
    if (stageInfo && stageInfo.stage !== "live" && now - new Date(org.createdAt).getTime() > ONBOARDING_STALLED_THRESHOLD_MS) {
      items.push({
        id: `onboarding-${org.organizationId}`,
        severity: "warning",
        organizationId: org.organizationId,
        organizationName: org.organizationName,
        problem: "Stuck in onboarding",
        why: `${stageInfo.incompleteCount} setup item${stageInfo.incompleteCount === 1 ? "" : "s"} still incomplete`,
        timestamp: org.createdAt,
        actionHref,
        actionLabel: "View client",
      });
    }
  }

  const escalationCountByOrg = new Map<string, number>();
  const escalationLatestByOrg = new Map<string, string>();
  for (const conversation of escalations.conversations) {
    escalationCountByOrg.set(conversation.organizationId, (escalationCountByOrg.get(conversation.organizationId) ?? 0) + 1);
    // The read is already ordered newest-first, so the first row seen per
    // organization is that organization's most recent escalation.
    if (!escalationLatestByOrg.has(conversation.organizationId)) {
      escalationLatestByOrg.set(conversation.organizationId, conversation.updatedAt);
    }
  }
  for (const [organizationId, count] of escalationCountByOrg) {
    const org = orgById.get(organizationId);
    if (!org) continue;
    items.push({
      id: `escalation-${organizationId}`,
      severity: "warning",
      organizationId,
      organizationName: org.organizationName,
      problem: "AI escalation waiting",
      why: `${count} conversation${count === 1 ? "" : "s"} waiting for a human reply`,
      timestamp: escalationLatestByOrg.get(organizationId)!,
      actionHref: `/agency/organizations/${organizationId}`,
      actionLabel: "View client",
    });
  }

  for (const execution of health.stuck) {
    items.push({
      id: `stuck-${execution.id}`,
      severity: "warning",
      organizationId: execution.organizationId,
      organizationName: execution.organizationName,
      problem: `${execution.workflowName} stuck`,
      why: `Running ${execution.ageMinutes} min · attempt ${execution.attempt}`,
      timestamp: execution.startedAt,
      actionHref: `/agency/organizations/${execution.organizationId}`,
      actionLabel: "View client",
    });
  }

  items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return { ok: true, items };
}
