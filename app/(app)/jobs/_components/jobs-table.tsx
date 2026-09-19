import Link from "next/link";
import { formatCurrency } from "@/lib/dashboard/format";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import type { Job } from "@/lib/jobs/queries";
import { JobStatusBadge } from "./status-badge";

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
        <div className={`grid ${ROW_GRID} gap-4 border-b border-slate-200 px-2 pb-2`}>
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
              className={`group grid ${ROW_GRID} items-center gap-4 rounded-md px-2 py-3 transition-colors hover:bg-slate-50`}
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
              <JobStatusBadge status={job.status} />
              <span className="text-right text-sm font-medium tabular-nums text-slate-700">
                {job.amount != null ? formatCurrency(job.amount) : "—"}
              </span>
              <span className="text-xs tabular-nums text-slate-400">{formatContactDate(job.created_at)}</span>
              {/* "chevron-right" isn't in the committed Icon set yet (it's
                  a Trackpr 2.0 redesign addition, intentionally
                  uncommitted this phase) - inlined directly rather than
                  depending on that in-flight change. */}
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="h-4 w-4 shrink-0 justify-self-end text-slate-300 transition-colors group-hover:text-slate-500"
              >
                <path d="M9 5.25L15 12l-6 6.75" />
              </svg>
            </Link>
          ))}
        </div>
      </div>

      {/* Mobile: a compact two-line stacked row, matching EstimatesTable's
          mobile convention. */}
      <ul className="divide-y divide-slate-100 lg:hidden">
        {jobs.map((job) => (
          <li key={job.id}>
            <Link href={`/jobs/${job.id}`} className="flex items-start gap-3 px-2 py-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                {job.contact ? contactInitials(job.contact) : "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-slate-900">{job.title}</span>
                  <JobStatusBadge status={job.status} />
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
