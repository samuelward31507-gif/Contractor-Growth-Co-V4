import Link from "next/link";
import { ChevronRight, Search } from "lucide-react";
import { Badge, RAIL_TONE_CLASS, type BadgeTone } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { formatRelativeTime, formatCurrency } from "@/lib/dashboard/format";
import { ONBOARDING_STAGE_LABEL, type OnboardingStage } from "@/lib/onboarding/checklist";
import type { AgencyOrganizationSnapshot } from "@/lib/agency/queries";
import type { AgencyOrganizationHealth } from "@/lib/agency/health";
import { formatCount } from "./format";

// Usability audit fix (#4, Agency Clients co-primary): "AUTOMATION" column -
// derived straight from the existing health.automationPaused flag already
// threaded onto every row (see lib/agency/health.ts's own
// AgencyOrganizationHealth type) - no new automation state, no new query.
function AutomationCell({ health }: { health: AgencyOrganizationHealth | undefined }) {
  if (health?.automationPaused) {
    return <Badge tone="neutral">Paused</Badge>;
  }
  return <span className="text-sm text-ink-3">On</span>;
}

// Usability audit fix (#4): "PIPELINE SIGNAL" column - the org's own open
// pipeline value, already computed by the exact same BusinessMetricsSnapshot
// every other agency page (Usage, Revenue) reads via
// AgencyOrganizationSnapshot.metrics - no new query, no new pipeline engine.
function pipelineSignal(organization: AgencyOrganizationSnapshot): string {
  const value = organization.metrics.pipelineMetrics.pipelineValue;
  return value > 0 ? formatCurrency(value) : "—";
}

const STAGE_TONE: Record<OnboardingStage, BadgeTone> = {
  new: "neutral",
  configuring: "warning",
  testing: "info",
  ready: "info",
  live: "success",
};

// Usability audit fix (#4, Agency Clients co-primary): re-prioritized so the
// four decision-relevant columns (Health, Automation, Pipeline, Next action)
// never hide - only the least decision-relevant raw counts (Leads/Appts/
// Jobs) move to the widest-screen-only tier. Two column counts, not one grid
// hidden down to fewer visible cells: a fixed-track template with cells
// merely hidden below `xl` still reserves those tracks' width, leaving dead
// gaps and misaligning the remaining columns at 1024-1279px - the
// container's own template changes column count at the breakpoint instead,
// matching how many cells are actually rendered at each size.
const ROW_GRID =
  "grid-cols-[minmax(0,1fr)_84px_108px_88px_96px_92px_minmax(0,160px)_20px] xl:grid-cols-[minmax(0,1.1fr)_84px_108px_88px_96px_52px_52px_52px_92px_minmax(0,160px)_20px]";

/**
 * Trackpr 2.0 Phase 6: the row's one "why" signal - a client can be flagged
 * for more than one real reason at once (billing, an open incident, being
 * paused, a broken calendar, SMS delivery failures), and the master prompt
 * asks the row to hint at WHY, not just THAT. Checked in a fixed priority
 * order (worst/most-actionable first) so the single label shown is the most
 * urgent true reason, with "+N" for any others - never a score, never a
 * ranking beyond "which of these real conditions is worse."
 */
function attentionReasons(health: AgencyOrganizationHealth | undefined): string[] {
  if (!health) return [];
  const reasons: string[] = [];
  if (health.paymentStatus === "suspended" || health.paymentStatus === "cancelled") reasons.push("Billing");
  if (health.activeIncidentCount > 0) reasons.push("Incidents");
  if (health.automationPaused) reasons.push("Paused");
  if (health.calendarStatus === "error") reasons.push("Calendar");
  if (health.failedMessages > 0 || health.undeliveredMessages > 0) reasons.push("SMS");
  if (health.stuckExecutionCount > 0 && !reasons.includes("Incidents")) reasons.push("Stuck");
  // Phase 3E: the remaining health-flag signals, so the badge never reads "Healthy" for a flagged client.
  if (health.failedWorkflowExecutions > 0 && !reasons.includes("Incidents")) reasons.push("Failed runs");
  if (health.communicationUnavailable || health.automationUnavailable || health.incidentsUnavailable) reasons.push("Unavailable");
  return reasons;
}

