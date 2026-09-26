import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAutomationHealthSignal } from "./service";
import { buildIncidentFingerprint } from "./fingerprint";
import { notifyFounder } from "@/lib/notifications/founder";

/**
 * Pass 5C Batch 7, Item 2: the automation-degraded owner alert - the one
 * proactive notification gap the Pass 5C Batch 6 completion audit
 * identified. Deliberately narrow: the underlying signal
 * (getScheduledAutomationLiveness) is a single, global, platform-wide fact
 * ("has one of Trackpr's own scheduled routes gone quiet"), not a
 * per-organization one - see lib/automation-health/scheduled-automation-liveness.ts's
 * own header comment. This module's only job is to fan that one fact out to
 * the organizations it's actually relevant to (live, paying, unpaused - the
 * exact same three checks lib/opportunities/detect.ts's own
 * detectUncontactedLeads already uses for identical reasoning), using
 * exclusively the EXISTING automation_incidents/notifyFounder
 * infrastructure - no new alert-state table, no new dedup mechanism.
 *
 * Dedup/state-transition is entirely delegated to what already exists:
 *  - record_automation_incident_signal's own ON CONFLICT (organization_id,
 *    fingerprint) WHERE status IN ('open','acknowledged') means a repeat
 *    call while the same organization is already flagged only bumps
 *    occurrence_count - it never creates a second row and never returns
 *    occurrenceCount === 1 again until the incident is resolved. This is
 *    the exact same "first occurrence vs. a repeat" signal
 *    app/api/automation/health/route.ts's own workflow_stuck handling
 *    already relies on (`if (incident && incident.occurrenceCount === 1)`).
 *  - resolve_automation_incidents_by_fingerprint (already used by
 *    lib/automation-health/service.ts's own resolveAutomationFailureIncidents)
 *    clears the open incident once the underlying condition is gone,
 *    exactly like every other resolvable incident category in this
 *    codebase - a later, genuinely new degradation then creates a fresh
 *    row with occurrence_count back at 1, so notification can fire again.
 *
 * Called from app/api/automation/health/route.ts's own existing 15-minute
 * health-check tick - never a new cron, never a new external trigger.
 */

const SCHEDULED_AUTOMATION_STALE_FINGERPRINT_CONTEXT = "scheduled-automation";
const SCHEDULED_AUTOMATION_STALE_FINGERPRINT = buildIncidentFingerprint("scheduled_automation_stale", SCHEDULED_AUTOMATION_STALE_FINGERPRINT_CONTEXT);

type OpenIncidentRow = { organization_id: string };
type EligibleOrganizationRow = { id: string };

export type ScheduledAutomationAlertResult = { notified: number; resolved: number };

/**
 * Conservative, factual, and free of any internal infrastructure detail -
 * never names n8n, a workflow, a database id, or claims a specific
 * automation failed, leads were lost, or revenue was lost, since the
 * underlying signal (a stale scheduler heartbeat) proves none of that -
 * only that Trackpr's own scheduled checks have gone quiet longer than
 * expected.
 */
const ALERT_TITLE = "Automation needs attention";
const ALERT_DESCRIPTION = "Trackpr detected a degradation in your automation health. Review your automation status when you have a moment.";
const ALERT_SUMMARY = "Automation needs attention - Trackpr detected a degradation in your automation health.";

/**
 * `isCurrentlyStale` is the caller's own already-computed
 * `staleScheduledAutomations.length > 0` (see the health route) - this
 * function never re-derives scheduled-automation liveness itself, per the
 * task's own "do not redesign scheduled liveness" instruction.
 *
 * Two disjoint paths, each a single bounded query, matching the "one fetch
 * + in-memory aggregation" shape every other automation in this codebase
 * already uses (customer-reactivation.ts, lead-reactivation.ts,
 * appointment-reminders.ts, no-show-detection.ts all similarly scan across
 * organizations, then apply eligibility in-memory - this is not a new
 * pattern):
 *
 *  - Not stale: resolve every currently-open incident of this category,
 *    across whichever organizations have one (derived directly from
 *    automation_incidents itself - never an unbounded scan of
 *    `organizations`, since the common case is "nothing is open" and this
 *    path must stay cheap then).
 *  - Stale: fetch every live/paid/unpaused organization (bounded,
 *    MAX_ROWS-limited like every other detector in this codebase) and
 *    record a signal for each - a repeat tick while already open is a
 *    guaranteed no-op notification-wise via the RPC's own dedup, so this is
 *    always safe to call on every tick regardless of how long the
 *    degradation persists.
 */
export async function evaluateScheduledAutomationDegradedAlert(
  supabase: SupabaseClient,
  isCurrentlyStale: boolean,
  /** Test seam only - production callers must never pass this; see lib/automation/customer-reactivation.ts's own sendSmsFn parameter for the identical established convention. */
  notifyFounderFn: typeof notifyFounder = notifyFounder,
): Promise<ScheduledAutomationAlertResult> {
  const { data: openIncidentRows } = await supabase
    .from("automation_incidents")
    .select("organization_id")
    .eq("category", "scheduled_automation_stale")
    .in("status", ["open", "acknowledged"])
    .limit(1000);

  const openOrganizationIds = [...new Set(((openIncidentRows ?? []) as OpenIncidentRow[]).map((row) => row.organization_id))];

  if (!isCurrentlyStale) {
    let resolved = 0;
    for (const organizationId of openOrganizationIds) {
      const { data: count } = await supabase.rpc("resolve_automation_incidents_by_fingerprint", {
        p_organization_id: organizationId,
        p_fingerprints: [SCHEDULED_AUTOMATION_STALE_FINGERPRINT],
      });
      if (typeof count === "number") resolved += count;
    }
    return { notified: 0, resolved };
  }

  const { data: organizationRows } = await supabase
    .from("organizations")
    .select("id")
    .eq("automation_mode", "live")
    .eq("payment_status", "active")
    .eq("automation_paused", false)
    .limit(1000);

  let notified = 0;
  for (const organization of (organizationRows ?? []) as EligibleOrganizationRow[]) {
    const incident = await recordAutomationHealthSignal(supabase, {
      organizationId: organization.id,
      category: "scheduled_automation_stale",
      severity: "warning",
      fingerprintContext: SCHEDULED_AUTOMATION_STALE_FINGERPRINT_CONTEXT,
      title: ALERT_TITLE,
      description: ALERT_DESCRIPTION,
    });

    if (incident && incident.occurrenceCount === 1) {
      notified += 1;
      await notifyFounderFn(supabase, {
        organizationId: organization.id,
        kind: "automation_degraded",
        summary: ALERT_SUMMARY,
        detailPath: "/automation-health",
      });
    }
  }

  return { notified, resolved: 0 };
}
