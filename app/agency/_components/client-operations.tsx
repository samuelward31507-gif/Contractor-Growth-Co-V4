import Link from "next/link";
import { ChevronRight, Search } from "lucide-react";
import { Badge, RAIL_TONE_CLASS, type BadgeTone } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { formatRelativeTime } from "@/lib/dashboard/format";
import { ONBOARDING_STAGE_LABEL, type OnboardingStage } from "@/lib/onboarding/checklist";
import type { AgencyOrganizationSnapshot } from "@/lib/agency/queries";
import type { AgencyOrganizationHealth } from "@/lib/agency/health";
import { formatCount } from "./format";

const STAGE_TONE: Record<OnboardingStage, BadgeTone> = {
  new: "neutral",
  configuring: "warning",
  testing: "info",
  ready: "info",
  live: "success",
};

// Two column counts, not one grid hidden down to fewer visible cells: a
// fixed 9-track template with cells merely hidden below `xl` still
// reserves those tracks' width, leaving dead gaps and misaligning the
// remaining columns at 1024-1279px. The container's own template changes
// column count at the breakpoint instead, matching how many cells are
// actually rendered at each size.
const ROW_GRID = "grid-cols-[minmax(0,1fr)_92px_92px_112px_20px] xl:grid-cols-[minmax(0,1.3fr)_92px_92px_52px_52px_52px_52px_112px_20px]";

export type ClientRow = {
  organization: AgencyOrganizationSnapshot;
  health: AgencyOrganizationHealth | undefined;
  stage: OnboardingStage;
  incompleteCount: number;
  lastActivityAt: string | null;
  escalationCount: number;
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
        <div className={`grid ${ROW_GRID} items-center gap-3 border-b border-l-2 border-l-transparent border-slate-200 pl-3 pr-2 pb-3`}>
          <span className="text-xs text-slate-400">Client</span>
          <span className="text-xs text-slate-400">Status</span>
          <span className="text-xs text-slate-400">Health</span>
          <span className="hidden text-right text-xs text-slate-400 xl:block">Leads</span>
          <span className="hidden text-right text-xs text-slate-400 xl:block">Appts</span>
          <span className="hidden text-right text-xs text-slate-400 xl:block">Jobs</span>
          <span className="hidden text-right text-xs text-slate-400 xl:block">AI</span>
          <span className="text-xs text-slate-400 whitespace-nowrap">Last activity</span>
          <span />
        </div>
        <div className="divide-y divide-slate-100">
          {rows.map((row) => (
            <ClientRowDesktop key={row.organization.organizationId} row={row} />
          ))}
        </div>
      </div>

      <ul className="divide-y divide-slate-100 lg:hidden">
        {rows.map((row) => (
          <ClientRowMobile key={row.organization.organizationId} row={row} />
        ))}
      </ul>
    </div>
  );
}

function railTone(row: ClientRow): BadgeTone {
  if (row.health?.needsAttention) return "danger";
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
      className={`group grid ${ROW_GRID} items-center gap-3 rounded-r-md border-l-2 py-3.5 pl-3 pr-2 transition-colors hover:bg-slate-50 ${RAIL_TONE_CLASS[railTone(row)]}`}
    >
      <span className="min-w-0 truncate text-sm font-medium text-slate-900">{organization.organizationName}</span>
      <span>
        <Badge tone={STAGE_TONE[stage]}>{ONBOARDING_STAGE_LABEL[stage]}</Badge>
        {note ? <span className="ml-1.5 text-xs text-slate-400">{note}</span> : null}
      </span>
      <span>
        {health?.needsAttention ? (
          <Badge tone="danger">Needs attention</Badge>
        ) : (
          <span className="text-sm text-slate-500">Healthy</span>
        )}
      </span>
      <span className="hidden text-right text-xs tabular-nums text-slate-500 xl:block">{formatCount(m.leadMetrics.totalLeads)}</span>
      <span className="hidden text-right text-xs tabular-nums text-slate-500 xl:block">{formatCount(m.appointmentMetrics.totalAppointments)}</span>
      <span className="hidden text-right text-xs tabular-nums text-slate-500 xl:block">{formatCount(m.jobMetrics.totalJobs)}</span>
      <span className="hidden text-right text-xs tabular-nums xl:block">
        {row.escalationCount > 0 ? (
          <span className="font-medium text-amber-600">{formatCount(row.escalationCount)}</span>
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </span>
      <span className="text-xs tabular-nums text-slate-400">
        {row.lastActivityAt ? formatRelativeTime(row.lastActivityAt) : "No activity yet"}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 justify-self-end text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden />
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
            <span className="truncate text-sm font-medium text-slate-900">{organization.organizationName}</span>
            <Badge tone={STAGE_TONE[stage]}>{ONBOARDING_STAGE_LABEL[stage]}</Badge>
          </span>
          <span className="mt-0.5 flex items-center justify-between gap-2">
            <span className="truncate text-xs text-slate-500">
              {health?.needsAttention ? <span className="font-medium text-red-600">Needs attention</span> : "Healthy"}
              {note ? ` · ${note}` : ""}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-slate-400">
              {row.lastActivityAt ? formatRelativeTime(row.lastActivityAt) : "—"}
            </span>
          </span>
          <span className="mt-1 block text-xs tabular-nums text-slate-400">
            {formatCount(m.leadMetrics.totalLeads)} leads · {formatCount(m.appointmentMetrics.totalAppointments)} appts · {formatCount(m.jobMetrics.totalJobs)} jobs
            {row.escalationCount > 0 ? <span className="font-medium text-amber-600"> · {formatCount(row.escalationCount)} AI escalation{row.escalationCount === 1 ? "" : "s"}</span> : null}
          </span>
        </span>
      </Link>
    </li>
  );
}