function HealthBadge({ health }: { health: AgencyOrganizationHealth | undefined }) {
  const reasons = attentionReasons(health);
  if (reasons.length === 0) return <span className="text-sm text-ink-3">Healthy</span>;
  return (
    <Badge tone="danger">
      {reasons[0]}
      {reasons.length > 1 ? ` +${reasons.length - 1}` : ""}
    </Badge>
  );
}

export type ClientRow = {
  organization: AgencyOrganizationSnapshot;
  health: AgencyOrganizationHealth | undefined;
  /** Phase 3E: this client is in the distinct needs-attention set (its health flag, or any open feed item) - the same set the Agency header counts. */
  needsAttention: boolean;
  stage: OnboardingStage;
  incompleteCount: number;
  lastActivityAt: string | null;
  /** Phase 3E: null when the escalation read failed - shown as unavailable, never as "no escalations". */
  escalationCount: number | null;
  /** Usability audit fix (#4): "NEXT ACTION" column - reuses the same NeedsAttentionItem.why text app/agency/_components/needs-attention.tsx already shows for this org's most urgent open item (see agency/page.tsx's own nextActionByOrg map). Null when the org has no open attention item - never invented copy. */
  nextAction: string | null;
};

/**
 * Agency Command Center UI review: the primary operational surface,
 * replacing client-health-table.tsx's own <table> of BI metrics (leads,
 * pipeline, estimates, jobs) with the four things Phase 3 actually asks
 * this list to answer at a glance - status, readiness, health, last
 * activity - mirroring app/(app)/leads/_components/leads-table.tsx's exact
 * grid-row + rail-color pattern (desktop grid, mobile stacked rows) rather
 * than a generic <table>. A healthy, live client recedes (neutral rail,
 * "Live" badge, no readiness note); a client needing attention gets the
 * danger rail regardless of its onboarding stage, since operational health
 * is the more urgent signal of the two.
 *
 * Trackpr 2.0 Phase 6: the Health cell now names the most urgent real reason
 * (Billing/Incidents/Paused/Calendar/SMS/Stuck - see attentionReasons)
 * instead of a bare "Needs attention" binary, and a new xl-only "Issues"
 * column surfaces the raw open-incident count - both answer "why" at a
 * glance, from data already fetched for this row (row.health), no new query.
 */
export function ClientOperations({ rows, totalCount }: { rows: ClientRow[]; totalCount: number }) {
  if (rows.length === 0) {
    return totalCount === 0 ? (
      <EmptyState
        icon={Search}
        title="No client organizations are connected yet."
        description="Once a client organization is associated with the agency, it will appear here."
      />
    ) : (
      <EmptyState icon={Search} title="No clients match your search or filter." description="Try a different search term or clear the filter." />
    );
  }

  return (
    <div>
      <div className="hidden lg:block">
        <div className={`grid ${ROW_GRID} items-center gap-3 border-b border-l-2 border-l-transparent border-line pl-3 pr-2 pb-3`}>
          <span className="text-xs text-ink-3">Client</span>
          <span className="text-xs text-ink-3">Status</span>
          <span className="text-xs text-ink-3">Health</span>
          <span className="text-xs text-ink-3">Automation</span>
          <span className="text-right text-xs text-ink-3">Pipeline</span>
          <span className="hidden text-right text-xs text-ink-3 xl:block">Leads</span>
          <span className="hidden text-right text-xs text-ink-3 xl:block">Appts</span>
          <span className="hidden text-right text-xs text-ink-3 xl:block">Jobs</span>
          <span className="text-xs text-ink-3 whitespace-nowrap">Last activity</span>
          <span className="text-xs text-ink-3">Next action</span>
          <span />
        </div>
        <div className="divide-y divide-line">
          {rows.map((row) => (
            <ClientRowDesktop key={row.organization.organizationId} row={row} />
          ))}
        </div>
      </div>

      <ul className="divide-y divide-line lg:hidden">
        {rows.map((row) => (
          <ClientRowMobile key={row.organization.organizationId} row={row} />
        ))}
      </ul>
    </div>
  );
}

function railTone(row: ClientRow): BadgeTone {
  if (row.needsAttention) return "danger";
  return STAGE_TONE[row.stage];
}

