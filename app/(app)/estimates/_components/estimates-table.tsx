import Link from "next/link";
import { Clock, ChevronRight } from "lucide-react";
import { formatCurrency } from "@/lib/dashboard/format";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { STATUS_LABELS } from "@/lib/estimates/format";
import type { Estimate } from "@/lib/estimates/queries";
import { Badge } from "@/lib/ui/badge";
import { ESTIMATE_STATUS_TONE, ESTIMATE_STATUS_ICON } from "./status";

const ROW_GRID = "grid-cols-[minmax(0,1fr)_112px_96px_92px_20px]";

function isExpiringSoon(estimate: Estimate): boolean {
  if (estimate.status !== "sent" || !estimate.expires_at) return false;
  const daysLeft = (new Date(estimate.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return daysLeft >= 0 && daysLeft <= 3;
}

export function EstimatesTable({ estimates, hasActiveFilters }: { estimates: Estimate[]; hasActiveFilters: boolean }) {
  if (estimates.length === 0) {
    return (
      <div className="px-2 py-14 text-center">
        <p className="text-sm font-medium text-slate-900">No estimates match your search.</p>
        <p className="mt-1 text-sm text-slate-500">
          {hasActiveFilters ? "Try a different search term or clear your filters." : "Try a different search term."}
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Desktop: aligned row list, not an HTML table - same convention as
          LeadsTable, sharing column positions across header and rows via a
          grid template. */}
      <div className="hidden lg:block">
        <div className={`grid ${ROW_GRID} gap-6 border-b border-slate-200 px-2 pb-3`}>
          <span className="text-xs text-slate-400">Estimate</span>
          <span className="text-xs text-slate-400">Status</span>
          <span className="text-right text-xs text-slate-400">Amount</span>
          <span className="text-xs text-slate-400">Created</span>
          <span />
        </div>
        <div className="divide-y divide-slate-100">
          {estimates.map((estimate) => (
            <Link
              key={estimate.id}
              href={`/estimates/${estimate.id}`}
              className={`group grid ${ROW_GRID} items-center gap-6 rounded-md px-2 py-3.5 transition-colors hover:bg-slate-50`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                  {estimate.contact ? contactInitials(estimate.contact) : "?"}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-900">{estimate.title}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {estimate.contact ? contactDisplayName(estimate.contact) : "No contact"}
                    {estimate.contact?.company_name ? ` · ${estimate.contact.company_name}` : ""}
                  </span>
                </span>
              </span>
              <span className="flex items-center gap-1.5">
                <Badge tone={ESTIMATE_STATUS_TONE[estimate.status]} icon={ESTIMATE_STATUS_ICON[estimate.status]}>
                  {STATUS_LABELS[estimate.status]}
                </Badge>
                {isExpiringSoon(estimate) ? (
                  <Clock aria-label="Expiring soon" className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                ) : null}
              </span>
              <span className="text-right text-sm font-medium tabular-nums text-slate-700">
                {estimate.amount != null ? formatCurrency(estimate.amount) : "—"}
              </span>
              <span className="text-xs tabular-nums text-slate-400">{formatContactDate(estimate.created_at)}</span>
              <ChevronRight
                aria-hidden
                className="h-4 w-4 shrink-0 justify-self-end text-slate-300 transition-colors group-hover:text-slate-500"
              />
            </Link>
          ))}
        </div>
      </div>

      {/* Mobile: a compact two-line stacked row, matching LeadsTable's
          mobile convention. */}
      <ul className="divide-y divide-slate-100 lg:hidden">
        {estimates.map((estimate) => (
          <li key={estimate.id}>
            <Link href={`/estimates/${estimate.id}`} className="flex items-start gap-3 px-2 py-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                {estimate.contact ? contactInitials(estimate.contact) : "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-slate-900">{estimate.title}</span>
                  <Badge tone={ESTIMATE_STATUS_TONE[estimate.status]} icon={ESTIMATE_STATUS_ICON[estimate.status]}>
                    {STATUS_LABELS[estimate.status]}
                  </Badge>
                </span>
                <span className="mt-0.5 flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-slate-500">
                    {estimate.contact ? contactDisplayName(estimate.contact) : "No contact"}
                  </span>
                  {estimate.amount != null ? (
                    <span className="shrink-0 text-xs font-medium tabular-nums text-slate-600">
                      {formatCurrency(estimate.amount)}
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
