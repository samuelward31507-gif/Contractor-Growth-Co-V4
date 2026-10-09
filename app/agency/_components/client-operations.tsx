import Link from "next/link";
import { Building2, ChevronRight, Search } from "lucide-react";
import { Badge, RAIL_TONE_CLASS, type BadgeTone } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { StatusLabel } from "@/lib/ui/status-dot";
import { TableCell, TableHeadCell } from "@/lib/ui/table";
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
  return <StatusLabel tone="healthy">On</StatusLabel>;
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
//
// Agency overview redesign: the header and every row share lib/ui/table.tsx's
// one horizontal model (a 2px left rail, transparent on the header, and the
// same left/right padding) so labels sit exactly over their cells. Table/
// TableRow themselves are not used for the shell because their fixed gap-6
// cannot fit eleven tracks at lg; TableHeadCell/TableCell are.
const ROW_GRID =
  "grid-cols-[minmax(0,1fr)_84px_108px_88px_96px_92px_minmax(0,160px)_16px] xl:grid-cols-[minmax(0,1.1fr)_84px_108px_88px_96px_52px_52px_52px_92px_minmax(0,160px)_16px]";

const ROW_PADDING = "pl-3.5 pr-4 sm:pl-[18px] sm:pr-5";

/** lib/ui/table.tsx's TableHeadCell classes, for the header cells that also need breakpoint visibility. */
const HEAD_CELL_CLASS = "text-xs font-medium text-ink-3";

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
  if (reasons.length === 0) return <StatusLabel tone="healthy">Healthy</StatusLabel>;
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
 * Agency Command Center UI review: the primary operational surface - status,
 * readiness, health, automation, pipeline, last activity and next action per
 * client, as a desktop grid table plus a stacked mobile list (the client
 * app's established split - see lib/ui/table.tsx). A healthy, live client
 * recedes (neutral rail, "Live" badge, no readiness note); a client needing
 * attention gets the danger rail regardless of its onboarding stage, since
 * operational health is the more urgent signal of the two.
 *
 * Trackpr 2.0 Phase 6: the Health cell names the most urgent real reason
 * (Billing/Incidents/Paused/Calendar/SMS/Stuck - see attentionReasons)
 * instead of a bare "Needs attention" binary - from data already fetched for
 * this row (row.health), no new query.
 *
 * Renders flush (edge to edge) inside the page's Clients card section.
 */
export function ClientOperations({ rows, totalCount }: { rows: ClientRow[]; totalCount: number }) {
  if (rows.length === 0) {
    return (
      <div className="px-4 pb-4 sm:px-5 sm:pb-5">
        {totalCount === 0 ? (
          <EmptyState
            icon={Building2}
            title="No client organizations are connected yet."
            description="Once a client organization is associated with the agency, it will appear here with its onboarding stage, health, pipeline and next action."
          />
        ) : (
          <EmptyState
            icon={Search}
            title="No clients match your search or filter."
            description={`Try a different client name or filter, or choose Clear filters above to see all ${formatCount(totalCount)} client${totalCount === 1 ? "" : "s"}.`}
          />
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-line">
      <div className="hidden lg:block">
        <div className={`grid ${ROW_GRID} items-end gap-3 border-b border-l-2 border-line border-l-transparent pb-2.5 pt-3 ${ROW_PADDING}`}>
          <TableHeadCell>Client</TableHeadCell>
          <TableHeadCell>Status</TableHeadCell>
          <TableHeadCell>Health</TableHeadCell>
          <TableHeadCell>Automation</TableHeadCell>
          <TableHeadCell align="right">Pipeline</TableHeadCell>
          {/* xl-only columns: TableHeadCell's own classes, plus the breakpoint visibility it has no prop for. */}
          <span className={`hidden text-right xl:block ${HEAD_CELL_CLASS}`}>Leads</span>
          <span className={`hidden text-right xl:block ${HEAD_CELL_CLASS}`}>Appts</span>
          <span className={`hidden text-right xl:block ${HEAD_CELL_CLASS}`}>Jobs</span>
          <span className={`whitespace-nowrap ${HEAD_CELL_CLASS}`}>Last activity</span>
          <TableHeadCell>Next action</TableHeadCell>
          <span />
        </div>
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <ClientRowDesktop key={row.organization.organizationId} row={row} />
          ))}
        </ul>
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

const ROW_LINK_CLASS = "transition-colors hover:bg-hover focus:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-accent/40";

function ClientRowDesktop({ row }: { row: ClientRow }) {
  const { organization, health, stage } = row;
  const note = readinessNote(row);
  const m = organization.metrics;

  return (
    <li>
      <Link
        href={`/agency/organizations/${organization.organizationId}`}
        className={`group grid min-h-12 ${ROW_GRID} items-center gap-3 border-l-2 py-2.5 ${ROW_PADDING} ${ROW_LINK_CLASS} ${RAIL_TONE_CLASS[railTone(row)]}`}
      >
        <TableCell className="font-medium">{organization.organizationName}</TableCell>
        <span className="min-w-0">
          <Badge tone={STAGE_TONE[stage]}>{ONBOARDING_STAGE_LABEL[stage]}</Badge>
          {note ? <span className="mt-0.5 block truncate text-[11px] text-ink-3">{note}</span> : null}
        </span>
        <span className="min-w-0">
          <HealthBadge health={health} />
        </span>
        <span className="min-w-0">
          <AutomationCell health={health} />
        </span>
        <TableCell align="right" className="font-medium">
          {pipelineSignal(organization)}
        </TableCell>
        <TableCell align="right" muted className="hidden xl:block">
          {formatCount(m.leadMetrics.totalLeads)}
        </TableCell>
        <TableCell align="right" muted className="hidden xl:block">
          {formatCount(m.appointmentMetrics.totalAppointments)}
        </TableCell>
        <TableCell align="right" muted className="hidden xl:block">
          {formatCount(m.jobMetrics.totalJobs)}
        </TableCell>
        <span className="min-w-0 truncate text-xs tabular-nums text-ink-3">{row.lastActivityAt ? formatRelativeTime(row.lastActivityAt) : "No activity yet"}</span>
        <span className="min-w-0 truncate text-xs text-ink-3">{row.nextAction ?? "—"}</span>
        <ChevronRight className="h-4 w-4 shrink-0 justify-self-end text-ink-4 transition-colors group-hover:text-ink-3" aria-hidden />
      </Link>
    </li>
  );
}

function ClientRowMobile({ row }: { row: ClientRow }) {
  const { organization, health, stage } = row;
  const note = readinessNote(row);
  const m = organization.metrics;
  const reasons = attentionReasons(health);

  return (
    <li>
      <Link
        href={`/agency/organizations/${organization.organizationId}`}
        className={`flex items-start gap-3 border-l-2 py-3.5 ${ROW_PADDING} ${ROW_LINK_CLASS} ${RAIL_TONE_CLASS[railTone(row)]}`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-ink">{organization.organizationName}</span>
            <Badge tone={STAGE_TONE[stage]}>{ONBOARDING_STAGE_LABEL[stage]}</Badge>
          </span>
          <span className="mt-1 flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-ink-3">
              {reasons.length > 0 ? <span className="font-medium text-danger-text">{reasons.join(", ")}</span> : <StatusLabel tone="healthy">Healthy</StatusLabel>}
              {note ? <span className="truncate">· {note}</span> : null}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-ink-3">{row.lastActivityAt ? formatRelativeTime(row.lastActivityAt) : "—"}</span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-ink-3">
            <AutomationCell health={health} />
            <span aria-hidden>·</span>
            <span>
              <span className="font-medium text-ink-2">{pipelineSignal(organization)}</span> pipeline
            </span>
          </span>
          <span className="mt-1 block text-xs tabular-nums text-ink-3">
            {formatCount(m.leadMetrics.totalLeads)} leads · {formatCount(m.appointmentMetrics.totalAppointments)} appts · {formatCount(m.jobMetrics.totalJobs)} jobs
            {row.escalationCount === null ? (
              <span className="text-ink-3"> · escalations unavailable</span>
            ) : row.escalationCount > 0 ? (
              <span className="font-medium text-warning-text">
                {" "}
                · {formatCount(row.escalationCount)} AI escalation{row.escalationCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </span>
          {row.nextAction ? <span className="mt-1 block truncate text-xs text-ink-2">{row.nextAction}</span> : null}
        </span>
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-ink-4" aria-hidden />
      </Link>
    </li>
  );
}
