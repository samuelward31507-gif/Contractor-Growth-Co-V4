import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatCurrency } from "@/lib/dashboard/format";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { STATUS_LABELS } from "@/lib/jobs/format";
import type { Job } from "@/lib/jobs/queries";
import { Badge, RAIL_TONE_CLASS } from "@/lib/ui/badge";
import { JOB_STATUS_TONE, JOB_STATUS_ICON } from "./status";

const ROW_GRID = "grid-cols-[minmax(0,1fr)_112px_96px_92px_20px]";

export function JobsTable({ jobs, hasActiveFilters }: { jobs: Job[]; hasActiveFilters: boolean }) {
  if (jobs.length === 0) {
    return (
      <div className="px-2 py-14 text-center">
        <p className="text-sm font-medium text-slate-900">No jobs match your search.</p>
        <p className="mt-1 text-sm text-slate-500">
          {hasActiveFilters ? "Try a different search term or clear your filters." : "Try a different search term."}
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Desktop: aligned row list, not an HTML table - same convention as
          EstimatesTable/LeadsTable, sharing column positions across header
          and rows via a grid template. */}
      <div className="hidden lg:block">
        <div className={`grid ${ROW_GRID} gap-6 border-b border-l-2 border-l-transparent border-slate-200 pl-3 pr-2 pb-3`}>
          <span className="text-xs text-slate-400">Job</span>
          <span className="text-xs text-slate-400">Status</span>
          <span className="text-right text-xs text-slate-400">Amount</span>
          <span className="text-xs text-slate-400">Created</span>
          <span />
        </div>
        <div className="divide-y divide-slate-100">
          {jobs.map((job) => (
            <Link
              key={job.id}
              href={`/jobs/${job.id}`}
              className={`group grid ${ROW_GRID} items-center gap-6 rounded-r-md border-l-2 py-3.5 pl-3 pr-2 transition-colors hover:bg-slate-50 ${RAIL_TONE_CLASS[JOB_STATUS_TONE[job.status]]}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                  {job.contact ? contactInitials(job.contact) : "?"}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-900">{job.title}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {job.contact ? contactDisplayName(job.contact) : "No contact"}
                    {job.contact?.company_name ? ` · ${job.contact.company_name}` : ""}
                  </span>
                </span>
              </span>
              <Badge tone={JOB_STATUS_TONE[job.status]} icon={JOB_STATUS_ICON[job.status]}>
                {STATUS_LABELS[job.status]}
              </Badge>
              <span className="text-right text-sm font-medium tabular-nums text-slate-700">
                {job.amount != null ? formatCurrency(job.amount) : "—"}
              </span>
              <span className="text-xs tabular-nums text-slate-400">{formatContactDate(job.created_at)}</span>
              <ChevronRight
                aria-hidden
                className="h-4 w-4 shrink-0 justify-self-end text-slate-300 transition-colors group-hover:text-slate-500"
              />
            </Link>
          ))}
        </div>
      </div>

      {/* Mobile: a compact two-line stacked row, matching EstimatesTable's
          mobile convention. */}
      <ul className="divide-y divide-slate-100 lg:hidden">
        {jobs.map((job) => (
          <li key={job.id}>
            <Link
              href={`/jobs/${job.id}`}
              className={`flex items-start gap-3 border-l-2 py-3.5 pl-3 pr-2 ${RAIL_TONE_CLASS[JOB_STATUS_TONE[job.status]]}`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                {job.contact ? contactInitials(job.contact) : "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-slate-900">{job.title}</span>
                  <Badge tone={JOB_STATUS_TONE[job.status]} icon={JOB_STATUS_ICON[job.status]}>
                    {STATUS_LABELS[job.status]}
                  </Badge>
                </span>
                <span className="mt-0.5 flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-slate-500">
                    {job.contact ? contactDisplayName(job.contact) : "No contact"}
                  </span>
                  {job.amount != null ? (
                    <span className="shrink-0 text-xs font-medium tabular-nums text-slate-600">
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
