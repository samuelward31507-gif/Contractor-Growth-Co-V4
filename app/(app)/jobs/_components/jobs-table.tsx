import Link from "next/link";
import { ChevronRight, SearchX } from "lucide-react";
import { formatCurrency } from "@/lib/dashboard/format";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { STATUS_LABELS } from "@/lib/jobs/format";
import type { Job } from "@/lib/jobs/queries";
import { Badge, RAIL_TONE_CLASS } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { JOB_STATUS_TONE, JOB_STATUS_ICON } from "./status";

const ROW_GRID = "grid-cols-[minmax(0,1fr)_112px_96px_92px_20px]";

export function JobsTable({ jobs, hasActiveFilters }: { jobs: Job[]; hasActiveFilters: boolean }) {
  if (jobs.length === 0) {
    return (
      <div className="px-2">
        <EmptyState
          icon={SearchX}
          title="No jobs match your search."
          description={hasActiveFilters ? "Try a different search term or clear your filters." : "Try a different search term."}
        />
      </div>
    );
  }

  return (
    <div>
      {/* Desktop: aligned row list, not an HTML table - same convention as
          EstimatesTable/LeadsTable, sharing column positions across header
          and rows via a grid template. */}
      <div className="hidden lg:block">
        <div className={`grid ${ROW_GRID} gap-6 border-b border-l-2 border-l-transparent border-line pl-3 pr-4 pb-2.5`}>
          <span className="text-xs font-medium text-ink-3">Job</span>
          <span className="text-xs font-medium text-ink-3">Status</span>
          <span className="text-right text-xs font-medium text-ink-3">Amount</span>
          <span className="text-xs font-medium text-ink-3">Created</span>
          <span />
        </div>
        <div className="divide-y divide-line">
          {jobs.map((job) => (
            <Link
              key={job.id}
              href={`/jobs/${job.id}`}
              className={`group grid ${ROW_GRID} min-h-14 items-center gap-6 rounded-r-md border-l-2 py-2.5 pl-3 pr-4 transition-colors hover:bg-hover focus:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-accent/40 ${RAIL_TONE_CLASS[JOB_STATUS_TONE[job.status]]}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-inset text-xs font-medium text-ink-2">
                  {job.contact ? contactInitials(job.contact) : "?"}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{job.title}</span>
                  <span className="block truncate text-xs text-ink-3">
                    {job.contact ? contactDisplayName(job.contact) : "No contact"}
                    {job.contact?.company_name ? ` · ${job.contact.company_name}` : ""}
                  </span>
                </span>
              </span>
              <Badge tone={JOB_STATUS_TONE[job.status]} icon={JOB_STATUS_ICON[job.status]}>
                {STATUS_LABELS[job.status]}
              </Badge>
              <span className="text-right text-sm font-medium tabular-nums text-ink-2">
                {job.amount != null ? formatCurrency(job.amount) : "—"}
              </span>
              <span className="text-xs tabular-nums text-ink-3">{formatContactDate(job.created_at)}</span>
              <ChevronRight
                aria-hidden
                className="h-4 w-4 shrink-0 justify-self-end text-ink-4 transition-colors group-hover:text-ink-3"
              />
            </Link>
          ))}
        </div>
      </div>

      {/* Mobile: a compact two-line stacked row, matching EstimatesTable's
          mobile convention. */}
      <ul className="divide-y divide-line lg:hidden">
        {jobs.map((job) => (
          <li key={job.id}>
            <Link
              href={`/jobs/${job.id}`}
              className={`flex items-start gap-3 border-l-2 py-3.5 pl-3 pr-2 transition-colors focus:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-accent/40 ${RAIL_TONE_CLASS[JOB_STATUS_TONE[job.status]]}`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-inset text-xs font-medium text-ink-2">
                {job.contact ? contactInitials(job.contact) : "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">{job.title}</span>
                  <Badge tone={JOB_STATUS_TONE[job.status]} icon={JOB_STATUS_ICON[job.status]}>
                    {STATUS_LABELS[job.status]}
                  </Badge>
                </span>
                <span className="mt-0.5 flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-ink-3">
                    {job.contact ? contactDisplayName(job.contact) : "No contact"}
                  </span>
                  {job.amount != null ? (
                    <span className="shrink-0 text-xs font-medium tabular-nums text-ink-2">
                      {formatCurrency(job.amount)}
                    </span>
                  ) : null}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
