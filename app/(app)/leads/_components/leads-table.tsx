import Link from "next/link";
import { ChevronRight, Flame, Search } from "lucide-react";
import { Badge, RAIL_TONE_CLASS } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { formatCurrency } from "@/lib/dashboard/format";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { STATUS_LABELS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import type { Lead } from "@/lib/leads/queries";
import { LEAD_STATUS_TONE, LEAD_TEMPERATURE_TONE } from "./lead-status";

const ROW_GRID = "grid-cols-[minmax(0,1fr)_112px_96px_92px_84px_20px]";

function secondaryLine(lead: Lead): string {
  const service = lead.service || "General inquiry";
  return lead.source ? `${service} · via ${lead.source}` : service;
}

export function LeadsTable({ leads, hasActiveFilters }: { leads: Lead[]; hasActiveFilters: boolean }) {
  if (leads.length === 0) {
    return (
      <EmptyState
        icon={Search}
        title="No leads match your search."
        description={
          hasActiveFilters
            ? "Try a different search term or clear your filters to see every lead."
            : "Try a different search term."
        }
      />
    );
  }

  return (
    <div>
      {/* Desktop: aligned row list, not an HTML table - same column positions
          as the data rows below, via a shared grid template. */}
      <div className="hidden lg:block">
        <div className={`grid ${ROW_GRID} gap-6 border-b border-l-2 border-l-transparent border-slate-200 pl-3 pr-2 pb-3`}>
          <span className="text-xs text-slate-400">Lead</span>
          <span className="text-xs text-slate-400">Status</span>
          <span className="text-xs text-slate-400">Temperature</span>
          <span className="text-right text-xs text-slate-400">Value</span>
          <span className="text-xs text-slate-400">Created</span>
          <span />
        </div>
        <div className="divide-y divide-slate-100">
          {leads.map((lead) => (
            <Link
              key={lead.id}
              href={`/leads/${lead.id}`}
              className={`group grid ${ROW_GRID} items-center gap-6 rounded-r-md border-l-2 py-3.5 pl-3 pr-2 transition-colors hover:bg-slate-50 ${RAIL_TONE_CLASS[LEAD_STATUS_TONE[lead.status]]}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                  {lead.contact ? contactInitials(lead.contact) : "?"}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {lead.contact ? contactDisplayName(lead.contact) : "No contact"}
                    {lead.contact?.company_name ? (
                      <span className="font-normal text-slate-500"> · {lead.contact.company_name}</span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-slate-500">{secondaryLine(lead)}</span>
                </span>
              </span>
              <Badge tone={LEAD_STATUS_TONE[lead.status]}>{STATUS_LABELS[lead.status]}</Badge>
              <Badge tone={LEAD_TEMPERATURE_TONE[lead.temperature]} icon={lead.temperature === "hot" ? Flame : undefined}>
                {TEMPERATURE_LABELS[lead.temperature]}
              </Badge>
              <span className="text-right text-sm font-medium tabular-nums text-slate-700">
                {lead.estimated_value != null ? formatCurrency(lead.estimated_value) : "—"}
              </span>
              <span className="text-xs tabular-nums text-slate-400">{formatContactDate(lead.created_at)}</span>
              <ChevronRight
                className="h-4 w-4 shrink-0 justify-self-end text-slate-300 transition-colors group-hover:text-slate-500"
                aria-hidden
              />
            </Link>
          ))}
        </div>
      </div>

      {/* Mobile: a compact two-line stacked row, not the desktop table
          squeezed down, and not a boxed card - flush dividers only.
          Temperature recedes to a small flame cue on hot leads only, to keep
          each row to two lines on a narrow screen. */}
      <ul className="divide-y divide-slate-100 lg:hidden">
        {leads.map((lead) => (
          <li key={lead.id}>
            <Link
              href={`/leads/${lead.id}`}
              className={`flex items-start gap-3 border-l-2 py-3.5 pl-3 pr-2 ${RAIL_TONE_CLASS[LEAD_STATUS_TONE[lead.status]]}`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                {lead.contact ? contactInitials(lead.contact) : "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-slate-900">
                    <span className="truncate">{lead.contact ? contactDisplayName(lead.contact) : "No contact"}</span>
                    {lead.temperature === "hot" ? <Flame className="h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden /> : null}
                  </span>
                  <Badge tone={LEAD_STATUS_TONE[lead.status]}>{STATUS_LABELS[lead.status]}</Badge>
                </span>
                <span className="mt-0.5 flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-slate-500">{secondaryLine(lead)}</span>
                  {lead.estimated_value != null ? (
                    <span className="shrink-0 text-xs font-medium tabular-nums text-slate-600">
                      {formatCurrency(lead.estimated_value)}
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