function readinessNote(row: ClientRow): string | null {
  if (row.stage === "live") return null;
  if (row.incompleteCount === 0) return null;
  return `${row.incompleteCount} item${row.incompleteCount === 1 ? "" : "s"} remaining`;
}

function ClientRowDesktop({ row }: { row: ClientRow }) {
  const { organization, health, stage } = row;
  const note = readinessNote(row);
  const m = organization.metrics;

  return (
    <Link
      href={`/agency/organizations/${organization.organizationId}`}
      className={`group grid ${ROW_GRID} items-center gap-3 rounded-r-md border-l-2 py-3.5 pl-3 pr-2 transition-colors hover:bg-hover ${RAIL_TONE_CLASS[railTone(row)]}`}
    >
      <span className="min-w-0 truncate text-sm font-medium text-ink">{organization.organizationName}</span>
      <span>
        <Badge tone={STAGE_TONE[stage]}>{ONBOARDING_STAGE_LABEL[stage]}</Badge>
        {note ? <span className="ml-1.5 text-xs text-ink-3">{note}</span> : null}
      </span>
      <span>
        <HealthBadge health={health} />
      </span>
      <span>
        <AutomationCell health={health} />
      </span>
      <span className="text-right text-xs font-medium tabular-nums text-ink-2">{pipelineSignal(organization)}</span>
      <span className="hidden text-right text-xs tabular-nums text-ink-3 xl:block">{formatCount(m.leadMetrics.totalLeads)}</span>
      <span className="hidden text-right text-xs tabular-nums text-ink-3 xl:block">{formatCount(m.appointmentMetrics.totalAppointments)}</span>
      <span className="hidden text-right text-xs tabular-nums text-ink-3 xl:block">{formatCount(m.jobMetrics.totalJobs)}</span>
      <span className="text-xs tabular-nums text-ink-3">
        {row.lastActivityAt ? formatRelativeTime(row.lastActivityAt) : "No activity yet"}
      </span>
      <span className="truncate text-xs text-ink-3">{row.nextAction ?? "—"}</span>
      <ChevronRight className="h-4 w-4 shrink-0 justify-self-end text-ink-4 transition-colors group-hover:text-ink-3" aria-hidden />
    </Link>
  );
}

function ClientRowMobile({ row }: { row: ClientRow }) {
  const { organization, health, stage } = row;
  const note = readinessNote(row);
  const m = organization.metrics;

  return (
    <li>
      <Link
        href={`/agency/organizations/${organization.organizationId}`}
        className={`flex items-start gap-3 border-l-2 py-3.5 pl-3 pr-2 ${RAIL_TONE_CLASS[railTone(row)]}`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-ink">{organization.organizationName}</span>
            <Badge tone={STAGE_TONE[stage]}>{ONBOARDING_STAGE_LABEL[stage]}</Badge>
          </span>
          <span className="mt-0.5 flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-ink-3">
              {attentionReasons(health).length > 0 ? (
                <span className="font-medium text-danger">{attentionReasons(health).join(", ")}</span>
              ) : (
                "Healthy"
              )}
              {note ? ` · ${note}` : ""}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-ink-3">
              {row.lastActivityAt ? formatRelativeTime(row.lastActivityAt) : "—"}
            </span>
          </span>
          <span className="mt-1 flex items-center gap-2 text-xs tabular-nums text-ink-3">
            <AutomationCell health={health} />
            <span>·</span>
            <span className="font-medium text-ink-2">{pipelineSignal(organization)}</span>
            <span>pipeline</span>
          </span>
          <span className="mt-0.5 block text-xs tabular-nums text-ink-3">
            {formatCount(m.leadMetrics.totalLeads)} leads · {formatCount(m.appointmentMetrics.totalAppointments)} appts · {formatCount(m.jobMetrics.totalJobs)} jobs
            {row.escalationCount === null ? (
              <span className="text-ink-3"> · escalations unavailable</span>
            ) : row.escalationCount > 0 ? (
              <span className="font-medium text-warning"> · {formatCount(row.escalationCount)} AI escalation{row.escalationCount === 1 ? "" : "s"}</span>
            ) : null}
          </span>
          {row.nextAction ? <span className="mt-0.5 block truncate text-xs text-ink-3">{row.nextAction}</span> : null}
        </span>
      </Link>
    </li>
  );
}
